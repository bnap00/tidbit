// Persistence for skills, owner-defined actions and repeating reminders (routines).
import {
  ACTIONS_MAX,
  SKILLS_MAX,
  type ActionInfo,
  type ActionInput,
  type Repeat,
  type SkillInfo,
  type SkillInput,
  type SkillSource,
} from "@tidbit/protocol";
import type { Store } from "./store.js";
import { STARTER_SKILLS } from "./starter-skills.js";

/** Starter skills that existed before seeding tracked names. */
const LEGACY_STARTERS = ["morning-briefing", "focus-buddy", "look-it-up"];

/** An action as the brain runs it, secrets included. Never sent to a client. */
export interface StoredAction extends ActionInfo {
  headers: [string, string][];
}

type SkillRow = {
  id: number;
  name: string;
  description: string;
  body: string;
  enabled: number;
  source: SkillSource;
  uses: number;
  updatedAt: number;
};
type ActionRow = {
  id: number;
  name: string;
  description: string;
  method: "GET" | "POST";
  url: string;
  headers: string;
  bodyTemplate: string;
  enabled: number;
  uses: number;
};

const toSkill = (r: SkillRow): SkillInfo => ({ ...r, enabled: !!r.enabled });

/** Parse "Name: value" lines; invalid lines are dropped. */
export function parseHeaders(text = ""): [string, string][] {
  return text
    .split("\n")
    .map((line) => /^\s*([A-Za-z0-9-]{1,64})\s*:\s*(.+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!]);
}

function toAction(r: ActionRow): StoredAction {
  const headers = parseHeaders(r.headers);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    method: r.method,
    url: r.url,
    headers,
    headerNames: headers.map(([k]) => k),
    bodyTemplate: r.bodyTemplate,
    enabled: !!r.enabled,
    uses: r.uses,
  };
}

/** The next time a repeating reminder is due strictly after `after`, in local time. */
export function nextDue(dueAt: number, repeat: Repeat, after: number): number | undefined {
  if (repeat === "none") return undefined;
  const d = new Date(dueAt);
  const step = () => {
    if (repeat === "hourly") d.setHours(d.getHours() + 1);
    else if (repeat === "weekly") d.setDate(d.getDate() + 7);
    else {
      d.setDate(d.getDate() + 1);
      if (repeat === "weekdays")
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    }
  };
  step();
  // Skip missed occurrences instead of delivering a backlog; bounded for safety.
  for (let i = 0; d.getTime() <= after && i < 100_000; i++) step();
  return d.getTime();
}

export class AbilitiesStore {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pal_id TEXT NOT NULL REFERENCES pals(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(pal_id, name)
      );
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pal_id TEXT NOT NULL REFERENCES pals(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        headers TEXT NOT NULL DEFAULT '',
        body_template TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(pal_id, name)
      );
    `);
    const columns = store.db.prepare("PRAGMA table_info(reminders)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "repeat"))
      store.db.exec("ALTER TABLE reminders ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none'");
  }

  // --- skills ---------------------------------------------------------------------

  /** Every skill of a pal. Starter skills are added the first time any skill is looked up. */
  skills(palId: string, now = Date.now()): SkillInfo[] {
    this.seed(palId, now);
    return (
      this.store.db
        .prepare(
          "SELECT id, name, description, body, enabled, source, uses, updated_at AS updatedAt FROM skills WHERE pal_id = ? ORDER BY name",
        )
        .all(palId) as SkillRow[]
    ).map(toSkill);
  }

  /**
   * Give a pal every starter skill it has never been offered. Each is offered once, so
   * a deleted starter stays deleted, and new starters reach existing pals.
   */
  private seed(palId: string, now = Date.now()): void {
    const key = `skills_seeded:${palId}`;
    const raw = this.store.getMeta(key);
    // "1" marks pals seeded before starters were tracked by name.
    const offered = new Set(raw === "1" ? LEGACY_STARTERS : raw ? raw.split(",") : []);
    const missing = STARTER_SKILLS.filter((s) => !offered.has(s.name));
    if (!missing.length) return;
    this.store.setMeta(key, [...offered, ...missing.map((s) => s.name)].join(","));
    for (const s of missing) {
      if (this.skill(palId, s.name)) continue;
      try {
        this.saveSkill(palId, s, "starter", now);
      } catch {
        // A pal already at the skill limit simply doesn't get it.
      }
    }
  }

  skill(palId: string, name: string): SkillInfo | undefined {
    this.seed(palId);
    const row = this.store.db
      .prepare(
        "SELECT id, name, description, body, enabled, source, uses, updated_at AS updatedAt FROM skills WHERE pal_id = ? AND name = ?",
      )
      .get(palId, name) as SkillRow | undefined;
    return row && toSkill(row);
  }

  /** Create or replace a skill by name. The name must already be a slug. */
  saveSkill(palId: string, input: SkillInput, source: SkillSource, now = Date.now()): SkillInfo {
    const existing = this.skill(palId, input.name);
    if (!existing) {
      const count = (
        this.store.db.prepare("SELECT COUNT(*) AS n FROM skills WHERE pal_id = ?").get(palId) as {
          n: number;
        }
      ).n;
      if (count >= SKILLS_MAX) throw new Error(`a pal can hold at most ${SKILLS_MAX} skills`);
    }
    this.store.db
      .prepare(
        `INSERT INTO skills (pal_id, name, description, body, enabled, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pal_id, name) DO UPDATE SET description = excluded.description, body = excluded.body,
           enabled = excluded.enabled, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(
        palId,
        input.name,
        input.description,
        input.body,
        (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
        source,
        now,
        now,
      );
    return this.skill(palId, input.name)!;
  }

  setSkillEnabled(palId: string, id: number, enabled: boolean): boolean {
    return (
      this.store.db
        .prepare("UPDATE skills SET enabled = ? WHERE pal_id = ? AND id = ?")
        .run(enabled ? 1 : 0, palId, id).changes > 0
    );
  }

  deleteSkill(palId: string, id: number): boolean {
    return (
      this.store.db.prepare("DELETE FROM skills WHERE pal_id = ? AND id = ?").run(palId, id)
        .changes > 0
    );
  }

  countSkillUse(palId: string, name: string): void {
    this.store.db
      .prepare("UPDATE skills SET uses = uses + 1 WHERE pal_id = ? AND name = ?")
      .run(palId, name);
  }

  // --- actions ----------------------------------------------------------------------

  actions(palId: string): StoredAction[] {
    return (
      this.store.db
        .prepare(
          "SELECT id, name, description, method, url, headers, body_template AS bodyTemplate, enabled, uses FROM actions WHERE pal_id = ? ORDER BY name",
        )
        .all(palId) as ActionRow[]
    ).map(toAction);
  }

  action(palId: string, name: string): StoredAction | undefined {
    return this.actions(palId).find((a) => a.name === name);
  }

  /**
   * Create or replace an action by name. Omitted headers keep the stored ones, so a
   * browser that never saw the secret can still edit the rest.
   */
  saveAction(palId: string, input: ActionInput & { name: string }, now = Date.now()): void {
    const existing = this.action(palId, input.name);
    if (!existing && this.actions(palId).length >= ACTIONS_MAX)
      throw new Error(`a pal can hold at most ${ACTIONS_MAX} actions`);
    const headers =
      input.headers === undefined
        ? (existing?.headers.map(([k, v]) => `${k}: ${v}`).join("\n") ?? "")
        : input.headers;
    this.store.db
      .prepare(
        `INSERT INTO actions (pal_id, name, description, method, url, headers, body_template, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pal_id, name) DO UPDATE SET description = excluded.description, method = excluded.method,
           url = excluded.url, headers = excluded.headers, body_template = excluded.body_template, enabled = excluded.enabled`,
      )
      .run(
        palId,
        input.name,
        input.description,
        input.method,
        input.url,
        headers,
        input.bodyTemplate ?? "",
        (input.enabled ?? true) ? 1 : 0,
        now,
      );
  }

  setActionEnabled(palId: string, id: number, enabled: boolean): boolean {
    return (
      this.store.db
        .prepare("UPDATE actions SET enabled = ? WHERE pal_id = ? AND id = ?")
        .run(enabled ? 1 : 0, palId, id).changes > 0
    );
  }

  deleteAction(palId: string, id: number): boolean {
    return (
      this.store.db.prepare("DELETE FROM actions WHERE pal_id = ? AND id = ?").run(palId, id)
        .changes > 0
    );
  }

  countActionUse(palId: string, id: number): void {
    this.store.db
      .prepare("UPDATE actions SET uses = uses + 1 WHERE pal_id = ? AND id = ?")
      .run(palId, id);
  }

  // --- repeating reminders --------------------------------------------------------------

  setRepeat(reminderId: number, repeat: Repeat): void {
    this.store.db.prepare("UPDATE reminders SET repeat = ? WHERE id = ?").run(repeat, reminderId);
  }

  repeatOf(reminderId: number): Repeat {
    return (
      (
        this.store.db.prepare("SELECT repeat FROM reminders WHERE id = ?").get(reminderId) as
          { repeat: Repeat } | undefined
      )?.repeat ?? "none"
    );
  }

  /**
   * Deliver a reminder: a repeating one moves to its next occurrence, a one-off is
   * marked fired. Returns the next due time, if any.
   */
  fire(reminderId: number, now: number): number | undefined {
    const row = this.store.db
      .prepare("SELECT due_at AS dueAt, repeat FROM reminders WHERE id = ?")
      .get(reminderId) as { dueAt: number; repeat: Repeat } | undefined;
    const next = row && nextDue(row.dueAt, row.repeat, now);
    if (next === undefined) this.store.markReminderFired(reminderId, now);
    else
      this.store.db.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").run(next, reminderId);
    return next;
  }
}
