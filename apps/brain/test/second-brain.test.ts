// The second brain (PLAN M7): captures file themselves, notes answer questions later,
// the agenda and briefings, and the device API. Never calls a real LLM or the network.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai";
import {
  WIRE_MAX_BYTES,
  agendaMessage,
  normalizeTriage,
  parseServerMessage,
  utf8Length,
  type AgendaInfo,
  type ServerMessage,
} from "@tidbit/protocol";
import type { Brain } from "../src/brain.js";
import { PiBrain } from "../src/pi/pi-brain.js";
import { ScriptedBrain, factBeats } from "../src/scripted-brain.js";
import { briefingFacts, scriptedTriage, spokenWhen, tidy } from "../src/second-brain.js";
import { startServer } from "../src/server.js";
import { PalService } from "../src/service.js";
import { Store } from "../src/store.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// Thursday 1 October 2026, 09:30 local time.
const NOW = new Date(2026, 9, 1, 9, 30);
const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();

function service(brain: Brain = new ScriptedBrain(), clock = () => NOW.getTime()) {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  return { store, service: new PalService(store, brain, { clock }) };
}

describe("spoken dates", () => {
  it("resolves days, weekdays, dates and times relative to now", () => {
    expect(spokenWhen("I need to do this today", NOW)).toEqual({ at: at(1), allDay: true });
    expect(spokenWhen("tomorrow", NOW)).toEqual({ at: at(2), allDay: true });
    expect(spokenWhen("on Friday", NOW)).toEqual({ at: at(2), allDay: true });
    expect(spokenWhen("next wednesday", NOW)).toEqual({ at: at(7), allDay: true });
    expect(spokenWhen("thursday", NOW)).toEqual({ at: at(8), allDay: true });
    expect(spokenWhen("dentist on the 29th at 10am", NOW)).toEqual({
      at: new Date(2026, 9, 29, 10).getTime(),
      allDay: false,
    });
    // A date already past this month means next month.
    expect(spokenWhen("on the 1st", new Date(2026, 9, 2))).toEqual({
      at: new Date(2026, 10, 1).getTime(),
      allDay: true,
    });
    expect(spokenWhen("walk the dog at 5", NOW)).toEqual({ at: at(1, 17), allDay: false });
    expect(spokenWhen("by 17:30", NOW)).toEqual({ at: at(1, 17, 30), allDay: false });
    // A time already gone today is tomorrow.
    expect(spokenWhen("at 8am", NOW)).toEqual({ at: at(2, 8), allDay: false });
    expect(spokenWhen("in 2 hours", NOW)).toEqual({ at: NOW.getTime() + 7_200_000, allDay: false });
    expect(spokenWhen("an idea for the watering tank", NOW)).toBeUndefined();
  });
});

describe("offline triage", () => {
  it("files the video's example: a task said, then its day said separately", () => {
    const t = scriptedTriage(
      "I need to order the display for the newest project. Uh, I need to do this today.",
      NOW,
    );
    expect(t.items).toEqual([
      { kind: "task", text: "Order the display for the newest project", when: at(1), allDay: true },
    ]);
    expect(t.clean).not.toMatch(/\buh\b/i);
  });

  it("finds appointments, several tasks and facts in one capture", () => {
    const t = scriptedTriage(
      "Dentist appointment on the 29th at 10am. Buy filament. I have to clean the CNC by Friday. My dog is called Lenny.",
      NOW,
    );
    expect(t.items).toEqual([
      {
        kind: "appointment",
        text: "Dentist appointment",
        when: new Date(2026, 9, 29, 10).getTime(),
        allDay: false,
      },
      { kind: "task", text: "Buy filament" },
      { kind: "task", text: "Clean the CNC", when: at(2), allDay: true },
      { kind: "memory", text: "The user's dog is Lenny" },
    ]);
  });

  it("keeps a passing thought as a plain note", () => {
    const t = scriptedTriage(
      "The watering tank should be see-through so I can watch the water level.",
      NOW,
    );
    expect(t.items).toEqual([]);
    expect(t.clean).toBe("The watering tank should be see-through so I can watch the water level.");
  });

  it("tidies speech without losing words", () => {
    expect(tidy("um so the the tank uh should be clear")).toBe("So the tank should be clear.");
  });

  it("repairs a model's triage: no time means a task, junk is dropped", () => {
    const t = normalizeTriage(
      {
        clean: "",
        items: [
          { kind: "appointment", text: "Meeting", when: "2026-10-02" },
          { kind: "memory", text: "Likes tea", when: "2026-10-02T10:00:00+02:00" },
          { kind: "bogus", text: "Call mum", when: "nonsense" },
          { kind: "task", text: "" },
          null,
        ],
      },
      "raw text",
    );
    expect(t.clean).toBe("raw text");
    expect(t.items).toEqual([
      { kind: "task", text: "Meeting", when: at(2), allDay: true },
      { kind: "memory", text: "Likes tea" },
      { kind: "task", text: "Call mum" },
    ]);
  });
});

describe("capture, recall and the agenda", () => {
  it("files a capture once, finds it later, and replays retries", async () => {
    const { service: s, store } = service();
    const said =
      "I need to order the display for the newest project. I need to do this today. Meeting with Sam tomorrow at 3pm.";
    const res = await s.capture({ text: said, source: "browser", requestId: "req-1" });
    expect(res.filed).toEqual([
      expect.stringMatching(/^task #\d+$/),
      expect.stringMatching(/^appointment #\d+$/),
    ]);
    expect(res.summary).toBe(
      "Task: Order the display for the newest project (today) · Appointment: Meeting with Sam (tomorrow 15:00)",
    );
    expect(res.turn?.turn.beats[0]).toMatchObject({ mood: "proud", action: "nod" });
    const again = await s.capture({ text: said, source: "browser", requestId: "req-1" });
    expect(again).toMatchObject({ replayed: true, noteId: res.noteId });
    expect(s.notes.openTasks(s.pal.id)).toHaveLength(1);
    expect(store.pendingReminders(s.pal.id)).toHaveLength(1);
    await expect(
      s.capture({ text: "something else", source: "browser", requestId: "req-1" }),
    ).rejects.toThrow(/another note/);

    // A plain thought stays a note, and a later question finds it.
    await s.capture({
      text: "Change the watering tank to be see-through so I can monitor the water level.",
      source: "device",
      file: false,
      markers: [3.5, -1, 12],
    });
    expect(s.notesList()[0]).toMatchObject({ filed: [], source: "device", markers: [3.5, 12] });
    const reply = await s.turn({
      kind: "say",
      text: "What was it I wanted to change about the watering system?",
    });
    expect(reply.turn.beats[0]!.say).toMatch(/watering tank/i);
  });

  it("shows relevant notes to the model once per context", async () => {
    const { service: s } = service();
    await s.capture({ text: "The garden hose needs a new nozzle", source: "browser", file: false });
    const seen: (string[] | undefined)[] = [];
    const spy = new ScriptedBrain();
    const run = spy.runTurn.bind(spy);
    spy.runTurn = async (ctx, input) => (seen.push(ctx.notes), run(ctx, input));
    const s2 = new PalService((s as unknown as { store: Store }).store, spy, {
      clock: () => NOW.getTime(),
    });
    await s2.turn({ kind: "say", text: "what about the garden hose?" });
    await s2.turn({ kind: "say", text: "the garden hose again" });
    expect(seen[0]).toEqual([expect.stringContaining("new nozzle")]);
    expect(seen[1]).toEqual([]);
  });

  it("orders the agenda by urgency and briefs from it", async () => {
    let now = NOW.getTime();
    const { service: s, store } = service(new ScriptedBrain(), () => now);
    const pal = s.pal.id;
    s.notes.addTask(pal, { text: "Organize the shelf", dueAt: at(29), allDay: true }, now - 9e8);
    s.notes.addTask(pal, { text: "Clean the CNC" }, now - 1000);
    s.notes.addTask(pal, { text: "Order filament" }, now);
    s.notes.addTask(pal, { text: "Finish editing", dueAt: at(1, 13, 16) }, now);
    store.addReminder(pal, at(1, 17), "Walk Lenny", now);
    store.addReminder(pal, at(2, 10), "Dentist", now);
    // Last month's all-day task is overdue; today's 13:16 one is not yet.
    const shelf = s.notes.openTasks(pal).find((t) => t.text.startsWith("Organize"))!;
    s.notes.updateTask(pal, shelf.id, {
      text: shelf.text,
      dueAt: new Date(2026, 8, 29).getTime(),
      allDay: true,
    });
    const agenda = s.agenda();
    expect(agenda.tasks.map((t) => t.text)).toEqual([
      "Organize the shelf",
      "Finish editing",
      "Order filament",
      "Clean the CNC",
    ]);
    expect(agenda.overdue).toBe(1);
    expect(briefingFacts(agenda, "day", now)).toBe(
      "Today: Walk Lenny 17:00. Due: Finish editing (13:16). Open tasks: Order filament; Clean the CNC. Overdue: Organize the shelf.",
    );
    expect(briefingFacts(agenda, "week", now)).toMatch(
      /^This week: Walk Lenny today 17:00; Dentist tomorrow 10:00\./,
    );
    const brief = await s.brief("day");
    expect(brief.turn.beats.map((b) => b.say).join(" ")).toContain("Walk Lenny 17:00");
    expect(brief.lines?.at(-1)?.who).toBe("pal");

    await s.manage({ action: "complete_task", palId: pal, itemId: shelf.id, enabled: true });
    expect(s.agenda()).toMatchObject({ overdue: 0, done: [{ text: "Organize the shelf" }] });
    now = at(1, 14);
    expect(s.agenda().overdue).toBe(1);
  });

  it("lets the owner add, edit and delete tasks and notes", async () => {
    const { service: s } = service();
    const pal = s.pal.id;
    await s.manage({
      action: "add_task",
      palId: pal,
      text: "Print the enclosure",
      due: "2026-10-01",
    });
    const [task] = s.agenda().tasks;
    expect(task).toMatchObject({ text: "Print the enclosure", dueAt: at(1), allDay: true });
    await s.manage({
      action: "edit_task",
      palId: pal,
      itemId: task!.id,
      text: "Print it",
      due: "2026-10-03T17:00",
    });
    expect(s.agenda().tasks[0]).toMatchObject({
      text: "Print it",
      dueAt: at(3, 17),
      allDay: false,
    });
    await expect(
      s.manage({ action: "add_task", palId: pal, text: "x", due: "soonish" }),
    ).rejects.toThrow(/valid date/);
    await s.manage({ action: "delete_task", palId: pal, itemId: task!.id });
    expect(s.agenda().tasks).toEqual([]);
    const note = await s.capture({ text: "a thought", source: "browser", file: false });
    await s.manage({ action: "delete_note", palId: pal, itemId: note.noteId });
    expect(s.notesList()).toEqual([]);
  });

  it("keeps the compact agenda under 1 KB however long the texts are", () => {
    const long = "注意".repeat(200);
    const agenda: AgendaInfo = {
      generatedAt: 0,
      tasks: Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        text: long,
        dueAt: i % 2 ? null : at(1),
        allDay: true,
        doneAt: null,
        createdAt: 0,
        noteId: null,
      })),
      done: [],
      events: Array.from({ length: 10 }, (_, i) => ({
        id: i,
        text: long,
        at: at(2),
        repeat: "none" as const,
      })),
      overdue: 0,
    };
    const msg = agendaMessage(agenda, NOW.getTime());
    expect(utf8Length(JSON.stringify(msg))).toBeLessThan(WIRE_MAX_BYTES);
    expect(msg.open).toBe(30);
    expect(parseServerMessage(JSON.stringify(msg)).ok).toBe(true);
  });

  it("splits briefing facts into at most three speakable beats", () => {
    const beats = factBeats("A. ".repeat(200));
    expect(beats.length).toBeLessThanOrEqual(3);
    for (const b of beats) expect(b.length).toBeLessThanOrEqual(140);
  });
});

describe("model triage", () => {
  function setup() {
    const faux = fauxProvider({ provider: `triage-${Math.random()}` });
    const models = createModels();
    models.setProvider(faux.provider);
    return { faux, brain: new PiBrain(models, faux.getModel() as Model<never>, { log: () => {} }) };
  }

  it("files with one structured request, outside the conversation", async () => {
    const { faux, brain } = setup();
    let prompt = "";
    faux.setResponses([
      (ctx) => {
        prompt = JSON.stringify(ctx);
        return fauxAssistantMessage(
          [
            fauxToolCall("file_capture", {
              clean: "I need to order the display today.",
              items: [{ kind: "task", text: "Order the display", when: "2026-10-01" }],
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
    ]);
    const { service: s } = service(brain);
    const res = await s.capture({
      text: "uh I need to order the uh display today",
      source: "browser",
    });
    expect(prompt).toMatch(/Thursday,? 1 October 2026/);
    expect(res.summary).toBe("Task: Order the display (today)");
    expect(s.notesList()[0]!.text).toBe("I need to order the display today.");
    expect(s.notesList()[0]!.raw).toBe("uh I need to order the uh display today");
  });

  it("falls back to offline triage when the model fails", async () => {
    const { faux, brain } = setup();
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "down" })]);
    const t = await brain.triage({ now: NOW, dna: service().service.pal }, "Buy filament tomorrow");
    expect(t.items).toEqual([{ kind: "task", text: "Buy filament", when: at(2), allDay: true }]);
  });
});

describe("server and device API", () => {
  async function boot(device: Parameters<typeof startServer>[1]["device"] = {}) {
    const store = new Store(":memory:");
    const s = new PalService(store, new ScriptedBrain());
    const server = await startServer(s, {
      host: "127.0.0.1",
      port: 0,
      log: () => {},
      schedulerTickMs: 0,
      device,
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (path: string, body?: unknown, token?: string, init: RequestInit = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined && !init.body ? "GET" : "POST",
        ...init,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(init.headers as Record<string, string>),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: res.status,
        data: (await res.json().catch(() => null)) as Record<string, unknown>,
      };
    };
    const owner = (await call("/api/bootstrap", {})).data.identity as { token: string };
    return { server, call, owner: owner.token, base };
  }

  function socket(port: number, ownerToken: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.close());
    const inbox: ServerMessage[] = [];
    const waiters: [(m: ServerMessage) => boolean, (m: ServerMessage) => void][] = [];
    ws.on("message", (d) => {
      const p = parseServerMessage(d.toString());
      if (!p.ok) throw new Error(p.message);
      const w = waiters.findIndex(([pred]) => pred(p.msg));
      if (w >= 0) waiters.splice(w, 1)[0]![1](p.msg);
      else inbox.push(p.msg);
    });
    const next = <T extends ServerMessage["type"]>(
      type: T,
      pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ) =>
      new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
        const match = (m: ServerMessage) =>
          m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
        const i = inbox.findIndex(match);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
        waiters.push([
          match,
          (m) => (clearTimeout(t), resolve(m as Extract<ServerMessage, { type: T }>)),
        ]);
      });
    const open = new Promise((r) => ws.once("open", r)).then(() =>
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: "t",
          ownerToken,
          caps: { w: 368, h: 448, colors: 65536, input: ["button", "touch"] },
        }),
      ),
    );
    return { ws, next, open, send: (m: unknown) => ws.send(JSON.stringify(m)) };
  }

  it("captures and briefs over the socket, pushing the agenda", async () => {
    const { server, owner } = await boot();
    const c = socket(server.port, owner);
    await c.open;
    expect(await c.next("agenda")).toMatchObject({ open: 0, overdue: 0, tasks: [] });
    c.send({ type: "capture", requestId: "r1", text: "Buy filament tomorrow" });
    expect(await c.next("ack", (m) => m.status === "accepted")).toMatchObject({ requestId: "r1" });
    expect(await c.next("captured")).toMatchObject({
      requestId: "r1",
      filed: "Task: Buy filament (tomorrow)",
    });
    expect(await c.next("turn")).toMatchObject({ turn: { beats: [{ action: "nod" }] } });
    expect(await c.next("agenda")).toMatchObject({ open: 1, tasks: [{ text: "Buy filament" }] });
    expect(await c.next("ack", (m) => m.status === "done")).toMatchObject({ requestId: "r1" });
    // A retry is acknowledged without filing twice.
    c.send({ type: "capture", requestId: "r1", text: "Buy filament tomorrow" });
    await c.next("ack", (m) => m.status === "done");
    c.send({ type: "brief", scope: "day" });
    const brief = await c.next("chat", (m) => m.line.who === "pal");
    expect(brief.line.text).toMatch(/Nothing scheduled today/);
  });

  it("captures and briefs over HTTP", async () => {
    const { call, owner } = await boot();
    const res = await call(
      "/api/capture",
      { text: "I have to call the plumber on Friday", requestId: "h1" },
      owner,
    );
    expect(res.data.summary).toMatch(
      /^Task: Call the plumber \((?:today|tomorrow|\w{3} \d{1,2} \w{3})\)$/,
    );
    expect((await call("/api/agenda", undefined, owner)).data).toMatchObject({
      tasks: [{ text: "Call the plumber" }],
    });
    expect(
      ((await call("/api/notes?q=plumber", undefined, owner)).data as unknown as unknown[]).length,
    ).toBe(1);
    expect((await call("/api/brief", { scope: "week" }, owner)).data.text).toMatch(
      /Call the plumber/,
    );
    expect((await call("/api/brief", { scope: "month" }, owner)).status).toBe(400);
    expect((await call("/api/capture", { text: "" }, owner)).status).toBe(400);
  });

  it("pairs a device with a code shown on it, then serves its home screen", async () => {
    const { call, owner } = await boot();
    const start = await call("/api/device/pair/start", { name: "Desk pal" });
    expect(start.data.code).toMatch(/^\d{6}$/);
    const poll = () => call("/api/device/pair/poll", { pollToken: start.data.pollToken });
    expect((await poll()).data).toMatchObject({ status: "pending" });
    expect(
      (
        await call(
          "/api/device/pair/approve",
          { code: "000000" === start.data.code ? "111111" : "000000" },
          owner,
        )
      ).status,
    ).toBe(400);
    expect(
      (await call("/api/device/pair/approve", { code: start.data.code }, owner)).data,
    ).toMatchObject({ ok: true, name: "Desk pal" });
    const paired = (await poll()).data as { status: string; token: string };
    expect(paired.status).toBe("paired");
    expect((await poll()).status).toBe(404);

    const home = await call("/api/device/home", undefined, paired.token);
    expect(home.data).toMatchObject({
      pal: { name: expect.any(String) },
      agenda: { type: "agenda", open: 0 },
      speech: { stt: false, tts: false },
    });
    const text = await call("/api/device/capture", undefined, paired.token, {
      method: "POST",
      body: "Order new filament today",
      headers: { "Content-Type": "text/plain", "X-Request-Id": "d1", "X-Markers": "1.5,x,4" },
    });
    expect(text.data).toMatchObject({
      summary: "Task: Order new filament (today)",
      replayed: false,
    });
    const audio = await call("/api/device/capture", undefined, paired.token, {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: { "Content-Type": "audio/wav" },
    });
    expect(audio.status).toBe(503);
    expect(
      (await call("/api/device/ask", { text: "what are my tasks?" }, paired.token)).data.text,
    ).toMatch(/Order new filament/);
    expect((await call("/api/device/brief", { scope: "day" }, paired.token)).data.text).toMatch(
      /Order new filament/,
    );
    expect((await call("/api/device/speak", { text: "hi" }, paired.token)).status).toBe(503);

    const list = (await call("/api/devices", undefined, owner)).data as unknown as {
      id: number;
      name: string;
      lastSeen: number;
    }[];
    expect(list).toMatchObject([{ name: "Desk pal", lastSeen: expect.any(Number) }]);
    await call("/api/devices/revoke", { id: list[0]!.id }, owner);
    expect((await call("/api/device/home", undefined, paired.token)).status).toBe(401);
    expect((await call("/api/device/home")).status).toBe(401);
  });

  it("transcribes device audio and speaks in the pal's voice through configured servers", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body });
      if (url.endsWith("/audio/transcriptions"))
        return Response.json({ text: "I need to print the new enclosure by Friday." });
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "Content-Type": "audio/wav" },
      });
    }) as typeof fetch;
    const { call, owner, base } = await boot({
      stt: { url: "http://stt.test/v1/", model: "small" },
      tts: { url: "http://tts.test/v1", key: "k" },
      fetch: fake,
    });
    const start = await call("/api/device/pair/start", {});
    await call("/api/device/pair/approve", { code: start.data.code }, owner);
    const { token } = (await call("/api/device/pair/poll", { pollToken: start.data.pollToken }))
      .data as { token: string };
    const res = await call("/api/device/capture", undefined, token, {
      method: "POST",
      body: new Uint8Array(64),
      headers: { "Content-Type": "audio/wav", "X-Recorded-At": String(Date.now() - 60_000) },
    });
    expect(res.data).toMatchObject({
      transcript: "I need to print the new enclosure by Friday.",
      summary: expect.stringMatching(/^Task: Print the new enclosure \(/),
    });
    expect(calls[0]!.url).toBe("http://stt.test/v1/audio/transcriptions");
    expect((calls[0]!.body as FormData).get("model")).toBe("small");
    // A spoken question is a real recording: 20 s of 24 kHz WAV is about 1 MB.
    const asked = await call("/api/device/ask", undefined, token, {
      method: "POST",
      body: new Uint8Array(24_000 * 2 * 20),
      headers: { "Content-Type": "audio/wav" },
    });
    expect(asked.status).toBe(200);
    expect(asked.data).toMatchObject({ question: "I need to print the new enclosure by Friday." });
    calls.splice(1, 1);
    const speech = await fetch(`${base}/api/device/speak`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello!" }),
    });
    expect(speech.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
    const ttsBody = JSON.parse(calls[1]!.body as string) as { voice: string; input: string };
    expect(calls[1]!.url).toBe("http://tts.test/v1/audio/speech");
    expect(ttsBody).toMatchObject({ input: "Hello!", voice: expect.stringMatching(/^[ab][fm]_/) });
  });
});
