// The Brain interface (PLAN 5.1). Nothing outside src/pi/ imports pi.
import type { DNA, Mood, Needs, Turn, Personality, Triage } from "@tidbit/protocol";
import type { PalTools } from "./tools.js";

export type UserInput =
  | { kind: "say"; text: string }
  /** A system event such as a due reminder (proactive turns, M4). */
  | { kind: "event"; event: string; text?: string };

/** Append-only message log for one session; its shape is owned by the brain that uses it. */
export interface SessionLog {
  load(): unknown[];
  save(messages: readonly unknown[]): void;
  readonly id: number;
}

export interface TurnContext {
  dna: DNA;
  personality?: Personality;
  relationship?: { stage: string; interactions: number; ritual: string };
  needs: Needs;
  now: Date;
  /** Touches since the last turn, e.g. { pet: 3 } (PLAN 5.8). */
  touches: Partial<Record<string, number>>;
  session: SessionLog;
  /** Tools bound to this pal (PLAN 5.4). */
  tools: PalTools;
  /**
   * Up to 5 memories relevant to this input and not yet shown in this session (PLAN 5.3).
   * For summarizeSession, every stored fact, so the summary only adds what's new.
   */
  memories: string[];
  /** Reminders that are due now, e.g. "water the plants". */
  dueReminders: string[];
  /** Notes the user captured that match this input, with their dates, not yet shown. */
  notes?: string[];
  /** A one-line glance at open tasks and the next appointment. */
  agenda?: string;
  /** Enabled skills and actions, and optional built-ins, for the model's index. */
  abilities?: Abilities;
  /** Called once with the first beat's mood as soon as it is known (streaming, M6). */
  onEarlyMood?: (mood: Mood) => void;
}

export interface Abilities {
  skills: { name: string; description: string }[];
  actions: { name: string; description: string }[];
  webSearch: boolean;
}

/** What filing a capture needs: when it is, and whose words they are. */
export interface TriageContext {
  now: Date;
  dna: DNA;
}

export interface Brain {
  readonly name: string;
  createCharacter(prompt?: string): Promise<DNA>;
  runTurn(ctx: TurnContext, input: UserInput): Promise<Turn>;
  /**
   * Summarise a session that is being closed (PLAN 5.5). Empty string when nothing new
   * is worth keeping; undefined when it could not summarise (an offline bridge is kept).
   */
  summarizeSession?(ctx: TurnContext): Promise<string | undefined>;
  /**
   * File a capture: tidy it and pick out tasks, appointments and lasting facts. One
   * request, outside any conversation. Never throws; falls back to offline triage.
   */
  triage?(ctx: TriageContext, text: string): Promise<Triage>;
  /** Release pooled connections so the process can exit. */
  close?(): void;
}
