import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MOODS, randomDna } from "@tidbit/protocol";
import { loadDnaFixtures } from "@tidbit/protocol/fixtures";
import { CommandListTarget, IndexedBufferTarget, createRig, moodPose } from "../src/index.js";
import { checkFrame } from "./check-frame.js";
import { FC_SEED, arbDna } from "./arb.js";

describe("static rig", () => {
  const fixtures = loadDnaFixtures();

  it.each(fixtures.map((f) => [f.name, f.value] as const))(
    "fixture %s satisfies the invariants in every mood",
    (_n, dna) => {
      const rig = createRig(dna);
      for (const mood of MOODS) {
        for (const intensity of [1, 2, 3]) {
          rig.setPose(moodPose(mood, intensity));
          const cmds = rig.commands(0);
          expect(checkFrame(cmds, rig.tags), `${mood}/${intensity}`).toEqual([]);
          expect(rig.stats.dropped).toBe(0);
        }
      }
    },
  );

  it("1,000 arbitrary DNAs × 12 moods satisfy the invariants", () => {
    let netUsed = 0;
    fc.assert(
      fc.property(arbDna, (dna) => {
        const rig = createRig(dna);
        for (const mood of MOODS) {
          rig.setPose(moodPose(mood, 3));
          const bad = checkFrame(rig.commands(0), rig.tags);
          if (bad.length) throw new Error(`${JSON.stringify(dna.look)} ${mood}: ${bad.join("; ")}`);
          if (rig.stats.dropped) throw new Error(`dropped ${rig.stats.dropped}`);
          if (rig.stats.netScale < 1) netUsed++;
        }
      }),
      { numRuns: 1000, seed: FC_SEED },
    );
    // The static fit should make the safety net unnecessary for plain moods.
    expect(netUsed).toBe(0);
  });

  it("growth stages re-proportion the pal and keep every invariant", () => {
    fc.assert(
      fc.property(arbDna, fc.constantFrom(0, 1), (dna, stage) => {
        const rig = createRig(dna);
        rig.setGrowth(stage);
        for (const mood of MOODS) {
          rig.setPose(moodPose(mood, 3));
          const bad = checkFrame(rig.commands(0), rig.tags);
          if (bad.length) throw new Error(`stage ${stage} ${mood}: ${bad.join("; ")}`);
        }
      }),
      { numRuns: 300, seed: FC_SEED },
    );
    const dna = randomDna(5);
    const rig = createRig(dna);
    const grown = rig.commands(0);
    rig.setGrowth(0);
    expect(rig.growth).toBe(0);
    expect(rig.commands(0)).not.toEqual(grown);
    rig.setGrowth(2);
    expect(rig.commands(0)).toEqual(grown);
  });

  it("is deterministic: same (dna, t) → same command list", () => {
    for (let i = 0; i < 50; i++) {
      const dna = randomDna(i);
      const a = createRig(dna).commands(1234);
      const b = createRig(dna).commands(1234);
      expect(a).toEqual(b);
    }
  });

  it("two pals with the same parts but different seeds differ", () => {
    const a = fixtures[0]!.value;
    const b = { ...a, seed: a.seed + 1 };
    expect(createRig(a).commands(0)).not.toEqual(createRig(b).commands(0));
  });

  it("frame() through every target produces pixels", () => {
    const rig = createRig(fixtures[1]!.value);
    const list = new CommandListTarget();
    rig.frame(0, list);
    expect(list.cmds.length).toBeGreaterThan(10);
    const buf = new IndexedBufferTarget();
    rig.frame(0, buf);
    const used = new Set(buf.pixels);
    expect(used.size).toBeGreaterThanOrEqual(5);
    // Background in the corner, body in the middle of the pal.
    expect(buf.pixels[0]).toBe(0);
  });
});
