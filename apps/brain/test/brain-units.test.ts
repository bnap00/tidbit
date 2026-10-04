import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { DnaSchema, TurnSchema } from "@tidbit/protocol";
import { DRIFT, isNight, stepNeeds } from "../src/needs.js";
import { ScriptedBrain, dnaFromPrompt } from "../src/scripted-brain.js";
import { Store } from "../src/store.js";
import { ctxFor } from "./helpers.js";

const H = 3_600_000;
const noon = (h: number) => () => h;

describe("needs (pure)", () => {
  const base = { energy: 50, hunger: 50, bond: 50 };
  it("drifts: hunger rises, bond decays, energy falls by day", () => {
    const n = stepNeeds(base, 0, 2 * H, [], noon(12));
    expect(n.hunger).toBeCloseTo(50 + 2 * DRIFT.hungerPerHour);
    expect(n.bond).toBeCloseTo(50 + 2 * DRIFT.bondPerHour);
    expect(n.energy).toBeCloseTo(50 + 2 * DRIFT.energyDayPerHour);
  });
  it("energy recovers at night", () => {
    expect(stepNeeds(base, 0, H, [], noon(2)).energy).toBeCloseTo(50 + DRIFT.energyNightPerHour);
    expect(isNight(23)).toBe(true);
    expect(isNight(12)).toBe(false);
  });
  it("respects the day/night boundary within one step", () => {
    const hourAt = (ms: number) => (ms < H ? 21 : 22);
    const n = stepNeeds(base, 0, 2 * H, [], hourAt);
    expect(n.energy).toBeCloseTo(50 + DRIFT.energyDayPerHour + DRIFT.energyNightPerHour);
  });
  it("events apply and everything stays in 0–100", () => {
    expect(stepNeeds(base, 0, 0, [{ kind: "touch", touch: "feed" }]).hunger).toBe(20);
    expect(stepNeeds(base, 0, 0, [{ kind: "bond", bond: "up" }]).bond).toBe(54);
    const starving = stepNeeds({ energy: 1, hunger: 99, bond: 0 }, 0, 100 * H, [], noon(12));
    expect(starving).toEqual({ energy: 0, hunger: 100, bond: 0 });
  });
});

describe("ScriptedBrain", () => {
  const brain = new ScriptedBrain();
  it("maps keywords to fitting turns, deterministically", async () => {
    const t1 = await brain.runTurn(ctxFor(), { kind: "say", text: "Hello!" });
    expect(t1.beats.at(-1)).toMatchObject({ mood: "happy", action: "wave" });
    const t2 = await brain.runTurn(ctxFor(), { kind: "say", text: "Hello!" });
    expect(t2).toEqual(t1);
    const sad = await brain.runTurn(ctxFor(), { kind: "say", text: "I had a bad day" });
    expect(sad.beats.at(-1)?.mood).toBe("sad");
    const rude = await brain.runTurn(ctxFor(), { kind: "say", text: "you are annoying" });
    expect(rude.bond).toBe("down");
  });
  it("a grumpy pal grumbles before good news", async () => {
    const t = await brain.runTurn(ctxFor(undefined, 0), { kind: "say", text: "I passed my exam!" });
    expect(t.beats[0]).toMatchObject({ mood: "angry", say: "Hmph." });
    expect(t.beats[1]?.mood).toBe("excited");
  });
  it("every reply is a valid turn, whatever the input", async () => {
    for (const text of ["", "?", "🤖🤖🤖", "x".repeat(900), "what time is it", "goodnight"]) {
      expect(Value.Check(TurnSchema, await brain.runTurn(ctxFor(), { kind: "say", text }))).toBe(
        true,
      );
    }
    expect(
      Value.Check(
        TurnSchema,
        await brain.runTurn(ctxFor(), {
          kind: "event",
          event: "reminder_due",
          text: "water the plants",
        }),
      ),
    ).toBe(true);
  });
  it("builds DNA from prompt keywords", () => {
    const d = dnaFromPrompt("a tiny pink robot king", 42);
    expect(Value.Check(DnaSchema, d)).toBe(true);
    expect(d.look).toMatchObject({
      body: "square",
      eyes: "visor",
      accessory: "crown",
      size: 2,
      hue: 330,
    });
    // Later words win: a cactus cat is a cat (with cactus colours and spots).
    const cc = dnaFromPrompt("a grumpy cactus cat", 7);
    expect(cc.look).toMatchObject({ ears: "cat", marking: "spots", scheme: "earth" });
    // Word boundaries: "catalog" is not a cat.
    expect(dnaFromPrompt("a catalog", 1).look.ears).toBe(dnaFromPrompt("a", 1).look.ears);
  });
});

describe("Store", () => {
  it("sessions are append-only", () => {
    const s = new Store(":memory:");
    const dna = dnaFromPrompt("a bean", 5);
    s.savePal(dna);
    const sess = s.openSession(dna.id);
    s.appendMessages(sess.id, [{ a: 1 }, { b: 2 }]);
    s.appendMessages(sess.id, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(s.loadMessages(sess.id)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(() => s.appendMessages(sess.id, [{ a: 1 }])).toThrow(/shrink/);
    expect(s.openSession(dna.id).id).toBe(sess.id);
    s.closeSession(sess.id);
    expect(s.openSession(dna.id).id).not.toBe(sess.id);
  });
});

describe("growth (M6)", () => {
  it("accrues from warm turns, pets and feeds, and persists", async () => {
    const { PalService, growthStage, GROWTH_THRESHOLDS } = await import("../src/service.js");
    const store = new Store(":memory:");
    const service = new PalService(store, new ScriptedBrain());
    expect(service.growth()).toBe(0);
    for (let i = 0; i < GROWTH_THRESHOLDS[0] * 2; i++) await service.touch("pet");
    expect(service.growth()).toBe(1);
    await service.turn({ kind: "say", text: "I love you" }); // bond up
    const again = new PalService(store, new ScriptedBrain());
    expect(again.growth()).toBe(1);
    expect(growthStage(0)).toBe(0);
    expect(growthStage(GROWTH_THRESHOLDS[1])).toBe(2);
  });
});
