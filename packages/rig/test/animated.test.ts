import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ACTIONS, FXS, LOOKS, MOODS, TOUCH_KINDS, type Beat, type Turn } from "@tidbit/protocol";
import { loadDnaFixtures, loadTurnFixtures } from "@tidbit/protocol/fixtures";
import { actionDuration, beatDuration, createRig } from "../src/index.js";
import { FC_SEED, arbDna } from "./arb.js";
import { checkFrame } from "./check-frame.js";

const turnOf = (...beats: Partial<Beat>[]): Turn => ({
  v: 1,
  beats: beats.map((b) => ({
    mood: "neutral",
    intensity: 2,
    say: "",
    action: "none",
    look: "user",
    fx: "none",
    ...b,
  })),
  bond: "same",
});

const FRACTIONS = [0.05, 0.3, 0.55, 0.8, 0.97];

describe("animated rig invariants (PLAN 4.6)", () => {
  it("1,000 DNAs × 16 actions (moods, looks and fx rotating) stay valid through each action", () => {
    let frames = 0;
    fc.assert(
      fc.property(arbDna, fc.nat(), (dna, n) => {
        const rig = createRig(dna);
        let t0 = 0;
        ACTIONS.forEach((action, a) => {
          const beat: Partial<Beat> = {
            mood: MOODS[(n + a) % MOODS.length]!,
            intensity: 1 + ((n + a) % 3),
            action,
            fx: FXS[(n + a) % FXS.length]!,
            look: LOOKS[(n + a) % LOOKS.length]!,
            say: a % 2 ? "Hello there, friend!" : "",
          };
          rig.apply(turnOf(beat), t0);
          const dur = beatDuration(turnOf(beat).beats[0]!);
          for (const f of FRACTIONS) {
            const t = t0 + dur * f;
            const bad = checkFrame(rig.commands(t), rig.tags);
            frames++;
            if (bad.length)
              throw new Error(
                `${action}/${beat.mood}/${beat.fx} @${Math.round(t - t0)}ms: ${bad.slice(0, 3).join("; ")}`,
              );
            if (rig.stats.dropped) throw new Error(`${action}: dropped ${rig.stats.dropped}`);
          }
          t0 += dur + 50;
        });
      }),
      { numRuns: 1000, seed: FC_SEED },
    );
    expect(frames).toBe(1000 * 16 * FRACTIONS.length);
  }, 180_000);

  it("every mood × action pair is valid for every fixture", () => {
    for (const { name, value: dna } of loadDnaFixtures()) {
      const rig = createRig(dna);
      let t0 = 0;
      for (const mood of MOODS) {
        for (const action of ACTIONS) {
          rig.apply(turnOf({ mood, action, intensity: 3, fx: "sparkles" }), t0);
          const dur = Math.max(1200, actionDuration(action));
          for (const f of [0.25, 0.5, 0.75]) {
            const bad = checkFrame(rig.commands(t0 + dur * f), rig.tags);
            if (bad.length) throw new Error(`${name} ${mood}/${action}: ${bad.join("; ")}`);
          }
          t0 += dur;
        }
      }
    }
  });

  it("particles never exceed 12 and every fx produces some", () => {
    const dna = loadDnaFixtures()[1]!.value;
    for (const fx of FXS) {
      const rig = createRig(dna);
      rig.apply(turnOf({ fx, say: "x".repeat(60) }), 0);
      let max = 0;
      for (let t = 0; t < 5000; t += 100) {
        rig.commands(t);
        max = Math.max(max, rig.stats.particles);
      }
      expect(max).toBeLessThanOrEqual(12);
      if (fx !== "none") expect(max, fx).toBeGreaterThan(0);
    }
  });
});

describe("determinism", () => {
  it("same (dna, turn, t) yields the same command list", () => {
    for (const { value: dna } of loadDnaFixtures()) {
      const turn = loadTurnFixtures()[1]!.value;
      const a = createRig(dna);
      const b = createRig(dna);
      a.apply(turn, 0);
      b.apply(turn, 0);
      for (let t = 0; t < 4000; t += 16) expect(a.commands(t)).toEqual(b.commands(t));
    }
  });

  it("frame rate does not change the picture (60 fps vs 15 fps at shared times)", () => {
    const dna = loadDnaFixtures()[4]!.value;
    const turn = loadTurnFixtures()[2]!.value;
    const fast = createRig(dna);
    const slow = createRig(dna);
    fast.apply(turn, 0);
    slow.apply(turn, 0);
    for (let t = 0; t <= 6000; t += 1000 / 60) {
      const cmds = fast.commands(t);
      const shared =
        Math.round(t * 15) % 1000 === 0 ||
        Math.abs((t * 15) / 1000 - Math.round((t * 15) / 1000)) < 1e-9;
      if (shared) expect(slow.commands(t)).toEqual(cmds);
    }
  });
});

describe("beats", () => {
  const dna = loadDnaFixtures()[0]!.value;

  it("a beat lasts max(action, 1200 + 55 × say.length)", () => {
    expect(beatDuration(turnOf({ say: "" }).beats[0]!)).toBe(1200);
    expect(beatDuration(turnOf({ say: "abcd" }).beats[0]!)).toBe(1200 + 55 * 4);
    expect(beatDuration(turnOf({ action: "sleep" }).beats[0]!)).toBe(actionDuration("sleep"));
  });

  it("plays beats in sequence and reports typewriter progress", () => {
    const rig = createRig(dna);
    const turn = turnOf({ mood: "surprised", say: "Oh?" }, { mood: "happy", say: "Hello!" });
    rig.apply(turn, 1000);
    expect(rig.status(999).beat).toBeNull();
    const d0 = beatDuration(turn.beats[0]!);
    expect(rig.status(1000).index).toBe(0);
    expect(rig.status(1000).typed).toBe(1);
    expect(rig.status(1000 + d0 - 1).typed).toBe(3);
    expect(rig.status(1000 + d0).index).toBe(1);
    expect(rig.status(1000 + d0).beat?.say).toBe("Hello!");
    expect(rig.status(1000 + d0 + beatDuration(turn.beats[1]!)).busy).toBe(false);
  });

  it("decays back to the base mood after the last beat", () => {
    const withTurn = createRig(dna);
    const idle = createRig(dna);
    withTurn.apply(turnOf({ mood: "surprised", intensity: 3 }), 0);
    const end = 1200 + 4000 + 1500;
    for (let t = 0; t <= end; t += 50) {
      withTurn.commands(t);
      idle.commands(t);
    }
    const a = withTurn
      .commands(end)
      .flat()
      .filter((x): x is number => typeof x === "number");
    const b = idle
      .commands(end)
      .flat()
      .filter((x): x is number => typeof x === "number");
    expect(a.length).toBe(b.length);
    const maxDiff = Math.max(...a.map((x, i) => Math.abs(x - b[i]!)));
    expect(maxDiff).toBeLessThan(0.05);
  });

  it("a new turn replaces the one in progress", () => {
    const rig = createRig(dna);
    rig.apply(turnOf({ say: "first" }, { say: "second" }), 0);
    rig.apply(turnOf({ say: "interrupt" }), 500);
    expect(rig.status(600).beat?.say).toBe("interrupt");
    expect(rig.status(600).count).toBe(1);
  });

  it("junk turns are normalized, never thrown on", () => {
    const rig = createRig(dna);
    rig.apply({ nonsense: true } as unknown as Turn, 0);
    expect(checkFrame(rig.commands(100), rig.tags)).toEqual([]);
  });
});

describe("touch reactions", () => {
  it("each touch kind reacts instantly with valid frames", () => {
    for (const kind of TOUCH_KINDS) {
      const rig = createRig(loadDnaFixtures()[1]!.value);
      rig.commands(0);
      rig.touch(kind, 0);
      for (let t = 0; t < 1600; t += 100) expect(checkFrame(rig.commands(t), rig.tags)).toEqual([]);
    }
  });

  it("pet shows hearts; a grumpy pal answers a poke with anger", () => {
    const sweet = createRig(loadDnaFixtures()[1]!.value); // Mochi, grumpy 0
    sweet.touch("pet", 0);
    sweet.commands(500);
    expect(sweet.stats.particles).toBeGreaterThan(0);
    const grumpy = createRig(loadDnaFixtures()[0]!.value); // Prickles, grumpy 8
    grumpy.touch("poke", 0);
    const cmds = grumpy.commands(400);
    expect(grumpy.stats.particles).toBe(1);
    expect(cmds.some((c) => c[0] === "arc" && c[7] === 7)).toBe(true); // anger vein arcs in fx colour
  });

  it("touch reactions do not report as conversational beats", () => {
    const rig = createRig(loadDnaFixtures()[1]!.value);
    rig.touch("feed", 0);
    expect(rig.status(100).beat).toBeNull();
  });
});
