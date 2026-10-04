// M4 acceptance (PLAN 10): tools, memory across sessions, proactive reminders,
// scheduler rules, model switching, usage logging. Never calls a real LLM or network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai";
import { parseServerMessage, type ServerMessage } from "@tidbit/protocol";
import { loadDnaFixtures } from "@tidbit/protocol/fixtures";
import { PiBrain } from "../src/pi/pi-brain.js";
import { agentTools } from "../src/pi/agent-tools.js";
import { PROACTIVE_GAP_MS, Scheduler } from "../src/scheduler.js";
import { ScriptedBrain } from "../src/scripted-brain.js";
import { startServer } from "../src/server.js";
import { PalService, type TurnResult } from "../src/service.js";
import { Store } from "../src/store.js";
import { createTools } from "../src/tools.js";
import { ctxFor } from "./helpers.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempStore(): Store {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "apal-m4-")), "pal.db"));
  cleanups.push(() => s.close());
  return s;
}

const perform = (say: string) =>
  fauxAssistantMessage(
    [
      fauxToolCall("perform", {
        beats: [{ mood: "happy", intensity: 2, say, action: "nod", look: "user", fx: "none" }],
        bond: "same",
      }),
    ],
    {
      stopReason: "toolUse",
    },
  );

/** Text of every message the model was sent, for assertions on context. */
function transcriptText(ctx: { messages: unknown[] }): string {
  return JSON.stringify(ctx.messages);
}

let fauxN = 0;
function faux(id?: string) {
  const f = fauxProvider({ provider: id ?? `m4-${++fauxN}` });
  const models = createModels();
  models.setProvider(f.provider);
  return { f, models, model: f.getModel() as Model<never> };
}

// ---------------------------------------------------------------------------

describe("tools (temp SQLite)", () => {
  function setup(fetchImpl: typeof fetch = fetch) {
    const store = tempStore();
    const dna = loadDnaFixtures()[0]!.value;
    store.savePal(dna);
    let now = Date.parse("2026-09-29T10:00:00Z");
    const tools = createTools({
      store,
      palId: dna.id,
      clock: () => now,
      fetch: fetchImpl,
      timeZone: "UTC",
    });
    return { store, dna, tools, advance: (ms: number) => (now += ms) };
  }

  it("remember → recall with stemming and ranking → forget", () => {
    const { tools } = setup();
    expect(tools.remember("The user's dog is called Biscuit", ["pets", "dog"])).toMatch(/#1/);
    tools.remember("The user loves strawberry ice cream", ["food"]);
    tools.remember("The user's sister Mia lives in Lisbon", ["family"]);
    expect(tools.recall("dogs")).toContain("Biscuit");
    expect(tools.recall("what food do they like")).toContain("strawberry");
    expect(tools.recall("quantum chromodynamics")).toBe("No matching memories.");
    expect(tools.forget(1)).toMatch(/Forgot/);
    expect(tools.recall("dog")).toBe("No matching memories.");
    expect(() => tools.forget(1)).toThrow(/no memory/);
    expect(() => tools.remember("   ")).toThrow(/empty/);
  });

  it("search input can never inject FTS syntax", () => {
    const { tools } = setup();
    tools.remember("Likes jazz");
    for (const q of ['"', "jazz OR", "NEAR(jazz", "*", 'jazz" OR "x', "(((", "-jazz", "^jazz"]) {
      expect(() => tools.recall(q)).not.toThrow();
    }
    expect(tools.recall('jazz" OR "x')).toContain("jazz");
  });

  it("memories are per pal", () => {
    const { store, tools } = setup();
    const other = loadDnaFixtures()[1]!.value;
    store.savePal(other);
    tools.remember("Secret of pal one");
    const otherTools = createTools({ store, palId: other.id, clock: Date.now, fetch });
    expect(otherTools.recall("secret")).toBe("No matching memories.");
  });

  it("reminders: set, list, cancel, and reject bad times", () => {
    const { tools } = setup();
    expect(tools.setReminder("2026-09-29T10:30:00Z", "water the plants")).toMatch(
      /#1 set for .*10:30/,
    );
    expect(tools.listReminders()).toContain("water the plants");
    expect(tools.cancelReminder(1)).toMatch(/Cancelled/);
    expect(tools.listReminders()).toBe("No pending reminders.");
    expect(() => tools.cancelReminder(1)).toThrow(/no pending/);
    expect(() => tools.setReminder("yesterday", "x")).toThrow(/ISO/);
    expect(() => tools.setReminder("2026-09-28T10:00:00Z", "x")).toThrow(/past/);
    expect(() => tools.setReminder("2030-01-01T00:00:00Z", "x")).toThrow(/year/);
  });

  it("get_time reports the clock", () => {
    const { tools } = setup();
    expect(tools.getTime()).toContain("2026-09-29T10:00:00.000Z");
  });

  it("get_weather uses Open-Meteo and handles failures", async () => {
    const calls: string[] = [];
    const ok: typeof fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("geocoding"))
        return Response.json({
          results: [{ name: "Lisbon", country: "Portugal", latitude: 38.7, longitude: -9.1 }],
        });
      return Response.json({
        current: {
          temperature_2m: 21.4,
          apparent_temperature: 20.8,
          weather_code: 2,
          wind_speed_10m: 12.2,
          precipitation: 0,
        },
        daily: { temperature_2m_max: [24], temperature_2m_min: [15] },
      });
    };
    const { tools } = setup(ok);
    const w = await tools.getWeather("Lisbon");
    expect(w).toBe(
      "Lisbon, Portugal: partly cloudy, 21°C (feels 21°C), wind 12 km/h; today 15–24°C",
    );
    expect(calls[0]).toContain("name=Lisbon");

    const nowhere = setup(async () => Response.json({ results: [] })).tools;
    await expect(nowhere.getWeather("Atlantis")).rejects.toThrow(/no place/);
    const down = setup(async () => new Response("", { status: 503 })).tools;
    await expect(down.getWeather("Lisbon")).rejects.toThrow(/503/);
    const hang = setup(
      (_u, init) =>
        new Promise((_r, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    ).tools;
    const ctl = new AbortController();
    const p = hang.getWeather("Lisbon", ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });

  it("agent tool wrappers throw on failure so pi reports an error result", async () => {
    const { tools } = setup();
    const list = agentTools(tools);
    expect(list.map((t) => t.name).sort()).toEqual(
      [
        "add_task",
        "cancel_reminder",
        "complete_task",
        "forget",
        "get_time",
        "get_weather",
        "list_reminders",
        "list_tasks",
        "recall",
        "remember",
        "save_skill",
        "set_reminder",
        "update_self",
        "use_skill",
        "web_fetch",
      ].sort(),
    );
    // Optional tools appear only when available; the list never grows file, shell or code tools.
    expect(
      agentTools(tools, { webSearch: true, actions: true })
        .map((t) => t.name)
        .filter((name) => !list.some((t) => t.name === name))
        .sort(),
    ).toEqual(["run_action", "web_search"]);
    const forget = list.find((t) => t.name === "forget")!;
    await expect(forget.execute("id", { memoryId: 99 })).rejects.toThrow(/no memory/);
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      list.find((t) => t.name === "get_time")!.execute("id", {}, ctl.signal),
    ).rejects.toThrow(/aborted/);
  });
});

// ---------------------------------------------------------------------------

describe("memory across sessions (fauxProvider)", () => {
  it("remember → session rollover with summary → new session → recall", async () => {
    const { f, models, model } = faux();
    const store = tempStore();
    const logs: string[] = [];
    const brain = new PiBrain(models, model, { log: () => {} });
    const service = new PalService(store, brain, { sessionMaxTurns: 1, log: (m) => logs.push(m) });
    const firstSession = store.openSession(service.pal.id).id;

    let secondTurnContext = "";
    f.setResponses([
      // Turn 1: store a fact, then reply.
      fauxAssistantMessage(
        [fauxToolCall("remember", { fact: "The user's dog is called Biscuit", tags: ["pets"] })],
        { stopReason: "toolUse" },
      ),
      perform("A dog named Biscuit! I'll remember."),
      // Rollover summary (one plain completion).
      fauxAssistantMessage([fauxText("The user told me about their dog Biscuit.")]),
      // Turn 2, in a fresh session: recall, then answer.
      (ctx) => {
        secondTurnContext = transcriptText(ctx);
        return fauxAssistantMessage([fauxToolCall("recall", { query: "dog" })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        // The recall result must reach the model.
        expect(transcriptText(ctx)).toContain("Biscuit");
        return perform("Your dog is Biscuit!");
      },
    ]);

    await service.turn({ kind: "say", text: "My dog is called Biscuit." });
    expect(logs).toContain("session rolled over");
    const second = await service.turn({ kind: "say", text: "What's my dog called?" });
    expect(second.turn.beats[0]?.say).toBe("Your dog is Biscuit!");

    const secondSession = store.openSession(service.pal.id).id;
    expect(secondSession).not.toBe(firstSession);
    // The new session starts with a fresh system prompt and does not contain turn 1.
    expect(secondTurnContext).not.toContain("My dog is called Biscuit.");
    // …but the context block surfaced the relevant memory anyway.
    expect(secondTurnContext).toContain("you remember:");
    expect(store.searchMemories(service.pal.id, "Biscuit").map((m) => m.tags)).toContainEqual([
      "session",
    ]);
    expect(f.getPendingResponseCount()).toBe(0);
  });

  it("a stored session resumes on a different model", async () => {
    const store = tempStore();
    const a = faux("model-a");
    const b = faux("model-b");
    const svcA = new PalService(store, new PiBrain(a.models, a.model, { log: () => {} }));
    a.f.setResponses([perform("Nice to meet you, Sam!")]);
    await svcA.turn({ kind: "say", text: "Hi, I'm Sam." });

    let seen = "";
    b.f.setResponses([
      (ctx) => {
        seen = transcriptText(ctx);
        return perform("Of course I remember, Sam.");
      },
    ]);
    const svcB = new PalService(store, new PiBrain(b.models, b.model, { log: () => {} }));
    expect(svcB.pal.id).toBe(svcA.pal.id);
    const res = await svcB.turn({ kind: "say", text: "Do you remember me?" });
    expect(seen).toContain("Hi, I'm Sam.");
    expect(seen).toContain("Nice to meet you, Sam!");
    expect(res.turn.beats[0]?.say).toBe("Of course I remember, Sam.");
    // Append-only: one session, one system prompt.
    const msgs = store.loadMessages(store.openSession(svcB.pal.id).id) as { role: string }[];
    expect(msgs.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("logs cache reads and cost for every request", async () => {
    const { f, models, model } = faux();
    const records: Record<string, unknown>[] = [];
    const brain = new PiBrain(models, model, {
      log: (m, d) => m === "request" && records.push(d!),
    });
    const service = new PalService(tempStore(), brain);
    f.setResponses([perform("one"), perform("two")]);
    await service.turn({ kind: "say", text: "first" });
    await service.turn({ kind: "say", text: "second" });
    expect(records).toHaveLength(2);
    for (const r of records) expect(r).toHaveProperty("cacheRead");
    for (const r of records) expect(r).toHaveProperty("cost");
    // The faux provider simulates prompt caching when a sessionId is set.
    expect(Number(records[1]!.cacheRead)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("proactive behaviour", () => {
  it("a reminder set for 2 s in the future produces a proactive turn over the socket", async () => {
    const store = tempStore();
    const service = new PalService(store, new ScriptedBrain());
    const server = await startServer(service, {
      host: "127.0.0.1",
      port: 0,
      log: () => {},
      schedulerTickMs: 100,
    });
    cleanups.push(() => server.close());
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => ws.close());
    const turns: ServerMessage[] = [];
    ws.on("message", (d) => {
      const p = parseServerMessage(String(d));
      if (p.ok && p.msg.type === "turn") turns.push(p.msg);
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(
      JSON.stringify({ type: "hello", clientId: "t", caps: { w: 1, h: 1, colors: 2, input: [] } }),
    );
    // Skip the first-contact greeting before asking.
    await waitFor(() => turns.length >= 1, 3000);
    ws.send(JSON.stringify({ type: "say", text: "remind me in 2 seconds to stretch" }));
    await waitFor(() => turns.length >= 2, 3000);
    const t0 = Date.now();
    await waitFor(() => turns.length >= 3, 5000);
    const elapsed = Date.now() - t0;
    const reminder = turns[2] as Extract<ServerMessage, { type: "turn" }>;
    expect(reminder.turn.beats.map((b) => b.say).join(" ")).toContain("stretch");
    expect(elapsed).toBeGreaterThan(1000);
    expect(store.pendingReminders(service.pal.id)).toHaveLength(0);
  });

  it("queues reminders until a client connects, and rate-limits other proactive turns", async () => {
    let now = Date.parse("2026-09-29T08:00:00");
    const store = tempStore();
    const service = new PalService(store, new ScriptedBrain(), { clock: () => now });
    let connected = false;
    const delivered: TurnResult[] = [];
    const sched = new Scheduler(service, {
      hasClients: () => connected,
      deliver: (r) => delivered.push(r),
    });

    service.tools().setReminder(new Date(now + 60_000).toISOString(), "call mum");
    now += 120_000;
    await sched.tick();
    expect(delivered).toHaveLength(0); // nobody to tell

    connected = true;
    sched.noteContact();
    await sched.tick();
    expect(delivered[0]!.turn.beats.map((b) => b.say).join(" ")).toContain("call mum");
    await sched.tick();
    expect(delivered[1]!.turn.beats[0]!.say).toMatch(/Good morning/);

    // A second contact the same day does not greet again.
    sched.noteContact();
    await sched.tick();
    expect(delivered).toHaveLength(2);

    // Let hunger climb past the threshold: within 10 min of the greeting it waits…
    const cur = store.getNeeds(service.pal.id)!;
    store.saveNeeds(service.pal.id, { ...cur.needs, hunger: 85 }, now);
    now += 60_000;
    await sched.tick();
    expect(delivered).toHaveLength(2);
    // …then fires once the gap has passed (not lost), and only once per crossing.
    now += PROACTIVE_GAP_MS;
    await sched.tick();
    expect(delivered).toHaveLength(3);
    expect(delivered[2]!.turn.beats[0]).toMatchObject({ action: "eat" });
    now += PROACTIVE_GAP_MS;
    await sched.tick();
    expect(delivered).toHaveLength(3);
    // Recovering re-arms the alert; crossing again alerts again.
    store.saveNeeds(service.pal.id, { ...store.getNeeds(service.pal.id)!.needs, hunger: 40 }, now);
    await sched.tick();
    store.saveNeeds(service.pal.id, { ...store.getNeeds(service.pal.id)!.needs, hunger: 90 }, now);
    now += PROACTIVE_GAP_MS;
    await sched.tick();
    expect(delivered).toHaveLength(4);
  });
});

describe("ScriptedBrain uses tools offline", () => {
  it("remembers, recalls, forgets and sets reminders from plain phrasing", async () => {
    const store = tempStore();
    const service = new PalService(store, new ScriptedBrain());
    const say = async (text: string) =>
      (await service.turn({ kind: "say", text })).turn.beats.map((b) => b.say).join(" ");
    expect(await say("My name is Priya")).toMatch(/Priya/);
    expect(await say("my favourite colour is teal")).toMatch(/remember/);
    expect(await say("What's my favourite colour?")).toMatch(/teal/);
    expect(await say("What is my name?")).toMatch(/Priya/);
    expect(await say("forget my favourite colour")).toMatch(/Forgotten/);
    expect(await say("What's my favourite colour?")).toMatch(/haven't told me/);
    expect(await say("remind me to drink water in 10 minutes")).toMatch(/10 minutes/);
    expect(store.pendingReminders(service.pal.id)[0]?.text).toBe("drink water");
    expect(await say("remind me in 1 hour to stretch")).toMatch(/1 hour/);
  });

  it("context carries relevant memories into the turn", async () => {
    const ctx = ctxFor();
    ctx.memories.push("The user's name is Priya");
    const brain = new ScriptedBrain();
    expect((await brain.runTurn(ctx, { kind: "say", text: "hello" })).beats.length).toBeGreaterThan(
      0,
    );
  });
});

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
