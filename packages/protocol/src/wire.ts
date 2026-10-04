// WebSocket wire messages (PLAN 3.4). JSON text frames, every message < 1 KB.
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { MOODS, TOUCH_KINDS } from "./enums.js";
import { CLIENT_FRAME_MAX_BYTES, WIRE_MAX_BYTES } from "./limits.js";
import { toText } from "./normalize.js";
import { DnaSchema, NeedsSchema, StringEnum, TurnSchema } from "./schema.js";
import {
  AGENDA_WIRE_EVENTS,
  AGENDA_WIRE_TASKS,
  AGENDA_WIRE_TEXT,
  BRIEF_SCOPES,
  CAPTURE_WIRE_MAX,
  MARKERS_MAX,
  isOverdue,
  type AgendaInfo,
} from "./second-brain.js";

export const CapsSchema = Type.Object({
  w: Type.Integer({ minimum: 1, maximum: 4096 }),
  h: Type.Integer({ minimum: 1, maximum: 4096 }),
  colors: Type.Union([Type.Literal(2), Type.Literal(16), Type.Literal(65536)]),
  input: Type.Array(Type.String({ maxLength: 24 }), { maxItems: 8 }),
  /**
   * "rig": the client cannot run the rig, so the brain renders it and streams each
   * frame's draw commands as binary messages instead of the JSON pet messages.
   */
  stream: Type.Optional(Type.Literal("rig")),
  /** Frames per second for a rig stream (default 24, at most 30). */
  fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
});

export const HelloMsg = Type.Object({
  type: Type.Literal("hello"),
  ownerToken: Type.Optional(Type.String({ minLength: 32, maxLength: 128 })),
  clientId: Type.String({ minLength: 1, maxLength: 64 }),
  palId: Type.Optional(Type.String({ maxLength: 64 })),
  token: Type.Optional(Type.String({ maxLength: 128 })),
  caps: CapsSchema,
});
export const SayMsg = Type.Object({
  type: Type.Literal("say"),
  text: Type.String({ minLength: 1, maxLength: 1000 }),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  palId: Type.Optional(Type.String({ maxLength: 64 })),
  conversationId: Type.Optional(Type.String({ maxLength: 64 })),
});
export const TouchMsg = Type.Object({
  type: Type.Literal("touch"),
  kind: StringEnum(TOUCH_KINDS),
});
export const CreateMsg = Type.Object({
  type: Type.Literal("create"),
  prompt: Type.Optional(Type.String({ maxLength: 300 })),
  /** Adopt a shared pal instead of generating one (M6 DNA sharing). */
  dna: Type.Optional(DnaSchema),
});

/**
 * A quick capture: a thought to file, not a chat message. The brain decides whether it
 * is a task, an appointment, a memory or just a note. `file: false` keeps it as a note
 * as-is (Palanote Classic). Carries a request ID so an offline outbox can retry it.
 */
export const CaptureMsg = Type.Object({
  type: Type.Literal("capture"),
  text: Type.String({ minLength: 1, maxLength: CAPTURE_WIRE_MAX }),
  requestId: Type.String({ minLength: 1, maxLength: 64 }),
  palId: Type.Optional(Type.String({ maxLength: 64 })),
  /** When it was said, if earlier than now (captured offline). */
  recordedAt: Type.Optional(Type.Number({ minimum: 0 })),
  file: Type.Optional(Type.Boolean()),
  markers: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { maxItems: MARKERS_MAX })),
});
/** Ask for a spoken briefing of today or the week. */
export const BriefMsg = Type.Object({
  type: Type.Literal("brief"),
  scope: StringEnum(BRIEF_SCOPES),
});

export const CharacterMsg = Type.Object({ type: Type.Literal("character"), dna: DnaSchema });
export const ThinkingMsg = Type.Object({ type: Type.Literal("thinking"), on: Type.Boolean() });
export const TurnMsg = Type.Object({
  type: Type.Literal("turn"),
  id: Type.String(),
  turn: TurnSchema,
  needs: NeedsSchema,
});
export const NeedsMsg = Type.Object({ type: Type.Literal("needs"), ...NeedsSchema.properties });
/** Growth stage (M6): 0 baby, 1 kid, 2 grown. Proportions change; identity does not. */
export const GrowthMsg = Type.Object({
  type: Type.Literal("growth"),
  stage: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
});
/** Early mood while a reply is still streaming (M6): the face reacts before the words arrive. */
export const MoodMsg = Type.Object({ type: Type.Literal("mood"), mood: StringEnum(MOODS) });
export const ErrorMsg = Type.Object({
  type: Type.Literal("error"),
  code: Type.String(),
  message: Type.String(),
});

export const ChatMsg = Type.Object({
  type: Type.Literal("chat"),
  line: Type.Object({
    id: Type.Integer(),
    conversationId: Type.String(),
    requestId: Type.Union([Type.String(), Type.Null()]),
    who: StringEnum(["you", "pal", "note"] as const),
    text: Type.String(),
    createdAt: Type.Number(),
  }),
});
export const AckMsg = Type.Object({
  type: Type.Literal("ack"),
  requestId: Type.String(),
  status: StringEnum(["accepted", "done", "rejected"] as const),
});
export const RefreshMsg = Type.Object({ type: Type.Literal("refresh") });
/** A capture was filed. `filed` is a short human summary, e.g. "Task: order the display". */
export const CapturedMsg = Type.Object({
  type: Type.Literal("captured"),
  requestId: Type.String(),
  noteId: Type.Integer(),
  filed: Type.String(),
});
/**
 * The glanceable agenda, compact enough for a small screen (< 1 KB): a few open tasks
 * and the next appointments. Browsers fetch the full list from /api/agenda.
 */
export const AgendaMsg = Type.Object({
  type: Type.Literal("agenda"),
  /** Local date, YYYY-MM-DD. */
  date: Type.String(),
  open: Type.Integer({ minimum: 0 }),
  overdue: Type.Integer({ minimum: 0 }),
  tasks: Type.Array(
    Type.Object({
      id: Type.Integer(),
      text: Type.String(),
      due: Type.Union([Type.Number(), Type.Null()]),
      allDay: Type.Boolean(),
      overdue: Type.Boolean(),
    }),
  ),
  events: Type.Array(Type.Object({ id: Type.Integer(), text: Type.String(), at: Type.Number() })),
});

export const ClientMessageSchema = Type.Union([
  HelloMsg,
  SayMsg,
  TouchMsg,
  CreateMsg,
  CaptureMsg,
  BriefMsg,
]);
export const ServerMessageSchema = Type.Union([
  ChatMsg,
  CapturedMsg,
  AgendaMsg,
  AckMsg,
  RefreshMsg,
  CharacterMsg,
  ThinkingMsg,
  TurnMsg,
  NeedsMsg,
  MoodMsg,
  GrowthMsg,
  ErrorMsg,
]);

export type Caps = Static<typeof CapsSchema>;
export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;

export type AgendaMessage = Static<typeof AgendaMsg>;

const CLIENT_BY_TYPE = {
  hello: HelloMsg,
  say: SayMsg,
  touch: TouchMsg,
  create: CreateMsg,
  capture: CaptureMsg,
  brief: BriefMsg,
};
const SERVER_BY_TYPE = {
  chat: ChatMsg,
  captured: CapturedMsg,
  agenda: AgendaMsg,
  ack: AckMsg,
  refresh: RefreshMsg,
  character: CharacterMsg,
  thinking: ThinkingMsg,
  turn: TurnMsg,
  needs: NeedsMsg,
  mood: MoodMsg,
  growth: GrowthMsg,
  error: ErrorMsg,
};

export type ParseResult<T> =
  | { ok: true; msg: T }
  | { ok: false; code: "too_large" | "bad_json" | "unknown_type" | "invalid"; message: string };

const encoder = new TextEncoder();
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function parseWith<T>(
  text: string,
  table: Record<string, TSchema>,
  maxBytes: number,
): ParseResult<T> {
  if (utf8Length(text) > maxBytes) {
    return { ok: false, code: "too_large", message: `frame exceeds ${maxBytes} bytes` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad_json", message: "frame is not JSON" };
  }
  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
  const schema = typeof type === "string" && Object.hasOwn(table, type) ? table[type] : undefined;
  if (!schema) return { ok: false, code: "unknown_type", message: `unknown type ${String(type)}` };
  if (!Value.Check(schema, raw)) {
    const first = Value.Errors(schema, raw)[0];
    return {
      ok: false,
      code: "invalid",
      message: first ? `${first.instancePath} ${first.message}` : "invalid",
    };
  }
  return { ok: true, msg: raw as T };
}

/** Parse a client → brain frame. Unknown types are reported so the caller can ignore them. */
export function parseClientMessage(text: string): ParseResult<ClientMessage> {
  return parseWith<ClientMessage>(text, CLIENT_BY_TYPE, CLIENT_FRAME_MAX_BYTES);
}

/** Parse a brain → client frame. */
export function parseServerMessage(text: string): ParseResult<ServerMessage> {
  return parseWith<ServerMessage>(text, SERVER_BY_TYPE, Number.MAX_SAFE_INTEGER);
}

const localDate = (ms: number) => new Date(ms).toLocaleDateString("en-CA");

/** The compact agenda for the wire, trimmed until it fits in WIRE_MAX_BYTES. */
export function agendaMessage(agenda: AgendaInfo, now: number): AgendaMessage {
  const msg: AgendaMessage = {
    type: "agenda",
    date: localDate(now),
    open: agenda.tasks.length,
    overdue: agenda.overdue,
    tasks: agenda.tasks.slice(0, AGENDA_WIRE_TASKS).map((t) => ({
      id: t.id,
      text: toText(t.text, AGENDA_WIRE_TEXT),
      due: t.dueAt,
      allDay: t.allDay,
      overdue: isOverdue(t, now),
    })),
    events: agenda.events
      .slice(0, AGENDA_WIRE_EVENTS)
      .map((e) => ({ id: e.id, text: toText(e.text, AGENDA_WIRE_TEXT), at: e.at })),
  };
  while (utf8Length(JSON.stringify(msg)) >= WIRE_MAX_BYTES) {
    if (msg.events.length > 1) msg.events.pop();
    else if (msg.tasks.length > 1) msg.tasks.pop();
    else if (msg.events.length) msg.events.pop();
    else msg.tasks.pop();
  }
  return msg;
}
