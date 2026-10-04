import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Value } from "typebox/value";
import {
  DnaSchema,
  LlmDnaSchema,
  decodeDnaCode,
  encodeDnaCode,
  idFromSeed,
  normalizeDna,
  randomDna,
  timbreFor,
} from "../src/index.js";
import { loadDnaFixtures } from "../src/fixtures-node.js";

describe("DNA codes", () => {
  it.each(loadDnaFixtures().map((f) => [f.name, f.value] as const))(
    "%s round-trips with and without persona",
    (_n, dna) => {
      const withPersona = decodeDnaCode(encodeDnaCode(dna, { persona: true }));
      expect(withPersona).toEqual({ ...dna, id: idFromSeed(dna.seed) });
      const short = decodeDnaCode(encodeDnaCode(dna));
      expect(short).toEqual({ ...dna, id: idFromSeed(dna.seed), persona: "" });
    },
  );

  it("still decodes v1 codes (before timbre), deriving a timbre from the temperament", () => {
    const prickles = loadDnaFixtures()[0]!.value;
    // Prickles encoded by the v1 format, without persona.
    const old = decodeDnaCode("FJEkoZGRUNChTQ4Txu82IAhQcmlja2xlcw");
    expect(old).toEqual({
      ...prickles,
      id: idFromSeed(prickles.seed),
      persona: "",
      voice: { ...prickles.voice, timbre: timbreFor(prickles.temper, 3, prickles.seed) },
    });
    expect(old?.voice.timbre).toBe("gruff");
  });

  it("the model picks a timbre; pals without one get one that fits", () => {
    expect(LlmDnaSchema.properties.voice.required).toContain("timbre");
    const shy = normalizeDna({ temper: { shy: 9, grumpy: 0 }, voice: { pitch: 8 } });
    expect(shy.voice.timbre).toBe("soft");
    const chef = { temper: { energy: 9, playful: 8, grumpy: 0, shy: 1 }, voice: { pitch: 8 } };
    expect(normalizeDna({ ...chef, persona: "He cooks." }).voice.timbre).toBe("impish");
    expect(normalizeDna({ ...chef, persona: "She cooks." }).voice.timbre).toBe("bubbly");
    const kept = normalizeDna({ voice: { timbre: "posh" } });
    expect(kept.voice.timbre).toBe("posh");
    const junk = normalizeDna({ voice: { timbre: "robot" } });
    expect(Value.Check(DnaSchema, junk)).toBe(true);
  });

  it("is short and URL-safe", () => {
    for (let i = 0; i < 200; i++) {
      const code = encodeDnaCode(randomDna(i));
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(code.length).toBeLessThanOrEqual(40);
    }
  });

  it("round-trips unicode names", () => {
    const dna = { ...randomDna(3), name: "Ñoño 🐱" };
    expect(decodeDnaCode(encodeDnaCode(dna))?.name).toBe("Ñoño 🐱");
  });

  it("decoding junk never throws and never yields an invalid DNA", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.base64String(), fc.stringMatching(/^[A-Za-z0-9_-]{0,80}$/)),
        (s) => {
          const d = decodeDnaCode(s);
          return d === null || Value.Check(DnaSchema, d);
        },
      ),
      { numRuns: 3000, seed: 7 },
    );
    expect(decodeDnaCode("")).toBeNull();
    expect(decodeDnaCode("not a code!")).toBeNull();
    // Truncated codes are rejected rather than half-decoded.
    const code = encodeDnaCode(randomDna(9));
    expect(decodeDnaCode(code.slice(0, 6))).toBeNull();
  });
});
