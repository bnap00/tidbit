// Device API (PLAN M7): what a small screen with buttons and a microphone needs, such as
// the Waveshare ESP32-S3-Touch-AMOLED-1.8. Pairing shows a code on the device that the
// owner enters in the browser; captures and questions arrive as text or audio, and
// replies can be fetched as speech. Speech-to-text and text-to-speech are any
// OpenAI-compatible server (faster-whisper, whisper.cpp, Kokoro-FastAPI, OpenAI).
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  BRIEF_SCOPES,
  CAPTURE_TEXT_MAX,
  KOKORO_VOICES,
  MARKERS_MAX,
  agendaMessage,
  toText,
  type BriefScope,
} from "@tidbit/protocol";
import type { CaptureRequest, CaptureResult, PalService, TurnResult } from "./service.js";

export interface SpeechServer {
  /** Base URL of an OpenAI-compatible API, e.g. http://127.0.0.1:8000/v1 */
  url: string;
  key?: string;
  model?: string;
}

export interface DeviceOptions {
  /** Speech-to-text: POST {url}/audio/transcriptions. Without it, devices send text. */
  stt?: SpeechServer;
  /** Text-to-speech: POST {url}/audio/speech. Without it, devices show text only. */
  tts?: SpeechServer;
  fetch?: typeof fetch;
  /** Largest audio upload. 16 kHz 16-bit mono WAV is 32 KB a second. */
  audioMaxBytes?: number;
}

export interface DeviceDeps {
  service: PalService;
  options: DeviceOptions;
  /** The owner's service for a request's bearer token. */
  authenticated(c: Context): PalService | undefined;
  allow(key: string, max: number): boolean;
  capture(owner: PalService, req: CaptureRequest): Promise<CaptureResult>;
  brief(owner: PalService, scope: BriefScope): Promise<TurnResult>;
  ask(owner: PalService, text: string): Promise<TurnResult>;
}

export const DEVICE_CODE_TTL_MS = 10 * 60_000;
export const AUDIO_MAX_BYTES = 8 * 1024 * 1024;
const SPEAK_MAX = 1000;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

interface PendingDevice {
  name: string;
  pollHash: string;
  expiresAt: number;
  approved?: { ownerId: string; token: string };
}

const DeviceNameSchema = Type.Object(
  { name: Type.Optional(Type.String({ maxLength: 40 })) },
  { additionalProperties: false },
);
const PollSchema = Type.Object(
  { pollToken: Type.String({ minLength: 32, maxLength: 128 }) },
  { additionalProperties: false },
);
const ApproveSchema = Type.Object(
  { code: Type.String({ minLength: 6, maxLength: 7 }) },
  { additionalProperties: false },
);
const SpeakSchema = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: SPEAK_MAX }) },
  { additionalProperties: false },
);
const AskSchema = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 1000 }) },
  { additionalProperties: false },
);
const BriefSchema = Type.Object({ scope: Type.Optional(Type.String()) });

/** Paired devices, so the owner can see and revoke them. Tokens live in owner_tokens. */
class DeviceStore {
  constructor(private readonly service: PalService) {
    service.companions.store.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL REFERENCES owners(id),
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER
      );
    `);
  }
  private get db() {
    return this.service.companions.store.db;
  }
  add(ownerId: string, name: string, tokenHash: string, now: number): void {
    this.db
      .prepare("INSERT INTO devices (owner_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(ownerId, name, tokenHash, now);
  }
  seen(token: string, now: number): void {
    this.db.prepare("UPDATE devices SET last_seen = ? WHERE token_hash = ?").run(now, sha(token));
  }
  list(ownerId: string) {
    return this.db
      .prepare(
        "SELECT id, name, created_at AS createdAt, last_seen AS lastSeen FROM devices WHERE owner_id = ? ORDER BY id",
      )
      .all(ownerId) as { id: number; name: string; createdAt: number; lastSeen: number | null }[];
  }
  revoke(ownerId: string, id: number): boolean {
    const row = this.db
      .prepare("SELECT token_hash AS hash FROM devices WHERE owner_id = ? AND id = ?")
      .get(ownerId, id) as { hash: string } | undefined;
    if (!row) return false;
    this.service.companions.revokeCredential(row.hash, ownerId);
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    return true;
  }
}

/** Speech-to-text through an OpenAI-compatible /audio/transcriptions endpoint. */
export async function transcribe(
  server: SpeechServer,
  audio: Uint8Array,
  type: string,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  const ext = /wav/.test(type)
    ? "wav"
    : /ogg|opus/.test(type)
      ? "ogg"
      : /mpeg|mp3/.test(type)
        ? "mp3"
        : /webm/.test(type)
          ? "webm"
          : "wav";
  form.append("file", new Blob([audio], { type }), `capture.${ext}`);
  form.append("model", server.model ?? "whisper-1");
  form.append("response_format", "json");
  const res = await doFetch(`${server.url.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: server.key ? { Authorization: `Bearer ${server.key}` } : {},
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`speech-to-text failed (${res.status})`);
  const data = (await res.json()) as { text?: unknown };
  return toText(data.text, CAPTURE_TEXT_MAX);
}

function headerMarkers(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const markers = value
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .slice(0, MARKERS_MAX);
  return markers.length ? markers : undefined;
}

export function deviceRoutes(app: Hono, deps: DeviceDeps): void {
  const { options } = deps;
  const doFetch = options.fetch ?? fetch;
  const devices = new DeviceStore(deps.service);
  // Pairing codes waiting for the owner, keyed by code. Lost on restart; the device retries.
  const pending = new Map<string, PendingDevice>();
  const sweep = (now: number) => {
    for (const [code, p] of pending) if (p.expiresAt <= now) pending.delete(code);
  };
  const owner = (c: Context) => {
    const service = deps.authenticated(c);
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
    if (service && token) devices.seen(token, Date.now());
    return service;
  };
  const unauthorized = (c: Context) =>
    c.json({ error: "Pair this device first." }, 401) as Response;
  async function json(c: Context): Promise<unknown> {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  }
  /** Text from a request body: plain text, or audio through speech-to-text. */
  async function bodyText(
    c: Context,
  ): Promise<{ text: string } | { error: string; status: 400 | 413 | 503 }> {
    const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type.startsWith("audio/") || type === "application/octet-stream") {
      if (!options.stt)
        return { error: "Speech-to-text is not set up on the brain (PAL_STT_URL).", status: 503 };
      const audio = new Uint8Array(await c.req.arrayBuffer());
      if (!audio.length) return { error: "The recording is empty.", status: 400 };
      const text = await transcribe(
        options.stt,
        audio,
        type === "application/octet-stream" ? "audio/wav" : type,
        doFetch,
      );
      return text ? { text } : { error: "I couldn't hear any words in that.", status: 400 };
    }
    if (type === "application/json") {
      const raw = (await json(c)) as { text?: unknown } | undefined;
      const text = typeof raw?.text === "string" ? raw.text.trim() : "";
      return text ? { text } : { error: "Send text or audio.", status: 400 };
    }
    const text = (await c.req.text()).trim();
    return text ? { text } : { error: "Send text or audio.", status: 400 };
  }

  // --- pairing: the device shows a code, the owner enters it in the browser --------

  app.post("/api/device/pair/start", async (c) => {
    if (!deps.allow("device-pair", 10))
      return c.json({ error: "Too many pairing attempts. Try again in a minute." }, 429);
    const raw = (await json(c)) ?? {};
    if (!Value.Check(DeviceNameSchema, raw)) return c.json({ error: "Invalid device name." }, 400);
    const now = Date.now();
    sweep(now);
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while (pending.has(code));
    const pollToken = randomBytes(32).toString("hex");
    pending.set(code, {
      name: toText(raw.name, 40) || "Device",
      pollHash: sha(pollToken),
      expiresAt: now + DEVICE_CODE_TTL_MS,
    });
    return c.json({ code, pollToken, expiresAt: now + DEVICE_CODE_TTL_MS });
  });

  app.post("/api/device/pair/poll", async (c) => {
    const raw = await json(c);
    if (!Value.Check(PollSchema, raw)) return c.json({ error: "Invalid poll token." }, 400);
    const now = Date.now();
    sweep(now);
    const hit = [...pending].find(([, p]) => p.pollHash === sha(raw.pollToken));
    if (!hit) return c.json({ status: "expired" }, 404);
    const [code, p] = hit;
    if (!p.approved) return c.json({ status: "pending", expiresAt: p.expiresAt });
    pending.delete(code);
    return c.json({ status: "paired", ...p.approved });
  });

  app.post("/api/device/pair/approve", async (c) => {
    const service = owner(c);
    if (!service) return unauthorized(c);
    if (!deps.allow(`device-approve:${service.ownerId}`, 10))
      return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    const raw = await json(c);
    if (!Value.Check(ApproveSchema, raw))
      return c.json({ error: "Enter the 6-digit code shown on the device." }, 400);
    const code = raw.code.replace(/\D/g, "");
    const now = Date.now();
    sweep(now);
    const p = pending.get(code);
    if (!p || p.approved)
      return c.json({ error: "That code is not waiting. Check the device and try again." }, 400);
    const identity = service.companions.deviceCredential(service.ownerId);
    devices.add(service.ownerId, p.name, identity.hash, now);
    p.approved = { ownerId: identity.ownerId, token: identity.token };
    return c.json({ ok: true, name: p.name });
  });

  app.get("/api/devices", (c) => {
    const service = owner(c);
    if (!service) return unauthorized(c);
    return c.json(devices.list(service.ownerId));
  });

  app.post("/api/devices/revoke", async (c) => {
    const service = owner(c);
    if (!service) return unauthorized(c);
    const raw = (await json(c)) as { id?: unknown } | undefined;
    if (!Number.isSafeInteger(raw?.id) || !devices.revoke(service.ownerId, raw!.id as number))
      return c.json({ error: "Device not found." }, 404);
    return c.json({ ok: true });
  });

  // --- what the device shows and does -----------------------------------------------

  /** Everything the home screen needs in one small response. Battery is the device's own. */
  app.get("/api/device/home", async (c) => {
    const service = owner(c);
    if (!service) return unauthorized(c);
    const state = await service.snapshot();
    const now = service.now();
    return c.json({
      now,
      offsetMinutes: -new Date(now).getTimezoneOffset(),
      pal: { id: state.dna.id, name: state.dna.name, mood: state.mood, growth: state.growth },
      dna: state.dna,
      needs: state.needs,
      agenda: agendaMessage(service.agenda(), now),
      speech: { stt: !!options.stt, tts: !!options.tts },
    });
  });

  /**
   * The capture button. Body: text/plain, JSON {text}, or audio (audio/wav, audio/ogg).
   * Headers: X-Request-Id (retry-safe), X-Recorded-At (epoch ms when it was said),
   * X-Markers ("12.5,40" seconds), X-File: 0 to keep it as a plain note.
   */
  app.post(
    "/api/device/capture",
    bodyLimit({
      maxSize: options.audioMaxBytes ?? AUDIO_MAX_BYTES,
      onError: (c) => c.json({ error: "That recording is too long." }, 413),
    }),
    async (c) => {
      const service = owner(c);
      if (!service) return unauthorized(c);
      if (!deps.allow(`device-capture:${service.ownerId}`, 30))
        return c.json({ error: "Slow down a little. Try again in a minute." }, 429);
      const requestId = c.req.header("X-Request-Id")?.slice(0, 64) || undefined;
      try {
        const body = await bodyText(c);
        if ("error" in body) return c.json({ error: body.error }, body.status);
        const recordedAt = Number(c.req.header("X-Recorded-At"));
        const res = await deps.capture(service, {
          text: body.text.slice(0, CAPTURE_TEXT_MAX),
          source: "device",
          requestId,
          ...(Number.isFinite(recordedAt) && recordedAt > 0 ? { recordedAt } : {}),
          file: c.req.header("X-File") !== "0",
          markers: headerMarkers(c.req.header("X-Markers")),
        });
        return c.json({
          noteId: res.noteId,
          filed: res.filed,
          summary: res.summary,
          transcript: body.text,
          replayed: !!res.replayed,
        });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    },
  );

  /** The ask button: a question by text or audio, answered in the current conversation. */
  app.post(
    "/api/device/ask",
    bodyLimit({
      maxSize: options.audioMaxBytes ?? AUDIO_MAX_BYTES,
      onError: (c) => c.json({ error: "That recording is too long." }, 413),
    }),
    async (c) => {
      const service = owner(c);
      if (!service) return unauthorized(c);
      if (!deps.allow(`device-ask:${service.ownerId}`, 20))
        return c.json({ error: "Slow down a little. Try again in a minute." }, 429);
      try {
        const body = await bodyText(c);
        if ("error" in body) return c.json({ error: body.error }, body.status);
        if (!Value.Check(AskSchema, { text: body.text.slice(0, 1000) }))
          return c.json({ error: "Ask something shorter." }, 400);
        const res = await deps.ask(service, body.text.slice(0, 1000));
        return c.json({
          question: body.text,
          text: res.turn.beats
            .map((b) => b.say)
            .filter(Boolean)
            .join(" "),
          turn: res.turn,
        });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    },
  );

  /** Double-press briefings: {"scope":"day"} or {"scope":"week"}. */
  app.post("/api/device/brief", async (c) => {
    const service = owner(c);
    if (!service) return unauthorized(c);
    const raw = (await json(c)) ?? {};
    const scope = Value.Check(BriefSchema, raw) && raw.scope === "week" ? "week" : "day";
    if (!(BRIEF_SCOPES as readonly string[]).includes(scope))
      return c.json({ error: "Ask for a day or week briefing." }, 400);
    if (!deps.allow(`device-brief:${service.ownerId}`, 20))
      return c.json({ error: "Slow down a little. Try again in a minute." }, 429);
    const res = await deps.brief(service, scope);
    return c.json({
      text: res.turn.beats
        .map((b) => b.say)
        .filter(Boolean)
        .join(" "),
      turn: res.turn,
    });
  });

  /** The pal's words as speech, in its own voice. Returns audio/wav for the speaker. */
  app.post("/api/device/speak", async (c) => {
    const service = owner(c);
    if (!service) return unauthorized(c);
    if (!options.tts)
      return c.json({ error: "Text-to-speech is not set up on the brain (PAL_TTS_URL)." }, 503);
    const raw = await json(c);
    if (!Value.Check(SpeakSchema, raw)) return c.json({ error: "Send {text}." }, 400);
    if (!deps.allow(`device-speak:${service.ownerId}`, 60))
      return c.json({ error: "Slow down a little. Try again in a minute." }, 429);
    const voice = service.pal.voice;
    const res = await doFetch(`${options.tts.url.replace(/\/+$/, "")}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.tts.key ? { Authorization: `Bearer ${options.tts.key}` } : {}),
      },
      body: JSON.stringify({
        model: options.tts.model ?? "kokoro",
        input: raw.text,
        voice: KOKORO_VOICES[voice.timbre],
        response_format: "wav",
        // The same tempo as the browser's Kokoro voice.
        speed: 0.85 + voice.speed * 0.04,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body)
      return c.json({ error: `Text-to-speech failed (${res.status}).` }, 502);
    return new Response(res.body, {
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "audio/wav" },
    });
  });
}
