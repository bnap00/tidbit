// PalService: the active pal, its session, needs, memories, reminders and turns.
// Transport-agnostic; the WebSocket server and the scheduler both drive it.
import { randomBytes } from "node:crypto";
import { AbilitiesStore } from "./abilities-store.js";
import { CompanionStore } from "./companion-store.js";
import {
  ActionInputSchema,
  SkillInputSchema,
  parseSkillMarkdown,
  skillSlug,
  type AbilitiesState,
  type ActionInput,
  type SkillInput,
  DnaSchema,
  PersonalitySchema,
  SelfUpdateSchema,
  toText,
  NAME_MAX,
  PERSONA_MAX,
  type ChatLine,
  type CompanionState,
  type Personality,
  type Mood,
  normalizeDna,
  randomDna,
  type DNA,
  type Needs,
  type TouchKind,
  type Turn,
  type AgendaInfo,
  type BriefScope,
  type NoteInfo,
  type NoteSource,
  type Triage,
  MARKERS_MAX,
  TASK_TEXT_MAX,
  normalizeTurn,
  parseWhen,
} from "@tidbit/protocol";
import { Value } from "typebox/value";
import type { Abilities, Brain, SessionLog, TurnContext, UserInput } from "./brain.js";
import { roundNeeds, stepNeeds, type NeedsEvent } from "./needs.js";
import { NotesStore } from "./notes-store.js";
import {
  briefingFacts,
  buildAgenda,
  cleanRaw,
  describeTriage,
  describeWhen,
  scriptedTriage,
} from "./second-brain.js";
import type { Memory, Reminder, Store } from "./store.js";
import { createTools, type PalTools } from "./tools.js";
import { addressScope, searchEnabled, type Lookup, type SearchConfig } from "./web.js";

export interface TurnResult {
  id: string;
  turn: Turn;
  needs: Needs;
  lines?: ChatLine[];
  replayed?: boolean;
  /** The pal's new DNA when it changed itself during this turn. */
  dna?: DNA;
}

export interface CaptureRequest {
  text: string;
  source: NoteSource;
  /** Makes retries safe: a capture already filed under this ID is replayed. */
  requestId?: string;
  /** The pal it was captured for; refused if another pal is active now. */
  palId?: string;
  /** When it was said, if earlier (captured offline). Defaults to now. */
  recordedAt?: number;
  /** False keeps it as a plain note without filing (Palanote Classic). */
  file?: boolean;
  markers?: number[];
}

export interface CaptureResult {
  noteId: number;
  filed: string[];
  /** A short human summary, e.g. "Task: Order the display (today)". */
  summary: string;
  /** The pal's nod; absent when replayed. */
  turn?: TurnResult;
  replayed?: boolean;
}

/** Growth points needed for each stage (M6): baby → kid → grown. */
export const GROWTH_THRESHOLDS = [15, 60] as const;
export const GROWTH_POINTS = { bondUp: 1, pet: 0.5, feed: 0.5 };

export function growthStage(points: number): 0 | 1 | 2 {
  return points >= GROWTH_THRESHOLDS[1] ? 2 : points >= GROWTH_THRESHOLDS[0] ? 1 : 0;
}

/**
 * What the model already has in its current context (one per session). Context blocks
 * are append-only and part of the cached prompt prefix, so a memory is shown once per
 * session; an edit is shown again as an update rather than rewriting history.
 */
interface ContextMemory {
  shown: number[];
  updated: number[];
  /** Note ids already shown in this context. */
  notes?: number[];
}

export interface ServiceOptions {
  ownerId?: string;
  clock?: () => number;
  fetch?: typeof fetch;
  /** Close a session after this many turns (PLAN 5.5). */
  sessionMaxTurns?: number;
  /** Web search provider for the `web_search` tool, if configured. */
  search?: SearchConfig;
  /** Let owner-defined actions call hosts on private networks (LAN, Tailscale). */
  allowPrivateActions?: boolean;
  lookup?: Lookup;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class PalService {
  readonly companions: CompanionStore;
  readonly abilities: AbilitiesStore;
  readonly notes: NotesStore;
  private readonly owners = new Map<string, PalService>();
  private queue: Promise<unknown> = Promise.resolve();
  private touches: Partial<Record<TouchKind, number>> = {};
  private turnCounter = 0;
  /** Set when the pal changed itself during the running turn. */
  private selfChanged = false;
  private dna: DNA;
  private readonly clock: () => number;
  private readonly log: NonNullable<ServiceOptions["log"]>;

  constructor(
    private readonly store: Store,
    readonly brain: Brain,
    private readonly opts: ServiceOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.companions = new CompanionStore(store);
    this.abilities = new AbilitiesStore(store);
    this.notes = new NotesStore(store);
    this.dna =
      (opts.ownerId ? this.companions.activePal(opts.ownerId) : store.activePal()) ??
      this.adopt(this.freshDna(randomDna((Math.random() * 2 ** 32) >>> 0)));
    this.companions.conversation(this.dna.id, this.clock());
  }

  forOwner(ownerId: string): PalService {
    let scoped = this.owners.get(ownerId);
    if (!scoped) {
      scoped = new PalService(this.store, this.brain, { ...this.opts, ownerId });
      this.owners.set(ownerId, scoped);
    }
    return scoped;
  }

  private freshDna(dna: DNA): DNA {
    return this.opts.ownerId ? { ...dna, id: `pal_${randomBytes(10).toString("hex")}` } : dna;
  }

  get conversationId(): string {
    return this.companions.conversation(this.dna.id, this.clock());
  }
  get ownerId(): string {
    return this.opts.ownerId ?? "legacy";
  }

  get pal(): DNA {
    return this.dna;
  }

  now(): number {
    return this.clock();
  }

  /** Persistent growth points; pals that predate growth start from their turn count. */
  private growthPoints(): number {
    const key = `growth:${this.dna.id}`;
    const v = this.store.getMeta(key);
    if (v !== undefined) return Number(v) || 0;
    const initial = this.store.totalTurns(this.dna.id);
    this.store.setMeta(key, String(initial));
    return initial;
  }

  private addGrowth(points: number): void {
    this.store.setMeta(`growth:${this.dna.id}`, String(this.growthPoints() + points));
  }

  growth(): 0 | 1 | 2 {
    return growthStage(this.growthPoints());
  }

  private adopt(dna: DNA): DNA {
    this.store.savePal(dna);
    if (this.opts.ownerId) this.companions.adopt(this.opts.ownerId, dna);
    else this.store.setActivePal(dna.id);
    if (!this.store.getNeeds(dna.id))
      this.store.saveNeeds(dna.id, this.store.initialNeeds(), this.clock());
    this.store.openSession(
      dna.id,
      this.clock(),
      this.companions.conversation(dna.id, this.clock()),
    );
    this.touches = {};
    this.dna = dna;
    return dna;
  }

  /** Serialize all mutations: turns, creation and needs changes run one at a time. */
  private run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Step needs lazily up to now, apply events, persist (PLAN 5.6). */
  private advanceNeeds(events: NeedsEvent[] = []): Needs {
    const now = this.clock();
    const cur = this.store.getNeeds(this.dna.id) ?? {
      needs: this.store.initialNeeds(),
      updatedAt: now,
    };
    const next = stepNeeds(cur.needs, cur.updatedAt, now - cur.updatedAt, events);
    this.store.saveNeeds(this.dna.id, next, now);
    return next;
  }

  needs(): Promise<Needs> {
    return this.run(() => roundNeeds(this.advanceNeeds()));
  }

  touch(kind: TouchKind): Promise<Needs> {
    return this.run(() => {
      this.touches[kind] = (this.touches[kind] ?? 0) + 1;
      if (kind === "pet" || kind === "feed") this.addGrowth(GROWTH_POINTS[kind]);
      return roundNeeds(this.advanceNeeds([{ kind: "touch", touch: kind }]));
    });
  }

  create(prompt?: string): Promise<DNA> {
    return this.run(async () =>
      this.adopt(this.freshDna(await this.brain.createCharacter(prompt))),
    );
  }

  /** Adopt a shared pal as-is (it was validated on the wire). */
  adoptShared(dna: DNA): Promise<DNA> {
    return this.run(() =>
      this.adopt(this.freshDna(normalizeDna(dna, { id: dna.id, seed: dna.seed }))),
    );
  }

  /** Tools for the model, bound to its session, or for the owner's own edits. */
  tools(sessionId?: number): PalTools {
    return createTools({
      store: this.store,
      palId: this.dna.id,
      clock: this.clock,
      fetch: this.opts.fetch ?? fetch,
      abilities: this.abilities,
      search: this.opts.search,
      allowPrivateActions: this.opts.allowPrivateActions,
      lookup: this.opts.lookup,
      updateSelf: (patch) => this.updateSelf(patch),
      notes: this.notes,
      onMemory: (kind, ids) =>
        kind === "forgotten"
          ? ids.forEach((id) => this.memoryForgotten(id))
          : sessionId !== undefined && this.markShown(sessionId, ids),
    });
  }

  private contextMemory(sessionId: number): ContextMemory {
    const raw = this.store.getMeta(`context_memory:${sessionId}`);
    return raw ? (JSON.parse(raw) as ContextMemory) : { shown: [], updated: [] };
  }

  private saveContextMemory(sessionId: number, value: ContextMemory): void {
    this.store.setMeta(`context_memory:${sessionId}`, JSON.stringify(value));
  }

  private markShown(sessionId: number, ids: number[]): void {
    const state = this.contextMemory(sessionId);
    state.shown = [...new Set([...state.shown, ...ids])];
    this.saveContextMemory(sessionId, state);
  }

  /** An edited memory the model has seen is re-shown as an update; the cached prefix stays. */
  private memoryEdited(id: number): void {
    for (const sessionId of this.store.openSessionIds(this.dna.id)) {
      const state = this.contextMemory(sessionId);
      if (!state.shown.includes(id) || state.updated.includes(id)) continue;
      state.updated.push(id);
      this.saveContextMemory(sessionId, state);
    }
  }

  /**
   * A forgotten memory must leave the model's context, and its text is baked into the
   * cached prefix. Close every context that saw it, without a summary that could carry
   * it forward; the next turn starts a fresh prompt. Visible chat history is unaffected.
   */
  private memoryForgotten(id: number): void {
    for (const sessionId of this.store.openSessionIds(this.dna.id)) {
      if (!this.contextMemory(sessionId).shown.includes(id)) continue;
      this.store.closeSession(sessionId, this.clock());
      this.log("context reset after forget", { session: sessionId, memory: id });
    }
  }

  dueReminders(): Reminder[] {
    return this.store.dueReminders(this.dna.id, this.clock());
  }

  private sessionLog(): SessionLog {
    const s = this.store.openSession(this.dna.id, this.clock(), this.conversationId);
    return {
      id: s.id,
      load: () => this.store.loadMessages(s.id),
      save: (messages) => this.store.appendMessages(s.id, messages),
    };
  }

  /**
   * Memories for this turn's context block: updates to ones already shown, then
   * full-text matches, then the most recent, skipping any already in this context.
   */
  private surfaceMemories(sessionId: number, text: string): string[] {
    const state = this.contextMemory(sessionId);
    const shown = new Set(state.shown);
    const updated = state.updated
      .map((id) => this.store.getMemory(this.dna.id, id))
      .filter((m): m is Memory => !!m);
    const picked: Memory[] = [];
    for (const m of [
      ...this.store.searchMemories(this.dna.id, text, 8),
      ...this.store.recentMemories(this.dna.id, 5),
    ]) {
      if (updated.length + picked.length >= 5) break;
      if (!shown.has(m.id) && !picked.some((p) => p.id === m.id)) picked.push(m);
    }
    this.saveContextMemory(sessionId, {
      ...state,
      shown: [...shown, ...picked.map((m) => m.id)],
      updated: [],
    });
    return [...updated.map((m) => `(updated) ${m.fact}`), ...picked.map((m) => m.fact)];
  }

  /** Up to 3 of the user's notes that match the input, each shown once per context. */
  private surfaceNotes(sessionId: number, text: string): string[] {
    const state = this.contextMemory(sessionId);
    const shown = new Set(state.notes ?? []);
    const picked = this.notes
      .searchNotes(this.dna.id, text, 6)
      .filter((n) => !shown.has(n.id))
      .slice(0, 3);
    if (!picked.length) return [];
    this.saveContextMemory(sessionId, {
      ...state,
      notes: [...shown, ...picked.map((n) => n.id)],
    });
    const now = this.clock();
    return picked.map((n) => `(${describeWhen(n.recordedAt, true, now)}) ${n.text.slice(0, 400)}`);
  }

  private context(
    needs: Needs,
    dueReminders: string[],
    memories: string[] = [],
    session = this.sessionLog(),
    notes: string[] = [],
  ): TurnContext {
    return {
      notes,
      agenda: this.agendaLine(),
      dna: this.dna,
      personality: this.companions.personality(this.dna),
      relationship: this.relationship(needs),
      needs,
      now: new Date(this.clock()),
      touches: { ...this.touches },
      session,
      tools: this.tools(session.id),
      memories,
      dueReminders,
      abilities: this.abilityIndex(),
    };
  }

  /** What the model is told it can do: enabled skills and actions, sorted by name. */
  private abilityIndex(): Abilities {
    const pick = (x: { name: string; description: string }) => ({
      name: x.name,
      description: x.description,
    });
    return {
      skills: this.abilities
        .skills(this.dna.id, this.clock())
        .filter((s) => s.enabled)
        .map(pick),
      actions: this.abilities
        .actions(this.dna.id)
        .filter((a) => a.enabled)
        .map(pick),
      webSearch: !!this.opts.search && searchEnabled(this.opts.search),
    };
  }

  /**
   * The pal changes itself on the user's request. The patch is merged onto the current
   * DNA and personality and checked strictly: an invalid value is refused with the
   * reason, never replaced by a default. Identity (id, seed), memories and bond stay.
   */
  updateSelf(patch: unknown): string {
    if (!Value.Check(SelfUpdateSchema, patch)) {
      const e = Value.Errors(SelfUpdateSchema, patch)[0];
      throw new Error(`invalid change${e ? ` at ${e.instancePath || "/"}: ${e.message}` : ""}`);
    }
    const p = patch;
    const old = this.dna;
    const dna: DNA = {
      ...old,
      ...(p.name !== undefined ? { name: toText(p.name, NAME_MAX) } : {}),
      ...(p.persona !== undefined ? { persona: toText(p.persona, PERSONA_MAX) } : {}),
      ...(p.baseMood !== undefined ? { baseMood: p.baseMood } : {}),
      look: { ...old.look, ...p.look },
      temper: { ...old.temper, ...p.temper },
      voice: { ...old.voice, ...p.voice },
    };
    if (!Value.Check(DnaSchema, dna)) {
      const e = Value.Errors(DnaSchema, dna)[0];
      throw new Error(`can't do that${e ? `: ${e.instancePath.slice(1)} ${e.message}` : ""}`);
    }
    const oldProfile = this.companions.personality(old);
    const profile = { ...oldProfile, ...p.personality };
    if (!Value.Check(PersonalitySchema, profile)) {
      const e = Value.Errors(PersonalitySchema, profile)[0];
      throw new Error(
        `can't do that${e ? `: personality ${e.instancePath.slice(1)} ${e.message}` : ""}`,
      );
    }
    const changes: string[] = [];
    const diff = (path: string, a: unknown, b: unknown) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(`${path} → ${JSON.stringify(b)}`);
    };
    for (const key of ["name", "persona", "baseMood"] as const) diff(key, old[key], dna[key]);
    for (const group of ["look", "temper", "voice"] as const)
      for (const [k, v] of Object.entries(dna[group]))
        diff(`${group}.${k}`, (old[group] as Record<string, unknown>)[k], v);
    for (const [k, v] of Object.entries(profile))
      diff(k, (oldProfile as Record<string, unknown>)[k], v);
    if (!changes.length) return "Nothing changed; that is already how you are.";
    this.store.savePal(dna);
    this.companions.savePersonality(dna.id, profile);
    this.dna = dna;
    this.selfChanged = true;
    this.log("pal changed itself", { pal: dna.id, changes: changes.length });
    return `Changed: ${changes.join("; ")}. Memories and bond are unchanged.`;
  }

  /** Skills, actions and pending routines for the owner's settings panel. Secrets excluded. */
  abilitiesState(): AbilitiesState {
    const repeat = (id: number) => this.abilities.repeatOf(id);
    return {
      skills: this.abilities.skills(this.dna.id, this.clock()),
      actions: this.abilities.actions(this.dna.id).map(({ headers: _secret, ...info }) => info),
      routines: this.store
        .pendingReminders(this.dna.id)
        .map((r) => ({ ...r, repeat: repeat(r.id) })),
      builtins: [
        { name: "Memory", description: "Remembers, recalls and forgets facts about you." },
        { name: "Reminders & routines", description: "One-off or repeating, hourly to weekly." },
        { name: "Time & weather", description: "Local time; weather anywhere (Open-Meteo)." },
        {
          name: "Second brain",
          description: "Files quick notes into tasks, appointments and memories; briefings.",
        },
        { name: "Read web pages", description: "Opens public links you share or it finds." },
        ...(this.opts.search && searchEnabled(this.opts.search)
          ? [{ name: "Web search", description: "Searches the web for answers." }]
          : []),
      ],
    };
  }

  /**
   * One conversational or proactive turn. Due reminders ride along with the
   * input and are marked delivered.
   */
  turn(
    input: UserInput,
    reminders: Reminder[] = [],
    hooks: Pick<TurnContext, "onEarlyMood"> = {},
  ): Promise<TurnResult> {
    return this.run(() => this.executeTurn(input, reminders, hooks));
  }

  private async executeTurn(
    input: UserInput,
    reminders: Reminder[] = [],
    hooks: Pick<TurnContext, "onEarlyMood"> = {},
    requestId: string | null = null,
  ): Promise<TurnResult> {
    const conversationId = this.conversationId;
    const lines: ChatLine[] = [];
    if (input.kind === "say")
      lines.push(this.companions.line(conversationId, "you", input.text, this.clock(), requestId));

    const needs = this.advanceNeeds(input.kind === "say" ? [{ kind: "talk" }] : []);
    const due = input.kind === "say" ? this.dueReminders() : reminders;
    const text = input.kind === "say" ? input.text : (input.text ?? input.event);
    const session = this.sessionLog();
    const ctx = this.context(
      needs,
      due.map((r) => r.text),
      this.surfaceMemories(session.id, text),
      session,
      input.kind === "say" ? this.surfaceNotes(session.id, text) : [],
    );
    this.selfChanged = false;
    const turn = await this.brain.runTurn({ ...ctx, ...hooks }, input);
    for (const r of due) this.abilities.fire(r.id, this.clock());
    this.touches = {};
    const turns = this.store.countTurn(ctx.session.id);
    const after = this.advanceNeeds([{ kind: "bond", bond: turn.bond }]);
    if (turn.bond === "up") this.addGrowth(GROWTH_POINTS.bondUp);
    this.turnCounter++;
    this.store.setMeta(`mood:${this.dna.id}`, turn.beats.at(-1)?.mood ?? this.dna.baseMood);
    this.store.setMeta(`last_interaction:${this.dna.id}`, String(this.clock()));
    const said = turn.beats
      .map((b) => b.say)
      .filter(Boolean)
      .join(" ");
    if (said)
      lines.push(this.companions.line(conversationId, "pal", said, this.clock(), requestId));
    const result: TurnResult = {
      id: `t_${this.clock().toString(36)}_${this.turnCounter}`,
      turn,
      needs: roundNeeds(after),
      lines,
      ...(this.selfChanged ? { dna: this.dna } : {}),
    };
    if (requestId) this.companions.finishRequest(this.ownerId, requestId, result);
    if (turns >= (this.opts.sessionMaxTurns ?? 40)) await this.rollover(ctx);
    return result;
  }

  /** A request ID survives reconnects; a completed reply is replayed, never regenerated. */
  sayOnce(
    request: { requestId: string; text: string; palId: string; conversationId: string },
    hooks: Pick<TurnContext, "onEarlyMood"> = {},
  ): Promise<TurnResult> {
    return this.run(async () => {
      const saved = this.companions.request(this.ownerId, request.requestId);
      if (
        saved &&
        (saved.text !== request.text ||
          saved.palId !== request.palId ||
          saved.conversationId !== request.conversationId)
      )
        throw new Error("Message ID already belongs to another message.");
      if (request.palId !== this.dna.id || request.conversationId !== this.conversationId)
        throw new Error(
          "This message belongs to a different conversation. Switch back to send it.",
        );
      if (saved?.result) return { ...(JSON.parse(saved.result) as TurnResult), replayed: true };
      this.companions.startRequest(
        this.ownerId,
        request.requestId,
        request.palId,
        request.conversationId,
        request.text,
      );
      const result = await this.executeTurn(
        { kind: "say", text: request.text },
        [],
        hooks,
        request.requestId,
      );
      return result;
    });
  }

  private relationship(needs: Needs) {
    const interactions = this.store.totalTurns(this.dna.id);
    return {
      stage:
        needs.bond >= 80 && interactions >= 15
          ? "Close companions"
          : interactions >= 5
            ? "Getting familiar"
            : "Getting acquainted",
      interactions,
      ritual: this.companions.personality(this.dna).ritual,
    };
  }

  async snapshot(): Promise<CompanionState> {
    // Reads must remain available while a model turn is awaiting the network.
    const current = this.store.getNeeds(this.dna.id) ?? {
      needs: this.store.initialNeeds(),
      updatedAt: this.clock(),
    };
    const needs = roundNeeds(
      stepNeeds(current.needs, current.updatedAt, this.clock() - current.updatedAt, []),
    );
    const conversationId = this.conversationId;
    const revision = Number(this.store.getMeta(`revision:${this.ownerId}`) ?? 0) + 1;
    this.store.setMeta(`revision:${this.ownerId}`, String(revision));
    return {
      revision,
      dna: this.dna,
      needs,
      growth: this.growth(),
      personality: this.companions.personality(this.dna),
      relationship: this.relationship(needs),
      mood: (this.store.getMeta(`mood:${this.dna.id}`) ?? this.dna.baseMood) as Mood,
      conversationId,
      conversations: this.companions.conversations(this.dna.id, conversationId),
      pals: this.companions.pals(this.opts.ownerId),
      ...this.companions.history(conversationId),
    };
  }

  history(id: string, before?: number) {
    if (!this.companions.hasConversation(this.dna.id, id))
      throw new Error("Conversation not found.");
    return this.companions.history(id, before);
  }

  manage(input: {
    action: string;
    palId: string;
    conversationId?: string;
    personality?: Personality;
    memoryId?: number;
    fact?: string;
    skill?: unknown;
    skillMarkdown?: string;
    httpAction?: unknown;
    itemId?: number;
    enabled?: boolean;
    text?: string;
    due?: string;
  }): Promise<void> {
    return this.run(async () => {
      if (input.action === "switch_pal") {
        if (this.opts.ownerId && !this.companions.owns(this.opts.ownerId, input.palId))
          throw new Error("Pal not found.");
        const dna = this.store.getPal(input.palId);
        if (!dna) throw new Error("Pal not found.");
        this.adopt(dna);
        return;
      }
      if (input.palId !== this.dna.id)
        throw new Error("The active pal changed. Refresh and try again.");
      if (input.action === "new_conversation") {
        // An untouched conversation is already new; don't stack empty ones.
        if (!this.companions.history(this.conversationId).lines.length) return;
        await this.rollover(this.context(this.advanceNeeds(), []));
        this.companions.newConversation(this.dna.id, this.clock());
        this.touches = {};
      } else if (input.action === "resume") {
        if (
          !input.conversationId ||
          !this.companions.hasConversation(this.dna.id, input.conversationId)
        )
          throw new Error("Conversation not found.");
        this.store.setMeta(`conversation:${this.dna.id}`, input.conversationId);
        this.touches = {};
      } else if (input.action === "personality" && input.personality) {
        this.companions.savePersonality(this.dna.id, input.personality);
      } else if (input.action === "remember" && input.fact) {
        this.tools().remember(input.fact, ["user"]);
      } else if (input.action === "edit_memory" && input.fact && input.memoryId) {
        if (!this.companions.updateMemory(this.dna.id, input.memoryId, input.fact))
          throw new Error("Memory not found.");
        this.memoryEdited(input.memoryId);
      } else if (input.action === "forget" && input.memoryId) {
        if (!this.store.deleteMemory(this.dna.id, input.memoryId))
          throw new Error("Memory not found.");
        this.memoryForgotten(input.memoryId);
      } else if (!this.manageAbility(input) && !this.manageNotes(input))
        throw new Error("Unknown action.");
    });
  }

  /** Owner edits to skills, actions and routines. False when the action isn't one of these. */
  private manageAbility(input: {
    action: string;
    skill?: unknown;
    skillMarkdown?: string;
    httpAction?: unknown;
    itemId?: number;
    enabled?: boolean;
  }): boolean {
    const palId = this.dna.id;
    const id = input.itemId ?? 0;
    switch (input.action) {
      case "save_skill": {
        let skill: SkillInput | undefined;
        if (input.skillMarkdown !== undefined) {
          skill = parseSkillMarkdown(input.skillMarkdown);
          if (!skill)
            throw new Error("Couldn't read that skill. It needs a name, a description and steps.");
        } else if (Value.Check(SkillInputSchema, input.skill)) skill = input.skill;
        if (!skill) throw new Error("Check the skill and try again.");
        const name = skillSlug(skill.name);
        if (!name) throw new Error("Give the skill a name with letters or digits.");
        this.abilities.saveSkill(palId, { ...skill, name }, "owner", this.clock());
        return true;
      }
      case "toggle_skill":
        if (!this.abilities.setSkillEnabled(palId, id, !!input.enabled))
          throw new Error("Skill not found.");
        return true;
      case "delete_skill":
        if (!this.abilities.deleteSkill(palId, id)) throw new Error("Skill not found.");
        return true;
      case "save_http_action": {
        if (!Value.Check(ActionInputSchema, input.httpAction))
          throw new Error("Check the action and try again.");
        const action: ActionInput = input.httpAction;
        const name = skillSlug(action.name);
        if (!name) throw new Error("Give the action a name with letters or digits.");
        let url: URL;
        try {
          url = new URL(action.url.replaceAll("{input}", "x"));
        } catch {
          throw new Error("The action needs a full http(s) URL.");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:")
          throw new Error("The action needs a full http(s) URL.");
        // Checked again, with DNS, every time the action runs.
        const host = url.hostname.replace(/^\[|\]$/g, "");
        if (
          /^localhost$/i.test(host) ||
          (/^[\d.:a-f]+$/i.test(host) && addressScope(host) === "local")
        )
          throw new Error("Actions can't call this machine.");
        this.abilities.saveAction(palId, { ...action, name }, this.clock());
        return true;
      }
      case "toggle_http_action":
        if (!this.abilities.setActionEnabled(palId, id, !!input.enabled))
          throw new Error("Action not found.");
        return true;
      case "delete_http_action":
        if (!this.abilities.deleteAction(palId, id)) throw new Error("Action not found.");
        return true;
      case "cancel_routine":
        if (!this.store.cancelReminder(palId, id)) throw new Error("Routine not found.");
        return true;
      default:
        return false;
    }
  }

  /** Owner edits to tasks and notes. False when the action isn't one of these. */
  private manageNotes(input: {
    action: string;
    itemId?: number;
    enabled?: boolean;
    text?: string;
    due?: string;
  }): boolean {
    const palId = this.dna.id;
    const id = input.itemId ?? 0;
    const due = () => {
      if (!input.due?.trim()) return { dueAt: null, allDay: false };
      const when = parseWhen(input.due);
      if (!when) throw new Error("Pick a valid date.");
      return { dueAt: when.at, allDay: when.allDay };
    };
    const text = () => {
      const clean = toText(input.text, TASK_TEXT_MAX);
      if (!clean) throw new Error("Write what needs doing.");
      return clean;
    };
    switch (input.action) {
      case "add_task": {
        const when = due();
        this.notes.addTask(
          palId,
          {
            text: text(),
            ...(when.dueAt !== null ? { dueAt: when.dueAt, allDay: when.allDay } : {}),
          },
          this.clock(),
        );
        return true;
      }
      case "edit_task":
        if (!this.notes.updateTask(palId, id, { text: text(), ...due() }))
          throw new Error("Task not found.");
        return true;
      case "complete_task":
        if (!this.notes.setTaskDone(palId, id, input.enabled !== false, this.clock()))
          throw new Error("Task not found.");
        return true;
      case "delete_task":
        if (!this.notes.deleteTask(palId, id)) throw new Error("Task not found.");
        return true;
      case "delete_note":
        if (!this.notes.deleteNote(palId, id)) throw new Error("Note not found.");
        return true;
      default:
        return false;
    }
  }

  /** Open tasks, recently finished ones and the next month of reminders and appointments. */
  agenda(): AgendaInfo {
    const now = this.clock();
    const palId = this.dna.id;
    return buildAgenda(
      this.notes.openTasks(palId),
      this.notes.doneSince(palId, now - 86_400_000),
      this.store.pendingReminders(palId).map((r) => ({
        id: r.id,
        text: r.text,
        at: r.dueAt,
        repeat: this.abilities.repeatOf(r.id),
      })),
      now,
    );
  }

  /** One line for the model's context: how many tasks, how many overdue, what's next. */
  private agendaLine(): string | undefined {
    const agenda = this.agenda();
    const now = this.clock();
    const parts: string[] = [];
    if (agenda.tasks.length)
      parts.push(
        `${agenda.tasks.length} open task${agenda.tasks.length === 1 ? "" : "s"}${agenda.overdue ? ` (${agenda.overdue} overdue)` : ""}`,
      );
    const next = agenda.events.find((e) => e.at > now);
    if (next) parts.push(`next: ${next.text} ${describeWhen(next.at, false, now)}`);
    return parts.length ? parts.join("; ") : undefined;
  }

  notesList(opts: { before?: number; query?: string } = {}): NoteInfo[] {
    return opts.query?.trim()
      ? this.notes.searchNotes(this.dna.id, opts.query, 30)
      : this.notes.recentNotes(this.dna.id, 50, opts.before);
  }

  /**
   * File a quick capture (PLAN M7): keep it as a note, let the brain pick out tasks,
   * appointments and facts, file them, and have the pal nod. The capture never enters
   * a conversation, so it costs one small request and no conversation context.
   */
  capture(req: CaptureRequest): Promise<CaptureResult> {
    return this.run(async () => {
      if (req.requestId) {
        const saved = this.notes.noteByRequest(this.ownerId, req.requestId);
        if (saved) {
          if (saved.raw !== cleanRaw(req.text))
            throw new Error("Capture ID already belongs to another note.");
          return {
            noteId: saved.id,
            filed: saved.filed,
            summary: saved.filed.length
              ? `Already filed: ${saved.filed.join(", ")}`
              : "Already saved.",
            replayed: true,
          };
        }
      }
      if (req.palId && req.palId !== this.dna.id)
        throw new Error("This note was captured for another pal. Switch back to file it.");
      const raw = cleanRaw(req.text);
      if (!raw) throw new Error("The note is empty.");
      const now = this.clock();
      const recordedAt =
        req.recordedAt && req.recordedAt <= now && req.recordedAt > now - 366 * 86_400_000
          ? req.recordedAt
          : now;
      const noteId = this.notes.addNote(
        this.dna.id,
        this.ownerId,
        {
          raw,
          clean: raw,
          source: req.source,
          recordedAt,
          markers: (req.markers ?? [])
            .filter((m) => Number.isFinite(m) && m >= 0)
            .slice(0, MARKERS_MAX),
          requestId: req.requestId,
        },
        now,
      );
      let triage: Triage = { clean: raw, items: [] };
      if (req.file !== false) {
        // Relative dates ("tomorrow") are relative to when it was said.
        const ctx = { now: new Date(recordedAt), dna: this.dna };
        try {
          triage = this.brain.triage
            ? await this.brain.triage(ctx, raw)
            : scriptedTriage(raw, ctx.now);
        } catch (e) {
          this.log("triage threw", { error: (e as Error).message });
          triage = scriptedTriage(raw, ctx.now);
        }
      }
      const filed: string[] = [];
      const done: typeof triage.items = [];
      const tools = this.tools();
      for (const item of triage.items) {
        try {
          if (item.kind === "memory") {
            const id = /#(\d+)/.exec(tools.remember(item.text, ["note"]))?.[1];
            if (id) filed.push(`memory #${id}`);
          } else if (item.kind === "appointment" && item.when !== undefined && item.when > now) {
            filed.push(
              `appointment #${this.store.addReminder(this.dna.id, item.when, item.text, now)}`,
            );
          } else {
            const id = this.notes.addTask(
              this.dna.id,
              {
                text: item.text,
                noteId,
                ...(item.when !== undefined ? { dueAt: item.when, allDay: !!item.allDay } : {}),
              },
              now,
            );
            filed.push(`task #${id}`);
            if (item.kind === "appointment") item.kind = "task";
          }
          done.push(item);
        } catch (e) {
          this.log("filing failed", { kind: item.kind, error: (e as Error).message });
        }
      }
      this.notes.fileNote(noteId, triage.clean || raw, filed);
      const summary = describeTriage(done, now);
      const lastBeat = done.length
        ? { mood: "proud" as const, action: "nod" as const, fx: "sparkles" as const }
        : { mood: "happy" as const, action: "nod" as const, fx: "notes" as const };
      const turn = normalizeTurn(
        { beats: [{ ...lastBeat, intensity: 2, say: summary, look: "user" }], bond: "same" },
        this.dna.baseMood,
      );
      this.turnCounter++;
      return {
        noteId,
        filed,
        summary,
        turn: {
          id: `t_${now.toString(36)}_${this.turnCounter}`,
          turn,
          needs: roundNeeds(this.advanceNeeds()),
        },
      };
    });
  }

  /** A spoken briefing of today or the week, from the agenda, as a turn in the chat. */
  brief(scope: BriefScope): Promise<TurnResult> {
    const facts = briefingFacts(this.agenda(), scope, this.clock());
    return this.turn({ kind: "event", event: `briefing_${scope}`, text: facts });
  }

  memories(before?: number) {
    return this.store.recentMemories(this.dna.id, 100, before);
  }

  /** Close a long session: summarise it into a memory, then start fresh (PLAN 5.5). */
  private async rollover(ctx: TurnContext): Promise<void> {
    const info = this.store.sessionInfo(ctx.session.id);
    // A context with no turns (e.g. a resumed conversation) has nothing new to summarise,
    // and a closed one was already handled.
    if (!info || info.closed || !info.turns) return;
    // The summariser sees what is already remembered so it only adds what's new.
    const known = this.store
      .recentMemories(this.dna.id, 40)
      .filter((m) => !m.tags.includes("session"))
      .map((m) => m.fact);
    let summary: string | undefined;
    try {
      summary = await this.brain.summarizeSession?.({ ...ctx, memories: known });
    } catch (e) {
      this.log("summary threw", { error: (e as Error).message });
    }
    if (summary === undefined) {
      // Offline bridge: only this context's own lines, never earlier, already-summarised ones.
      const recent = this.companions
        .history(this.conversationId)
        .lines.filter((line) => line.createdAt >= info.createdAt)
        .slice(-6);
      if (recent.length)
        summary = `Recent conversation: ${recent.map((line) => `${line.who}: ${line.text}`).join(" | ")}`;
    }
    if (summary)
      this.store.addMemory(this.dna.id, summary.slice(0, 600), ["session"], this.clock());
    this.store.closeSession(ctx.session.id, this.clock());
    this.log("session rolled over", { session: ctx.session.id, summarised: !!summary });
  }

  /** Deliver one due reminder as a proactive turn (PLAN 5.7). */
  remind(r: Reminder): Promise<TurnResult> {
    return this.turn({ kind: "event", event: "reminder_due", text: r.text }, [r]);
  }

  /** Any other proactive event, e.g. first contact of the day or a need threshold. */
  proactive(event: string, text?: string): Promise<TurnResult> {
    return this.turn({ kind: "event", event, ...(text ? { text } : {}) });
  }

  meta = {
    get: (k: string) =>
      this.store.getMeta(
        k.startsWith("alert_") ? `${this.ownerId}:${this.dna.id}:${k}` : `${this.ownerId}:${k}`,
      ),
    set: (k: string, v: string) =>
      this.store.setMeta(
        k.startsWith("alert_") ? `${this.ownerId}:${this.dna.id}:${k}` : `${this.ownerId}:${k}`,
        v,
      ),
  };
}
