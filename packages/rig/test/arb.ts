import fc from "fast-check";
import {
  ACCESSORIES,
  BODIES,
  BROWS,
  EARS,
  EYES,
  LIMBS,
  MARKINGS,
  MOUTHS,
  SCHEMES,
  TAILS,
  normalizeDna,
  type DNA,
} from "@tidbit/protocol";

/** Arbitrary DNA over the full enum × digit space (including extremes randomDna avoids). */
export const arbDna = fc
  .record({
    seed: fc.nat({ max: 0xffffffff }),
    body: fc.constantFrom(...BODIES),
    eyes: fc.constantFrom(...EYES),
    brows: fc.constantFrom(...BROWS),
    mouth: fc.constantFrom(...MOUTHS),
    ears: fc.constantFrom(...EARS),
    limbs: fc.constantFrom(...LIMBS),
    tail: fc.constantFrom(...TAILS),
    marking: fc.constantFrom(...MARKINGS),
    accessory: fc.constantFrom(...ACCESSORIES),
    scheme: fc.constantFrom(...SCHEMES),
    hue: fc.integer({ min: 0, max: 359 }),
    size: fc.integer({ min: 0, max: 9 }),
    plump: fc.integer({ min: 0, max: 9 }),
    eyeSize: fc.integer({ min: 0, max: 9 }),
    eyeGap: fc.integer({ min: 0, max: 9 }),
  })
  .map(({ seed, ...look }): DNA => normalizeDna({ name: "Fuzz", look }, { seed, id: "pal_fuzz" }));

/** Property tests use a fixed seed so `pnpm verify` is reproducible; set FC_SEED to explore. */
export const FC_SEED = Number(process.env.FC_SEED ?? 20260929);
