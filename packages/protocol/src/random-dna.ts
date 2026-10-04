// Deterministic random character from a seed (gallery, brain fallback, "random" button).
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
  type Mood,
} from "./enums.js";
import { idFromSeed, normalizeDna } from "./normalize.js";
import { mulberry32 } from "./prng.js";
import type { DNA } from "./schema.js";

type Rand = () => number;

const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const digit = (r: Rand, lo = 0, hi = 9) => lo + Math.floor(r() * (hi - lo + 1));

/** Pick with weights; `none`-style options are weighted so most pals get some features. */
function weighted<T extends string>(r: Rand, xs: readonly T[], w: Partial<Record<T, number>>): T {
  const weights = xs.map((x) => w[x] ?? 1);
  let t = r() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < xs.length; i++) {
    t -= weights[i]!;
    if (t < 0) return xs[i]!;
  }
  return xs[xs.length - 1]!;
}

const SYLLABLES = [
  "mo",
  "chi",
  "pi",
  "ku",
  "ra",
  "bo",
  "ni",
  "lu",
  "to",
  "ze",
  "fi",
  "ga",
  "po",
  "su",
  "ki",
  "na",
  "bu",
  "mi",
  "do",
  "ri",
];
const ENDINGS = ["", "", "", "n", "p", "o", "y", "ko", "bo", "le"];
const ADJECTIVES = [
  "sleepy",
  "bouncy",
  "grumpy",
  "curious",
  "shy",
  "cheerful",
  "dramatic",
  "gentle",
  "mischievous",
  "brave",
  "fussy",
  "dreamy",
];
const CREATURES = [
  "blob",
  "sprite",
  "critter",
  "puff",
  "gremlin",
  "bean",
  "spirit",
  "noodle",
  "gumdrop",
  "pebble",
];
const HOBBIES = [
  "collects shiny pebbles",
  "hums songs nobody knows",
  "is convinced it can fly",
  "loves naps in sunbeams",
  "asks far too many questions",
  "keeps a secret snack stash",
  "pretends to be very serious",
  "gets excited about weather",
  "writes tiny poems",
  "is afraid of the vacuum cleaner",
];
const BASE_MOODS: readonly Mood[] = [
  "neutral",
  "neutral",
  "happy",
  "happy",
  "curious",
  "sleepy",
  "proud",
  "excited",
  "confused",
  "love",
  "sad",
  "scared",
  "angry",
  "surprised",
];

export function randomName(r: Rand): string {
  const n = 1 + Math.floor(r() * 2);
  let s = "";
  for (let i = 0; i < n; i++) s += pick(r, SYLLABLES);
  s += pick(r, ENDINGS);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A complete, strictly valid DNA derived only from `seed`. */
export function randomDna(seed: number): DNA {
  const r = mulberry32(seed ^ 0x5eed);
  const temper = {
    energy: digit(r),
    playful: digit(r),
    shy: digit(r),
    grumpy: digit(r, 0, 7),
    curious: digit(r),
  };
  const adjective = pick(r, ADJECTIVES);
  const creature = pick(r, CREATURES);
  const raw = {
    name: randomName(r),
    look: {
      body: pick(r, BODIES),
      size: digit(r, 2, 8),
      plump: digit(r),
      eyes: weighted(r, EYES, { cyclops: 0.5, visor: 0.5 }),
      eyeSize: digit(r, 2, 8),
      eyeGap: digit(r, 2, 8),
      brows: weighted(r, BROWS, { none: 2 }),
      mouth: pick(r, MOUTHS),
      ears: weighted(r, EARS, { none: 0.6 }),
      limbs: weighted(r, LIMBS, { none: 0.6 }),
      tail: weighted(r, TAILS, { none: 2 }),
      marking: weighted(r, MARKINGS, { none: 2 }),
      accessory: weighted(r, ACCESSORIES, { none: 3 }),
      hue: Math.floor(r() * 360),
      scheme: pick(r, SCHEMES),
    },
    temper,
    baseMood: pick(r, BASE_MOODS),
    persona: `A ${adjective} little ${creature} who ${pick(r, HOBBIES)}.`,
    voice: { pitch: digit(r), speed: digit(r) },
  };
  return normalizeDna(raw, { seed: seed >>> 0, id: idFromSeed(seed) });
}
