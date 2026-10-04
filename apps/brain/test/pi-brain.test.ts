// PiBrain against pi's scripted fauxProvider (PLAN 9). Never calls a real LLM.
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DnaSchema, FALLBACK_TURN, TurnSchema } from "@tidbit/protocol";
import { PiBrain, extractJson } from "../src/pi/pi-brain.js";
import { MemorySession, ctxFor } from "./helpers.js";

let n = 0;
function setup(
  opts: ConstructorParameters<typeof PiBrain>[2] = {},
  fauxOpts: Parameters<typeof fauxProvider>[0] = {},
) {
  const faux = fauxProvider({ provider: `faux-${++n}`, ...fauxOpts });
  const models = createModels();
  models.setProvider(faux.provider);
  const logs: string[] = [];
  const brain = new PiBrain(models, faux.getModel() as Model<never>, {
    log: (m) => logs.push(m),
    ...opts,
  });
  return { faux, brain, logs };
}

const performArgs = (over: Record<string, unknown> = {}) => ({
  beats: [
    { mood: "happy", intensity: 2, say: "Hello!", action: "wave", look: "user", fx: "sparkles" },
  ],
  bond: "up",
  ...over,
});

const echo: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo text back.",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, p) => ({
    content: [{ type: "text", text: String((p as { text: string }).text) }],
    details: {},
  }),
};

describe("PiBrain turns", () => {
  it("perform directly → that turn, one request, session persisted with system prompt", async () => {
    const { faux, brain } = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("perform", performArgs())], { stopReason: "toolUse" }),
    ]);
    const session = new MemorySession();
    const turn = await brain.runTurn(ctxFor(session), { kind: "say", text: "hi" });
    expect(Value.Check(TurnSchema, turn)).toBe(true);
    expect(turn.beats[0]).toMatchObject({ mood: "happy", say: "Hello!", action: "wave" });
    expect(turn.bond).toBe("up");
    expect(faux.state.callCount).toBe(1);
    const roles = (session.messages as { role: string }[]).map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles).toContain("user");
    expect(brain.usage.length).toBe(1);
  });

  it("tool call, then perform → two requests", async () => {
    const { faux, brain } = setup({ tools: [echo] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "ping" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("perform", performArgs())], { stopReason: "toolUse" }),
    ]);
    const turn = await brain.runTurn(ctxFor(), { kind: "say", text: "echo ping then reply" });
    expect(turn.beats[0]?.say).toBe("Hello!");
    expect(faux.state.callCount).toBe(2);
  });

  it("perform with out-of-range values is repaired, not bounced", async () => {
    const { faux, brain } = setup();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("perform", {
            beats: [
              {
                mood: "ECSTATIC",
                intensity: 9,
                say: "x".repeat(400),
                action: "backflip",
                look: "behind",
                fx: "fireworks",
              },
              { mood: "sad" },
              { mood: "happy" },
              { mood: "love" },
            ],
            bond: "sideways",
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const turn = await brain.runTurn(ctxFor(), { kind: "say", text: "hi" });
    expect(Value.Check(TurnSchema, turn)).toBe(true);
    expect(turn.beats).toHaveLength(3);
    expect(turn.beats[0]).toMatchObject({ intensity: 3, action: "none", look: "user", fx: "none" });
    expect(turn.beats[0]!.say.length).toBe(140);
    expect(faux.state.callCount).toBe(1);
  });

  it("plain text reply with no perform → wrapped in the base mood", async () => {
    const { faux, brain } = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxText("Oh hello! It is lovely to see you again today, friend.")]),
    ]);
    const ctx = ctxFor();
    const turn = await brain.runTurn(ctx, { kind: "say", text: "hi" });
    expect(turn.beats[0]).toMatchObject({
      mood: ctx.dna.baseMood,
      say: "Oh hello! It is lovely to see you again today, friend.",
    });
  });

  it("long plain text is split into beats of at most 140 characters", async () => {
    const { faux, brain } = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxText("This is a sentence that goes on. ".repeat(12))]),
    ]);
    const turn = await brain.runTurn(ctxFor(), { kind: "say", text: "tell me a story" });
    expect(turn.beats.length).toBeGreaterThan(1);
    for (const b of turn.beats) expect(b.say.length).toBeLessThanOrEqual(140);
  });

  it("provider error → canned fallback turn, error logged", async () => {
    const { faux, brain, logs } = setup();
    faux.setResponses([]); // empty queue: faux returns an error message
    const turn = await brain.runTurn(ctxFor(), { kind: "say", text: "hi" });
    expect(turn).toEqual(FALLBACK_TURN);
    expect(logs).toContain("turn failed");
  });

  it("loop cap: a model that never performs stops after 6 requests", async () => {
    const { faux, brain, logs } = setup({ tools: [echo] });
    faux.setResponses(
      Array.from({ length: 12 }, () =>
        fauxAssistantMessage([fauxToolCall("echo", { text: "again" })], { stopReason: "toolUse" }),
      ),
    );
    const turn = await brain.runTurn(ctxFor(), { kind: "say", text: "loop forever" });
    expect(faux.state.callCount).toBe(6);
    expect(turn).toEqual(FALLBACK_TURN);
    expect(logs).toContain("request cap reached");
  });

  it("timeout: a slow model is aborted and the pal falls back", async () => {
    const { faux, brain, logs } = setup({ turnTimeoutMs: 150 }, { tokensPerSecond: 5 });
    faux.setResponses([fauxAssistantMessage([fauxText("a very slow answer ".repeat(20))])]);
    const t = Date.now();
    const turn = await brain.runTurn(ctxFor(), { kind: "say", text: "hi" });
    expect(Date.now() - t).toBeLessThan(3000);
    expect(turn).toEqual(FALLBACK_TURN);
    expect(logs).toContain("turn timed out");
  });

  it("a second turn appends to the same session (append-only, one system message)", async () => {
    const { faux, brain } = setup();
    const session = new MemorySession();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("perform", performArgs())], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("perform", performArgs({ bond: "same" }))], {
        stopReason: "toolUse",
      }),
    ]);
    await brain.runTurn(ctxFor(session), { kind: "say", text: "one" });
    const firstLen = session.messages.length;
    const first = structuredClone(session.messages);
    await brain.runTurn(ctxFor(session), { kind: "say", text: "two" });
    expect(session.messages.length).toBeGreaterThan(firstLen);
    expect(session.messages.slice(0, firstLen)).toEqual(first);
    expect(
      (session.messages as { role: string }[]).filter((m) => m.role === "system"),
    ).toHaveLength(1);
  });
});

describe("PiBrain streaming", () => {
  it("reports the first beat's mood while perform is still streaming", async () => {
    const { faux, brain } = setup({}, { tokensPerSecond: 400 });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "perform",
            performArgs({
              beats: [
                {
                  mood: "surprised",
                  intensity: 3,
                  say: "Whoa, really? ".repeat(6),
                  action: "jump",
                  look: "user",
                  fx: "exclaim",
                },
              ],
            }),
          ),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const events: string[] = [];
    const ctx = { ...ctxFor(), onEarlyMood: (m: string) => events.push(`mood:${m}`) };
    const turn = await brain.runTurn(ctx, { kind: "say", text: "guess what" });
    events.push("turn");
    expect(events).toEqual(["mood:surprised", "turn"]);
    expect(turn.beats[0]?.mood).toBe("surprised");
  });

  it("never reports a mood that is not in the enum", async () => {
    const { faux, brain } = setup({}, { tokensPerSecond: 400 });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "perform",
            performArgs({ beats: [{ mood: "ecstatic", intensity: 2, say: "hi" }] }),
          ),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const moods: string[] = [];
    await brain.runTurn(
      { ...ctxFor(), onEarlyMood: (m: string) => moods.push(m) },
      { kind: "say", text: "x" },
    );
    expect(moods).toEqual([]);
  });
});

describe("PiBrain character creation", () => {
  it("uses the create_character tool call and assigns id and seed", async () => {
    const { faux, brain } = setup();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("create_character", {
            name: "Prickles",
            look: {
              body: "bean",
              size: 6,
              plump: 4,
              eyes: "sleepy",
              eyeSize: 5,
              eyeGap: 4,
              brows: "thick",
              mouth: "cat",
              ears: "cat",
              limbs: "nubs",
              tail: "none",
              marking: "spots",
              accessory: "none",
              hue: 112,
              scheme: "earth",
            },
            temper: { energy: 3, playful: 4, shy: 2, grumpy: 8, curious: 5 },
            baseMood: "neutral",
            persona: "A cactus cat.",
            voice: { pitch: 3, speed: 4 },
          }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const dna = await brain.createCharacter("a grumpy cactus cat");
    expect(Value.Check(DnaSchema, dna)).toBe(true);
    expect(dna.name).toBe("Prickles");
    expect(dna.look.ears).toBe("cat");
    expect(dna.id).toMatch(/^pal_/);
  });

  it("falls back to JSON in text, then to a seeded keyword pal", async () => {
    const a = setup();
    a.faux.setResponses([
      fauxAssistantMessage([fauxText('Here: {"name":"Bloop","look":{"body":"ghost"}} enjoy')]),
    ]);
    const d1 = await a.brain.createCharacter("a ghost");
    expect(d1.name).toBe("Bloop");
    expect(d1.look.body).toBe("ghost");

    const b = setup();
    b.faux.setResponses([]);
    const d2 = await b.brain.createCharacter("a robot");
    expect(Value.Check(DnaSchema, d2)).toBe(true);
    expect(d2.look.body).toBe("square");
    // Same prompt, same pal.
    const c = setup();
    c.faux.setResponses([]);
    expect((await c.brain.createCharacter("a robot")).seed).toBe(d2.seed);
  });

  it("extractJson handles nesting and strings with braces", () => {
    expect(extractJson('x {"a":{"b":"}"}} y')).toEqual({ a: { b: "}" } });
    expect(extractJson("no json")).toBeUndefined();
  });
});

it("updates personality in a resumed model session without rewriting earlier messages", async () => {
  const { faux, brain } = setup();
  const ctx = ctxFor();
  ctx.personality = {
    humor: "gentle",
    speech: "warm",
    interests: ["gardening"],
    likes: ["sunny windows"],
    dislikes: ["loud surprises"],
    quirk: "Collects tiny observations.",
    ritual: "Share one good thing",
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("perform", performArgs())], { stopReason: "toolUse" }),
  ]);
  await brain.runTurn(ctx, { kind: "say", text: "Hello" });
  const prefix = JSON.stringify(ctx.session.load());
  const count = ctx.session.load().length;
  ctx.personality = { ...ctx.personality, likes: ["moon cakes"], humor: "dry" };
  let context = "";
  faux.setResponses([
    (input) => {
      context = JSON.stringify(input.messages);
      return fauxAssistantMessage([fauxToolCall("perform", performArgs())], {
        stopReason: "toolUse",
      });
    },
  ]);
  await brain.runTurn(ctx, { kind: "say", text: "What do you like now?" });
  expect(context).toContain("moon cakes");
  expect(JSON.stringify(ctx.session.load().slice(0, count))).toBe(prefix);
  const systems = ctx.session.load().filter((m) => (m as { role: string }).role === "system");
  expect(systems).toHaveLength(2);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("perform", performArgs())], { stopReason: "toolUse" }),
  ]);
  await brain.runTurn(ctx, { kind: "say", text: "Still there?" });
  expect(ctx.session.load().filter((m) => (m as { role: string }).role === "system")).toHaveLength(
    2,
  );
});
