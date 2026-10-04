// HTTP session controls and owner-scoped WebSockets share the same serialized service.
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BRIEF_SCOPES,
  CAPTURE_TEXT_MAX,
  CLIENT_FRAME_MAX_BYTES,
  MARKERS_MAX,
  PersonalitySchema,
  StringEnum,
  agendaMessage,
  parseClientMessage,
  type ServerMessage,
} from "@tidbit/protocol";
import { deviceRoutes, type DeviceOptions } from "./device.js";
import { RigStream } from "./rig-stream.js";
import { Scheduler } from "./scheduler.js";
import type { CaptureResult, PalService, TurnResult } from "./service.js";

export interface ServerOptions {
  host: string;
  port: number;
  token?: string;
  requireIdentity?: boolean;
  turnsPerMinute?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  needsTickMs?: number;
  schedulerTickMs?: number;
  /** Speech-to-text and text-to-speech for devices; absent means text only. */
  device?: DeviceOptions;
}
export interface RunningServer {
  port: number;
  scheduler: Scheduler;
  close(): Promise<void>;
  broadcast(msg: ServerMessage): void;
}
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const ManageSchema = Type.Object(
  {
    action: Type.String({ maxLength: 30 }),
    palId: Type.String({ maxLength: 64 }),
    conversationId: Type.Optional(Type.String({ maxLength: 64 })),
    personality: Type.Optional(PersonalitySchema),
    memoryId: Type.Optional(Type.Integer({ minimum: 1 })),
    fact: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
    // Skills and actions are validated in detail by the service.
    skill: Type.Optional(Type.Object({}, { additionalProperties: true })),
    skillMarkdown: Type.Optional(Type.String({ minLength: 1, maxLength: 6000 })),
    httpAction: Type.Optional(Type.Object({}, { additionalProperties: true })),
    itemId: Type.Optional(Type.Integer({ minimum: 1 })),
    enabled: Type.Optional(Type.Boolean()),
    // Tasks: text and an ISO date or local date-time ("2026-10-02", "2026-10-02T17:00").
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    due: Type.Optional(Type.String({ maxLength: 40 })),
  },
  { additionalProperties: false },
);
export const CaptureBodySchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: CAPTURE_TEXT_MAX }),
    requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    palId: Type.Optional(Type.String({ maxLength: 64 })),
    recordedAt: Type.Optional(Type.Number({ minimum: 0 })),
    file: Type.Optional(Type.Boolean()),
    markers: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { maxItems: MARKERS_MAX })),
  },
  { additionalProperties: false },
);
const BriefBodySchema = Type.Object(
  { scope: StringEnum(BRIEF_SCOPES) },
  { additionalProperties: false },
);

export async function startServer(
  service: PalService,
  opts: ServerOptions,
): Promise<RunningServer> {
  const log = opts.log ?? ((m, d) => console.log(`[server] ${m}`, d ?? ""));
  if (!LOOPBACK.has(opts.host) && !opts.token)
    throw new Error(`Refusing to listen on ${opts.host} without PAL_TOKEN (PLAN 5.9).`);
  const app = new Hono();
  // Room for a full skill (4,000 characters, possibly multi-byte).
  // Device audio uploads carry their own, larger limit (see device.ts).
  const AUDIO_ROUTES = new Set(["/api/device/capture", "/api/device/ask"]);
  app.use("/api/*", async (c, next) =>
    AUDIO_ROUTES.has(c.req.path) ? next() : bodyLimit({ maxSize: 16_384 })(c, next),
  );
  // API responses contain personal history and must never be cached by a proxy.
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/health", (c) => c.json({ ok: true, brain: service.brain.name, pal: service.pal.id }));
  /** Sockets that asked the brain to render the pal for them (caps.stream = "rig"). */
  const streams = new WeakMap<WebSocket, RigStream>();
  const send = (ws: WebSocket, msg: ServerMessage) => {
    const stream = streams.get(ws);
    if (stream) return stream.onMessage(msg);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  type Room = {
    service: PalService;
    clients: Set<WebSocket>;
    scheduler: Scheduler;
    lastGrowth: number;
    work: number;
    /** The last agenda sent, so the minute tick only sends changes. */
    lastAgenda: string;
  };
  const rooms = new Map<string, Room>();
  const emit = (room: Room, msg: ServerMessage) => {
    for (const ws of room.clients) send(ws, msg);
  };
  const emitAgenda = (room: Room, onlyChanged = false) => {
    const msg = agendaMessage(room.service.agenda(), room.service.now());
    const json = JSON.stringify(msg);
    if (onlyChanged && json === room.lastAgenda) return;
    room.lastAgenda = json;
    emit(room, msg);
  };
  const deliver = (room: Room, res: TurnResult) => {
    for (const line of res.lines ?? []) emit(room, { type: "chat", line });
    // The pal changed itself: redraw it before it performs, and reload name and settings.
    if (res.dna) {
      emit(room, { type: "character", dna: res.dna });
      emit(room, { type: "refresh" });
    }
    emit(room, { type: "turn", id: res.id, turn: res.turn, needs: res.needs });
    // A turn may have added or finished tasks, or fired a reminder.
    emitAgenda(room);
    const growth = room.service.growth();
    if (growth !== room.lastGrowth) {
      room.lastGrowth = growth;
      emit(room, { type: "growth", stage: growth as 0 | 1 | 2 });
    }
  };
  function roomFor(ownerId?: string): Room {
    const key = ownerId ?? "legacy";
    let room = rooms.get(key);
    if (room) return room;
    const scoped = ownerId ? service.forOwner(ownerId) : service;
    room = {
      service: scoped,
      clients: new Set(),
      lastGrowth: scoped.growth(),
      work: 0,
      lastAgenda: "",
      scheduler: null as unknown as Scheduler,
    };
    const created = room;
    room.scheduler = new Scheduler(scoped, {
      hasClients: () => created.clients.size > 0,
      deliver: (result) => deliver(created, result),
      tickMs: opts.schedulerTickMs ?? 1000,
      log,
    });
    if (opts.schedulerTickMs !== 0) room.scheduler.start();
    rooms.set(key, room);
    return room;
  }
  const legacy = roomFor();
  function authenticated(c: Context): Room | null {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
    const ownerId = token ? service.companions.owner(token) : undefined;
    return ownerId ? roomFor(ownerId) : null;
  }
  const attempts = new Map<string, { count: number; at: number }>();
  function allow(key: string, max: number): boolean {
    const now = Date.now();
    for (const [id, value] of attempts) if (now - value.at > 60_000) attempts.delete(id);
    const entry = attempts.get(key) ?? { count: 0, at: now };
    entry.count++;
    attempts.set(key, entry);
    return entry.count <= max;
  }
  /** File a capture, show the pal's nod everywhere, and refresh the agenda. */
  async function runCapture(
    room: Room,
    req: Parameters<PalService["capture"]>[0],
  ): Promise<CaptureResult> {
    room.work++;
    emit(room, { type: "thinking", on: true });
    try {
      const res = await room.service.capture(req);
      if (!res.replayed) {
        if (res.turn)
          emit(room, { type: "turn", id: res.turn.id, turn: res.turn.turn, needs: res.turn.needs });
        emitAgenda(room);
      }
      if (req.requestId)
        emit(room, {
          type: "captured",
          requestId: req.requestId,
          noteId: res.noteId,
          filed: res.summary.slice(0, 400),
        });
      return { ...res, turn: undefined };
    } finally {
      room.work--;
      emit(room, { type: "thinking", on: room.work > 0 });
    }
  }
  async function runBrief(room: Room, scope: (typeof BRIEF_SCOPES)[number]): Promise<TurnResult> {
    room.work++;
    emit(room, { type: "thinking", on: true });
    try {
      const res = await room.service.brief(scope);
      deliver(room, res);
      return res;
    } finally {
      room.work--;
      emit(room, { type: "thinking", on: room.work > 0 });
    }
  }
  deviceRoutes(app, {
    service,
    options: opts.device ?? {},
    authenticated: (c) => authenticated(c)?.service,
    allow,
    capture: (owner, req) => runCapture(roomFor(owner.ownerId), req),
    brief: (owner, scope) => runBrief(roomFor(owner.ownerId), scope),
    ask: async (owner, text) => {
      const room = roomFor(owner.ownerId);
      room.work++;
      emit(room, { type: "thinking", on: true });
      try {
        const res = await room.service.turn({ kind: "say", text });
        deliver(room, res);
        return res;
      } finally {
        room.work--;
        emit(room, { type: "thinking", on: room.work > 0 });
      }
    },
  });

  app.post("/api/bootstrap", async (c) => {
    const provided = c.req.header("Authorization");
    if (provided) {
      const room = authenticated(c);
      if (!room)
        return c.json({ error: "Device identity is invalid. Pair this browser again." }, 401);
      return c.json({ state: await room.service.snapshot() });
    }
    if (!allow("bootstrap", 30)) return c.json({ error: "Try again in a minute." }, 429);
    const identity = service.companions.createOwner();
    return c.json({ identity, state: await roomFor(identity.ownerId).service.snapshot() });
  });
  app.post("/api/pair/redeem", async (c) => {
    if (!allow("pair", 10))
      return c.json({ error: "Too many pairing attempts. Try again in a minute." }, 429);
    try {
      const raw = (await c.req.json()) as { code?: unknown };
      if (typeof raw.code !== "string" || !/^[A-Fa-f0-9]{5}-?[A-Fa-f0-9]{5}$/.test(raw.code.trim()))
        return c.json({ error: "Enter the 10-character pairing code." }, 400);
      const identity = service.companions.redeem(raw.code.trim(), Date.now());
      return c.json({ identity, state: await roomFor(identity.ownerId).service.snapshot() });
    } catch {
      return c.json({ error: "Pairing code is invalid or expired." }, 400);
    }
  });
  app.use("/api/*", async (c, next) => {
    if (!authenticated(c)) return c.json({ error: "Pair or reconnect this device first." }, 401);
    await next();
  });
  app.get("/api/state", async (c) => c.json(await authenticated(c)!.service.snapshot()));
  app.get("/api/history", (c) => {
    const room = authenticated(c)!;
    const before = Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before <= 0)
      return c.json({ error: "Invalid history cursor." }, 400);
    try {
      return c.json(
        room.service.history(c.req.query("conversation") ?? room.service.conversationId, before),
      );
    } catch {
      return c.json({ error: "Conversation not found." }, 404);
    }
  });
  app.get("/api/memories", (c) => {
    const before = Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before <= 0)
      return c.json({ error: "Invalid memory cursor." }, 400);
    return c.json(authenticated(c)!.service.memories(before));
  });
  app.get("/api/abilities", (c) => c.json(authenticated(c)!.service.abilitiesState()));
  app.get("/api/agenda", (c) => c.json(authenticated(c)!.service.agenda()));
  app.get("/api/notes", (c) => {
    const before = Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before <= 0)
      return c.json({ error: "Invalid notes cursor." }, 400);
    const query = (c.req.query("q") ?? "").slice(0, 200);
    return c.json(authenticated(c)!.service.notesList({ before, query }));
  });
  /** Capture over HTTP: longer notes, and clients without a socket (devices, shortcuts). */
  app.post("/api/capture", async (c) => {
    const room = authenticated(c)!;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Send the note as JSON." }, 400);
    }
    if (!Value.Check(CaptureBodySchema, raw))
      return c.json({ error: "Check the note and try again." }, 400);
    if (!allow(`capture:${room.service.ownerId}`, opts.turnsPerMinute ?? 20))
      return c.json({ error: "Slow down a little. Try again in a minute." }, 429);
    try {
      return c.json(await runCapture(room, { ...raw, source: "browser" }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.post("/api/brief", async (c) => {
    const room = authenticated(c)!;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    if (!Value.Check(BriefBodySchema, raw))
      return c.json({ error: "Ask for a day or week briefing." }, 400);
    if (!allow(`brief:${room.service.ownerId}`, opts.turnsPerMinute ?? 20))
      return c.json({ error: "Slow down a little. Try again in a minute." }, 429);
    const res = await runBrief(room, raw.scope);
    return c.json({ id: res.id, turn: res.turn, text: res.lines?.at(-1)?.text ?? "" });
  });
  app.post("/api/pair", (c) => {
    const room = authenticated(c)!;
    return c.json(service.companions.pair(room.service.ownerId, Date.now()));
  });
  app.post("/api/manage", async (c) => {
    const room = authenticated(c)!;
    try {
      const raw = await c.req.json();
      if (!Value.Check(ManageSchema, raw))
        return c.json({ error: "Check the values and try again." }, 400);
      await room.service.manage(raw);
      const state = await room.service.snapshot();
      emit(room, { type: "refresh" });
      emit(room, { type: "character", dna: state.dna });
      emit(room, { type: "growth", stage: state.growth as 0 | 1 | 2 });
      emit(room, { type: "needs", ...state.needs });
      emitAgenda(room);
      return c.json(state);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  const http = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port });
  await new Promise<void>((resolve, reject) => {
    http.once("listening", resolve);
    http.once("error", reject);
  });
  const wss = new WebSocketServer({
    server: http as never,
    path: "/ws",
    maxPayload: CLIENT_FRAME_MAX_BYTES,
  });
  const sockets = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    sockets.add(ws);
    let room: Room | null = null;
    let helloing = false;
    const turnTimes: number[] = [];
    const helloTimer = setTimeout(() => !room && ws.close(4001, "hello timeout"), 10_000);
    ws.on("message", async (data, isBinary) => {
      if (isBinary) return send(ws, { type: "error", code: "binary", message: "text frames only" });
      const text = data.toString();
      const stream = streams.get(ws);
      // A streaming screen reports where the finger is so the pal can watch it.
      if (stream && text.startsWith('{"type":"attend"')) {
        try {
          const { x, y } = JSON.parse(text) as { x?: unknown; y?: unknown };
          stream.attend(typeof x === "number" ? x : null, typeof y === "number" ? y : 0);
        } catch {
          /* ignore */
        }
        return;
      }
      // …and when its screen turns off for lack of company, or back on.
      if (stream && text.startsWith('{"type":"rest"')) {
        try {
          stream.rest((JSON.parse(text) as { on?: unknown }).on === true);
        } catch {
          /* ignore */
        }
        return;
      }
      const parsed = parseClientMessage(text);
      if (!parsed.ok) {
        if (parsed.code !== "unknown_type")
          send(ws, { type: "error", code: parsed.code, message: parsed.message });
        return;
      }
      const msg = parsed.msg;
      try {
        if (msg.type === "hello") {
          if (room || helloing)
            return send(ws, {
              type: "error",
              code: "already_connected",
              message: "Already connected.",
            });
          if (opts.token && msg.token !== opts.token) {
            send(ws, { type: "error", code: "unauthorized", message: "bad token" });
            ws.close(4003, "unauthorized");
            return;
          }
          const ownerId = msg.ownerToken ? service.companions.owner(msg.ownerToken) : undefined;
          if ((msg.ownerToken && !ownerId) || (opts.requireIdentity && !ownerId)) {
            send(ws, { type: "error", code: "unauthorized", message: "Pair this device again." });
            ws.close(4003, "unauthorized");
            return;
          }
          helloing = true;
          room = roomFor(ownerId);
          clearTimeout(helloTimer);
          if (msg.caps.stream === "rig") {
            const owner = room.service;
            streams.set(
              ws,
              new RigStream(ws, { fps: msg.caps.fps, snapshot: () => owner.snapshot() }),
            );
          }
          room.clients.add(ws);
          const state = await room.service.snapshot();
          send(ws, { type: "character", dna: state.dna });
          send(ws, { type: "growth", stage: state.growth as 0 | 1 | 2 });
          send(ws, { type: "needs", ...state.needs });
          send(ws, agendaMessage(room.service.agenda(), room.service.now()));
          if (ownerId) send(ws, { type: "refresh" });
          if (room.work > 0) send(ws, { type: "thinking", on: true });
          room.scheduler.noteContact();
          return;
        }
        if (!room)
          return send(ws, { type: "error", code: "hello_first", message: "send hello first" });
        const active = room;
        const scoped = active.service;
        if (msg.type === "touch") {
          streams.get(ws)?.touch(msg.kind);
          const needs = await scoped.touch(msg.kind);
          emit(active, { type: "needs", ...needs });
          const growth = scoped.growth();
          if (growth !== active.lastGrowth) {
            active.lastGrowth = growth;
            emit(active, { type: "growth", stage: growth as 0 | 1 | 2 });
          }
          return;
        }
        if (msg.type === "create") {
          active.work++;
          emit(active, { type: "thinking", on: true });
          try {
            const dna = msg.dna
              ? await scoped.adoptShared(msg.dna)
              : await scoped.create(msg.prompt);
            emit(active, { type: "character", dna });
            active.lastGrowth = scoped.growth();
            emit(active, { type: "growth", stage: active.lastGrowth as 0 | 1 | 2 });
            emit(active, { type: "needs", ...(await scoped.needs()) });
            emit(active, { type: "refresh" });
          } finally {
            active.work--;
            emit(active, { type: "thinking", on: active.work > 0 });
          }
          return;
        }
        if (msg.type === "capture" || msg.type === "brief") {
          const now = Date.now();
          while (turnTimes.length && now - turnTimes[0]! > 60_000) turnTimes.shift();
          const replay =
            msg.type === "capture" && !!scoped.notes.noteByRequest(scoped.ownerId, msg.requestId);
          if (!replay && turnTimes.length >= (opts.turnsPerMinute ?? 20)) {
            if (msg.type === "capture")
              send(ws, { type: "ack", requestId: msg.requestId, status: "rejected" });
            return send(ws, {
              type: "error",
              code: "rate_limited",
              message: "Slow down a little. Try again in a minute.",
            });
          }
          if (!replay) turnTimes.push(now);
          if (msg.type === "brief") {
            await runBrief(active, msg.scope);
            return;
          }
          send(ws, { type: "ack", requestId: msg.requestId, status: "accepted" });
          try {
            await runCapture(active, {
              text: msg.text,
              requestId: msg.requestId,
              palId: msg.palId,
              recordedAt: msg.recordedAt,
              file: msg.file,
              markers: msg.markers,
              source: "browser",
            });
            send(ws, { type: "ack", requestId: msg.requestId, status: "done" });
          } catch (e) {
            send(ws, { type: "ack", requestId: msg.requestId, status: "rejected" });
            send(ws, { type: "error", code: "capture_failed", message: (e as Error).message });
          }
          return;
        }
        if (msg.type === "say") {
          const saved = msg.requestId
            ? scoped.companions.request(scoped.ownerId, msg.requestId)
            : undefined;
          const now = Date.now();
          while (turnTimes.length && now - turnTimes[0]! > 60_000) turnTimes.shift();
          if (!saved && turnTimes.length >= (opts.turnsPerMinute ?? 20)) {
            if (msg.requestId)
              send(ws, { type: "ack", requestId: msg.requestId, status: "rejected" });
            return send(ws, {
              type: "error",
              code: "rate_limited",
              message: "Slow down a little. Your message was not sent.",
            });
          }
          if (!saved) turnTimes.push(now);
          if (msg.requestId && (!msg.palId || !msg.conversationId)) {
            send(ws, { type: "ack", requestId: msg.requestId, status: "rejected" });
            return send(ws, {
              type: "error",
              code: "invalid",
              message: "Message needs its pal and conversation.",
            });
          }
          if (msg.requestId)
            send(ws, { type: "ack", requestId: msg.requestId, status: "accepted" });
          active.work++;
          emit(active, { type: "thinking", on: true });
          try {
            const hooks = {
              onEarlyMood: (
                mood: Parameters<NonNullable<import("./brain.js").TurnContext["onEarlyMood"]>>[0],
              ) => emit(active, { type: "mood", mood }),
            };
            const res = msg.requestId
              ? await scoped.sayOnce(
                  {
                    requestId: msg.requestId,
                    text: msg.text,
                    palId: msg.palId!,
                    conversationId: msg.conversationId!,
                  },
                  hooks,
                )
              : await scoped.turn({ kind: "say", text: msg.text }, [], hooks);
            if (res.replayed) {
              for (const line of res.lines ?? []) send(ws, { type: "chat", line });
            } else deliver(active, res);
            if (msg.requestId) send(ws, { type: "ack", requestId: msg.requestId, status: "done" });
          } catch (e) {
            if (msg.requestId)
              send(ws, { type: "ack", requestId: msg.requestId, status: "rejected" });
            send(ws, { type: "error", code: "send_failed", message: (e as Error).message });
          } finally {
            active.work--;
            emit(active, { type: "thinking", on: active.work > 0 });
          }
        }
      } catch (e) {
        log("handler error", { error: (e as Error).message });
        send(ws, { type: "error", code: "internal", message: "something went wrong" });
      }
    });
    const remove = () => {
      clearTimeout(helloTimer);
      sockets.delete(ws);
      room?.clients.delete(ws);
      streams.get(ws)?.close();
      streams.delete(ws);
    };
    ws.on("close", remove);
    ws.on("error", remove);
  });
  let ticking = false;
  const ticker = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const room of rooms.values())
        if (room.clients.size) {
          emit(room, { type: "needs", ...(await room.service.needs()) });
          // Tasks turn overdue and days change without anyone touching them.
          emitAgenda(room, true);
        }
    } catch (e) {
      log("needs tick failed", { error: (e as Error).message });
    } finally {
      ticking = false;
    }
  }, opts.needsTickMs ?? 60_000);
  const port = (http.address() as AddressInfo).port;
  log("listening", { url: `http://${opts.host}:${port}`, brain: service.brain.name });
  return {
    port,
    scheduler: legacy.scheduler,
    broadcast: (msg) => emit(legacy, msg),
    close: async () => {
      clearInterval(ticker);
      for (const room of rooms.values()) room.scheduler.stop();
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
