// SQLite persistence via node:sqlite (PLAN 5.5). Memories and reminders arrive in M4.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_NEEDS,
  normalizeDna,
  normalizeNeeds,
  type DNA,
  type Needs,
} from "@tidbit/protocol";

export interface SessionRow {
  id: number;
  palId: string;
  turns: number;
}

export interface Memory {
  id: number;
  fact: string;
  tags: string[];
  createdAt: number;
}

export interface Reminder {
  id: number;
  dueAt: number;
  text: string;
}

function toMemory(row: unknown): Memory {
  const r = row as { id: number; fact: string; tags: string; createdAt: number };
  return { id: r.id, fact: r.fact, tags: r.tags ? r.tags.split(" ") : [], createdAt: r.createdAt };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pals (
        id TEXT PRIMARY KEY,
        dna TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pal_id TEXT NOT NULL REFERENCES pals(id),
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        turns INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pal_id TEXT NOT NULL REFERENCES pals(id),
        fact TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact, tags, content='memories', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, fact, tags) VALUES (new.id, new.fact, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, tags) VALUES ('delete', old.id, old.fact, old.tags);
      END;
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pal_id TEXT NOT NULL REFERENCES pals(id),
        due_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        fired_at INTEGER,
        cancelled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(pal_id, due_at) WHERE fired_at IS NULL AND cancelled = 0;
      CREATE TABLE IF NOT EXISTS needs (
        pal_id TEXT PRIMARY KEY REFERENCES pals(id),
        energy REAL NOT NULL,
        hunger REAL NOT NULL,
        bond REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // --- pals -------------------------------------------------------------------

  savePal(dna: DNA, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO pals (id, dna, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET dna = excluded.dna",
      )
      .run(dna.id, JSON.stringify(dna), now);
  }

  getPal(id: string): DNA | undefined {
    const row = this.db.prepare("SELECT dna FROM pals WHERE id = ?").get(id) as
      { dna: string } | undefined;
    return row ? normalizeDna(JSON.parse(row.dna)) : undefined;
  }

  setActivePal(id: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('active_pal', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(id);
  }

  activePal(): DNA | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'active_pal'").get() as
      { value: string } | undefined;
    return row ? this.getPal(row.value) : undefined;
  }

  // --- sessions (append-only message logs) -------------------------------------

  openSession(palId: string, now = Date.now(), conversationId?: string): SessionRow {
    const row = this.db
      .prepare(
        conversationId
          ? "SELECT id, pal_id AS palId, turns FROM sessions WHERE pal_id = ? AND conversation_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1"
          : "SELECT id, pal_id AS palId, turns FROM sessions WHERE pal_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(...(conversationId ? [palId, conversationId] : [palId])) as SessionRow | undefined;
    if (row) return row;
    const res = conversationId
      ? this.db
          .prepare("INSERT INTO sessions (pal_id, created_at, conversation_id) VALUES (?, ?, ?)")
          .run(palId, now, conversationId)
      : this.db.prepare("INSERT INTO sessions (pal_id, created_at) VALUES (?, ?)").run(palId, now);
    return { id: Number(res.lastInsertRowid), palId, turns: 0 };
  }

  sessionInfo(id: number): { turns: number; createdAt: number; closed: boolean } | undefined {
    const row = this.db
      .prepare(
        "SELECT turns, created_at AS createdAt, closed_at AS closedAt FROM sessions WHERE id = ?",
      )
      .get(id) as { turns: number; createdAt: number; closedAt: number | null } | undefined;
    return row && { turns: row.turns, createdAt: row.createdAt, closed: row.closedAt !== null };
  }

  /** Every open model context of a pal (one per conversation). */
  openSessionIds(palId: string): number[] {
    return (
      this.db
        .prepare("SELECT id FROM sessions WHERE pal_id = ? AND closed_at IS NULL")
        .all(palId) as { id: number }[]
    ).map((r) => r.id);
  }

  closeSession(id: number, now = Date.now()): void {
    this.db.prepare("UPDATE sessions SET closed_at = ? WHERE id = ?").run(now, id);
  }

  loadMessages(sessionId: number): unknown[] {
    const rows = this.db
      .prepare("SELECT json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as unknown);
  }

  /**
   * Persist a session's messages. Sessions are append-only (PLAN 5.5): the
   * stored prefix must be unchanged, and only new messages are inserted.
   */
  appendMessages(sessionId: number, all: readonly unknown[]): void {
    const count = (
      this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId) as {
        n: number;
      }
    ).n;
    if (all.length < count)
      throw new Error(`session ${sessionId} would shrink from ${count} to ${all.length} messages`);
    const insert = this.db.prepare("INSERT INTO messages (session_id, seq, json) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (let i = count; i < all.length; i++) insert.run(sessionId, i, JSON.stringify(all[i]));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  totalTurns(palId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(turns), 0) AS n FROM sessions WHERE pal_id = ?")
      .get(palId) as { n: number };
    return row.n;
  }

  countTurn(sessionId: number): number {
    this.db.prepare("UPDATE sessions SET turns = turns + 1 WHERE id = ?").run(sessionId);
    return (
      this.db.prepare("SELECT turns FROM sessions WHERE id = ?").get(sessionId) as { turns: number }
    ).turns;
  }

  // --- needs --------------------------------------------------------------------

  /** Needs with fractional precision, plus when they were last stepped. */
  getNeeds(palId: string): { needs: Needs; updatedAt: number } | undefined {
    const row = this.db
      .prepare("SELECT energy, hunger, bond, updated_at AS updatedAt FROM needs WHERE pal_id = ?")
      .get(palId) as
      { energy: number; hunger: number; bond: number; updatedAt: number } | undefined;
    if (!row) return undefined;
    return {
      needs: { energy: row.energy, hunger: row.hunger, bond: row.bond },
      updatedAt: row.updatedAt,
    };
  }

  saveNeeds(palId: string, needs: Needs, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO needs (pal_id, energy, hunger, bond, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pal_id) DO UPDATE SET energy = excluded.energy, hunger = excluded.hunger, bond = excluded.bond, updated_at = excluded.updated_at",
      )
      .run(palId, needs.energy, needs.hunger, needs.bond, now);
  }

  initialNeeds(): Needs {
    return normalizeNeeds(DEFAULT_NEEDS);
  }

  // --- memories (PLAN 5.4) -----------------------------------------------------------

  addMemory(palId: string, fact: string, tags: readonly string[], now = Date.now()): number {
    const res = this.db
      .prepare("INSERT INTO memories (pal_id, fact, tags, created_at) VALUES (?, ?, ?, ?)")
      .run(palId, fact, tags.join(" "), now);
    return Number(res.lastInsertRowid);
  }

  /** Full-text search; any word may match, best matches first. */
  searchMemories(palId: string, query: string, limit = 5): Memory[] {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    if (!words.length) return [];
    // Quote every token so user text can never inject FTS syntax.
    const match = [...new Set(words)]
      .slice(0, 16)
      .map((w) => `"${w}"`)
      .join(" OR ");
    return this.db
      .prepare(
        `SELECT m.id, m.fact, m.tags, m.created_at AS createdAt FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ? AND m.pal_id = ?
         ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(match, palId, limit)
      .map(toMemory);
  }

  recentMemories(palId: string, limit = 5, before = Number.MAX_SAFE_INTEGER): Memory[] {
    return this.db
      .prepare(
        "SELECT id, fact, tags, created_at AS createdAt FROM memories WHERE pal_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
      )
      .all(palId, before, limit)
      .map(toMemory);
  }

  getMemory(palId: string, id: number): Memory | undefined {
    const row = this.db
      .prepare(
        "SELECT id, fact, tags, created_at AS createdAt FROM memories WHERE pal_id = ? AND id = ?",
      )
      .get(palId, id);
    return row ? toMemory(row) : undefined;
  }

  deleteMemory(palId: string, id: number): boolean {
    return (
      this.db.prepare("DELETE FROM memories WHERE id = ? AND pal_id = ?").run(id, palId).changes > 0
    );
  }

  countMemories(palId: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE pal_id = ?").get(palId) as {
        n: number;
      }
    ).n;
  }

  // --- reminders ------------------------------------------------------------------------

  addReminder(palId: string, dueAt: number, text: string, now = Date.now()): number {
    const res = this.db
      .prepare("INSERT INTO reminders (pal_id, due_at, text, created_at) VALUES (?, ?, ?, ?)")
      .run(palId, dueAt, text, now);
    return Number(res.lastInsertRowid);
  }

  pendingReminders(palId: string): Reminder[] {
    return this.db
      .prepare(
        "SELECT id, due_at AS dueAt, text FROM reminders WHERE pal_id = ? AND fired_at IS NULL AND cancelled = 0 ORDER BY due_at",
      )
      .all(palId) as unknown as Reminder[];
  }

  dueReminders(palId: string, now = Date.now()): Reminder[] {
    return this.pendingReminders(palId).filter((r) => r.dueAt <= now);
  }

  markReminderFired(id: number, now = Date.now()): void {
    this.db.prepare("UPDATE reminders SET fired_at = ? WHERE id = ?").run(now, id);
  }

  cancelReminder(palId: string, id: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE reminders SET cancelled = 1 WHERE id = ? AND pal_id = ? AND fired_at IS NULL AND cancelled = 0",
        )
        .run(id, palId).changes > 0
    );
  }

  // --- meta -----------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        { value: string } | undefined
    )?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
