import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Value } from "typebox/value";
import {
  ACCESSORIES,
  ACTIONS,
  BODIES,
  BROWS,
  DnaSchema,
  EARS,
  EYES,
  FXS,
  LIMBS,
  LOOKS,
  LlmDnaSchema,
  LlmTurnSchema,
  MARKINGS,
  MOODS,
  MOUTHS,
  NeedsSchema,
  SAY_MAX,
  SCHEMES,
  TAILS,
  TurnSchema,
  FALLBACK_TURN,
  normalizeDna,
  normalizeNeeds,
  normalizeTurn,
  textToTurn,
} from "../src/index.js";
import { loadDnaFixtures, loadJunkFixtures, loadTurnFixtures } from "../src/fixtures-node.js";

const dnas = loadDnaFixtures();
const turns = loadTurnFixtures();
const junk = loadJunkFixtures();

describe("fixtures", () => {
  it("has at least 12 DNAs and 20 turns", () => {
    expect(dnas.length).toBeGreaterThanOrEqual(12);
    expect(turns.length).toBeGreaterThanOrEqual(20);
    expect(junk.length).toBeGreaterThan(0);
  });

  it.each(dnas.map((d) => [d.name, d.value] as const))(
    "DNA %s is strictly valid and round-trips",
    (_n, dna) => {
      expect([...Value.Errors(DnaSchema, dna)]).toEqual([]);
      expect(normalizeDna(dna)).toEqual(dna);
      expect(JSON.parse(JSON.stringify(dna))).toEqual(dna);
    },
  );

  it.each(turns.map((t) => [t.name, t.value] as const))(
    "Turn %s is strictly valid and round-trips",
    (_n, turn) => {
      expect([...Value.Errors(TurnSchema, turn)]).toEqual([]);
      expect(normalizeTurn(turn)).toEqual(turn);
    },
  );

  it("DNA fixtures cover every enum value", () => {
    const seen = (f: (d: (typeof dnas)[number]["value"]) => string) =>
      new Set(dnas.map((d) => f(d.value)));
    const cases: [readonly string[], Set<string>][] = [
      [BODIES, seen((d) => d.look.body)],
      [EYES, seen((d) => d.look.eyes)],
      [BROWS, seen((d) => d.look.brows)],
      [MOUTHS, seen((d) => d.look.mouth)],
      [EARS, seen((d) => d.look.ears)],
      [LIMBS, seen((d) => d.look.limbs)],
      [TAILS, seen((d) => d.look.tail)],
      [MARKINGS, seen((d) => d.look.marking)],
      [ACCESSORIES, seen((d) => d.look.accessory)],
      [SCHEMES, seen((d) => d.look.scheme)],
      [MOODS, seen((d) => d.baseMood)],
    ];
    for (const [values, got] of cases) expect([...values].filter((v) => !got.has(v))).toEqual([]);
  });

  it("Turn fixtures cover every mood, action, look and fx", () => {
    const beats = turns.flatMap((t) => t.value.beats);
    const miss = (values: readonly string[], got: string[]) =>
      values.filter((v) => !got.includes(v));
    expect(
      miss(
        MOODS,
        beats.map((b) => b.mood),
      ),
    ).toEqual([]);
    expect(
      miss(
        ACTIONS,
        beats.map((b) => b.action),
      ),
    ).toEqual([]);
    expect(
      miss(
        LOOKS,
        beats.map((b) => b.look),
      ),
    ).toEqual([]);
    expect(
      miss(
        FXS,
        beats.map((b) => b.fx),
      ),
    ).toEqual([]);
  });
});

describe("normalize", () => {
  const strictDna = (x: unknown) => Value.Check(DnaSchema, normalizeDna(x));
  const strictTurn = (x: unknown) => Value.Check(TurnSchema, normalizeTurn(x));

  it.each(junk.map((j) => [j.name, j.value] as const))(
    "junk %s normalizes to valid payloads",
    (_n, text) => {
      const raw = JSON.parse(text) as unknown;
      expect(strictDna(raw)).toBe(true);
      expect(strictTurn(raw)).toBe(true);
      expect(Value.Check(NeedsSchema, normalizeNeeds(raw))).toBe(true);
    },
  );

  it("does not pollute prototypes", () => {
    normalizeDna(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("repairs typical model mistakes", () => {
    const t = normalizeTurn({
      beats: [{ mood: " Happy ", intensity: "3", say: 7, action: "WAVE" }],
    });
    expect(t.beats[0]).toMatchObject({ mood: "happy", intensity: 3, say: "7", action: "wave" });
    expect(normalizeTurn({ mood: "sad", say: "bare" }).beats[0]?.mood).toBe("sad");
    expect(normalizeTurn('{"beats":[{"mood":"love"}]}').beats[0]?.mood).toBe("love");
    expect(normalizeDna({ look: { hue: 370 } }).look.hue).toBe(10);
    expect(normalizeDna({ look: { hue: -30 } }).look.hue).toBe(330);
    expect(normalizeDna({ look: { size: 12.7 } }).look.size).toBe(9);
  });

  it("brain-assigned id and seed override the payload", () => {
    const d = normalizeDna({ id: "pal_llm", seed: 5 }, { id: "pal_brain", seed: 42 });
    expect(d.id).toBe("pal_brain");
    expect(d.seed).toBe(42);
  });

  it("fuzz: 10,000 arbitrary JSON values never throw and always validate", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (x) => strictDna(x) && strictTurn(x)),
      { numRuns: 5_000 },
    );
    // Shaped junk reaches deeper into the normalizers than fully random JSON.
    const beat = fc.record(
      {
        mood: fc.oneof(fc.constantFrom(...MOODS), fc.jsonValue()),
        intensity: fc.jsonValue(),
        say: fc.oneof(fc.string({ maxLength: 400 }), fc.jsonValue()),
        action: fc.jsonValue(),
        look: fc.jsonValue(),
        fx: fc.jsonValue(),
      },
      { requiredKeys: [] },
    );
    const shaped = fc.record(
      {
        beats: fc.oneof(
          fc.array(fc.oneof(beat, fc.jsonValue()), { maxLength: 8 }),
          beat,
          fc.jsonValue(),
        ),
        bond: fc.jsonValue(),
        name: fc.oneof(
          fc.string({ maxLength: 60 }),
          fc.string({ unit: "grapheme", maxLength: 40 }),
        ),
        look: fc.dictionary(
          fc.constantFrom("body", "size", "hue", "eyes", "scheme", "plump"),
          fc.jsonValue(),
        ),
        temper: fc.dictionary(
          fc.constantFrom("energy", "shy", "grumpy"),
          fc.oneof(fc.double(), fc.jsonValue()),
        ),
        seed: fc.oneof(fc.double(), fc.integer(), fc.jsonValue()),
        id: fc.oneof(fc.string(), fc.jsonValue()),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(shaped, (x) => strictDna(x) && strictTurn(x)),
      { numRuns: 5_000 },
    );
  });
});

describe("textToTurn", () => {
  it("splits long text into at most 3 beats of at most 140 chars", () => {
    const long = "This is a sentence. ".repeat(40);
    const t = textToTurn(long, "happy");
    expect(Value.Check(TurnSchema, t)).toBe(true);
    expect(t.beats.length).toBe(3);
    for (const b of t.beats) expect(Array.from(b.say).length).toBeLessThanOrEqual(SAY_MAX);
    expect(t.beats[0]?.mood).toBe("happy");
  });
  it("keeps short text in one beat and never produces an empty turn", () => {
    expect(textToTurn("Hi!").beats).toHaveLength(1);
    expect(textToTurn("").beats).toHaveLength(1);
  });
  it("fallback turn is valid", () => {
    expect(Value.Check(TurnSchema, FALLBACK_TURN)).toBe(true);
  });
});

describe("LLM schemas", () => {
  // Only the portable subset (PLAN 3.1): no numeric ranges, lengths, or array sizes.
  const FORBIDDEN = [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
    "anyOf",
    "oneOf",
    "const",
  ];
  function walk(x: unknown, path: string, out: string[]) {
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (FORBIDDEN.includes(k)) out.push(`${path}.${k}`);
      walk(v, `${path}.${k}`, out);
    }
  }
  it.each([
    ["LlmDnaSchema", LlmDnaSchema],
    ["LlmTurnSchema", LlmTurnSchema],
  ])("%s uses only types and enums", (_n, schema) => {
    const bad: string[] = [];
    walk(JSON.parse(JSON.stringify(schema)), "$", bad);
    expect(bad).toEqual([]);
  });
  it("LLM turn schema orders mood before say", () => {
    const keys = Object.keys(LlmTurnSchema.properties.beats.items.properties);
    expect(keys.indexOf("mood")).toBeLessThan(keys.indexOf("say"));
  });
});
