import { describe, expect, it } from "vitest";
import { personalityFor } from "@tidbit/protocol";
import { loadDnaFixtures } from "@tidbit/protocol/fixtures";
import { createRig } from "../src/index.js";
import { checkFrame } from "./check-frame.js";

describe("attention and physical reactions", () => {
  it("smooths pointer attention and typing while keeping every fixture inside the stage", () => {
    for (const { value: dna } of loadDnaFixtures()) {
      const rig = createRig(dna);
      rig.setPersonality({ ...personalityFor(dna), speech: "animated" });
      for (const [x, y] of [
        [-1, -1],
        [1, 1],
        [99, -99],
        [NaN, Infinity],
      ]) {
        rig.setAttention(x!, y!);
        for (const t of [0, 100, 400, 900])
          expect(checkFrame(rig.commands(t), rig.tags)).toEqual([]);
      }
      rig.setTyping(true);
      for (const t of [1000, 1300, 1600]) expect(checkFrame(rig.commands(t), rig.tags)).toEqual([]);
      rig.setTyping(false);
      rig.setAttention(null);
      rig.setNeeds({ energy: 10, hunger: 80, bond: 90 });
      for (const kind of ["pet", "poke", "feed"] as const) {
        rig.touch(kind, 2000);
        for (const t of [2000, 2100, 2400, 3000, 5000])
          expect(checkFrame(rig.commands(t), rig.tags)).toEqual([]);
      }
    }
  });
  it("attention changes the face and settles back rather than overriding the whole pose", () => {
    const dna = loadDnaFixtures()[1]!.value;
    const a = createRig(dna),
      b = createRig(dna);
    a.commands(0);
    b.commands(0);
    a.setAttention(1, -1);
    expect(a.commands(500)).not.toEqual(b.commands(500));
    a.setAttention(null);
    a.commands(5000);
    b.commands(5000);
    expect(a.commands(6000)).toEqual(b.commands(6000));
  });
});
