// The "second brain": quick captures that file themselves into tasks, appointments
// and memories, an agenda the pal can glance at, and day or week briefings.
// Captures come from the browser or a device; the brain decides where each belongs.
import { Type, type Static } from "typebox";
import type { Repeat } from "./abilities.js";
import { StringEnum } from "./schema.js";
import { toText } from "./normalize.js";

/** A capture typed or dictated in one go. Longer than a chat message, shorter than a page. */
export const CAPTURE_TEXT_MAX = 4000;
/** Captures sent over the WebSocket must fit the client frame limit. */
export const CAPTURE_WIRE_MAX = 1000;
export const TASK_TEXT_MAX = 200;
export const TRIAGE_ITEMS_MAX = 5;
/** Markers set while recording (seconds from the start), as on Palanote Classic. */
export const MARKERS_MAX = 50;

export const TRIAGE_KINDS = ["task", "appointment", "memory"] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];
export const BRIEF_SCOPES = ["day", "week"] as const;
export type BriefScope = (typeof BRIEF_SCOPES)[number];
export const NOTE_SOURCES = ["browser", "device", "chat"] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

/**
 * What the model returns when it files a capture. Types and enums only (PLAN 3.1);
 * `normalizeTriage` repairs everything else.
 */
export const LlmTriageSchema = Type.Object(
  {
    clean: Type.String({
      description:
        "The capture rewritten as clear, tidy text in the user's own voice: fillers, false starts and corrections removed. Same language as the capture.",
    }),
    items: Type.Array(
      Type.Object(
        {
          kind: StringEnum(
            TRIAGE_KINDS,
            "task: something the user needs to do. appointment: an event at a specific time. memory: a lasting fact about the user's life.",
          ),
          text: Type.String({
            description: "Short and self-contained, e.g. 'Order the display for the new project'.",
          }),
          when: Type.String({
            description:
              "For tasks with a deadline and appointments: ISO 8601. A date-time with offset when a time was said, or a plain date (YYYY-MM-DD) for a day. Empty when none.",
          }),
        },
        { additionalProperties: false },
      ),
      { description: "Zero or more things to file. Empty when the capture is just a thought." },
    ),
  },
  { additionalProperties: false },
);
export type LlmTriage = Static<typeof LlmTriageSchema>;

export interface TriageItem {
  kind: TriageKind;
  text: string;
  /** Epoch ms. For an all-day date, local midnight at the start of that day. */
  when?: number;
  /** The time was a whole day ("tomorrow"), not a clock time. */
  allDay?: boolean;
}
export interface Triage {
  clean: string;
  items: TriageItem[];
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse an ISO date or date-time. Plain dates are local days, not UTC midnight. */
export function parseWhen(value: unknown): { at: number; allDay: boolean } | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const s = value.trim();
  const day = DATE_ONLY.exec(s);
  if (day) {
    const at = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    return Number.isFinite(at) ? { at, allDay: true } : undefined;
  }
  const at = Date.parse(s);
  return Number.isFinite(at) ? { at, allDay: false } : undefined;
}

/** Repair a model's triage. Never throws; an appointment without a time becomes a task. */
export function normalizeTriage(raw: unknown, capture: string): Triage {
  const r = (raw && typeof raw === "object" ? raw : {}) as { clean?: unknown; items?: unknown };
  const clean = toText(r.clean, CAPTURE_TEXT_MAX) || toText(capture, CAPTURE_TEXT_MAX);
  const items: TriageItem[] = [];
  for (const it of Array.isArray(r.items) ? r.items : []) {
    if (items.length >= TRIAGE_ITEMS_MAX) break;
    const x = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const text = toText(x.text, TASK_TEXT_MAX);
    if (!text) continue;
    let kind: TriageKind = (TRIAGE_KINDS as readonly string[]).includes(x.kind as string)
      ? (x.kind as TriageKind)
      : "task";
    const when = parseWhen(x.when);
    if (kind === "appointment" && (!when || when.allDay)) kind = "task";
    items.push({
      kind,
      text,
      ...(when && kind !== "memory" ? { when: when.at, allDay: when.allDay } : {}),
    });
  }
  return { clean, items };
}

export interface TaskInfo {
  id: number;
  text: string;
  /** Epoch ms; for all-day tasks the start of the day. */
  dueAt: number | null;
  allDay: boolean;
  doneAt: number | null;
  createdAt: number;
  noteId: number | null;
}

export interface NoteInfo {
  id: number;
  /** Tidied text; the raw capture is kept alongside. */
  text: string;
  raw: string;
  /** What the capture was filed as, e.g. ["task #3", "memory #12"]. Empty for a plain note. */
  filed: string[];
  source: NoteSource;
  /** When it was said (a device may upload later). */
  recordedAt: number;
  createdAt: number;
  markers: number[];
}

export interface AgendaEvent {
  id: number;
  text: string;
  at: number;
  repeat: Repeat;
}

export interface AgendaInfo {
  generatedAt: number;
  /** Open tasks: overdue first, then by due date, then newest undated. */
  tasks: TaskInfo[];
  /** Tasks finished in the last day, for a little sense of progress. */
  done: TaskInfo[];
  /** Reminders and appointments in the next month. */
  events: AgendaEvent[];
  overdue: number;
}

/** A task is overdue after its time, or after its whole day for all-day tasks. */
export function isOverdue(task: Pick<TaskInfo, "dueAt" | "allDay" | "doneAt">, now: number) {
  if (task.doneAt !== null || task.dueAt === null) return false;
  if (!task.allDay) return now > task.dueAt;
  const end = new Date(task.dueAt);
  end.setDate(end.getDate() + 1);
  return now >= end.getTime();
}

/** Agenda sizes for the compact wire form. Small screens show a handful at most. */
export const AGENDA_WIRE_TASKS = 5;
export const AGENDA_WIRE_EVENTS = 3;
export const AGENDA_WIRE_TEXT = 48;
