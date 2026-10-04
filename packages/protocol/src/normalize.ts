// normalize*(): turn anything into a strictly valid payload. Never throws (PLAN 3.1).
import {
  ACCESSORIES,
  ACTIONS,
  BODIES,
  BONDS,
  BROWS,
  EARS,
  EYES,
  FXS,
  LIMBS,
  LOOKS,
  MARKINGS,
  MOODS,
  MOUTHS,
  SCHEMES,
  TAILS,
  TIMBRES,
  type Mood,
  type Timbre,
} from "./enums.js";
import {
  BEATS_MAX,
  DIGIT_MAX,
  HUE_MAX,
  INTENSITY_MAX,
  INTENSITY_MIN,
  NAME_MAX,
  NEED_MAX,
  PERSONA_MAX,
  SAY_MAX,
  UINT32_MAX,
} from "./limits.js";
import { fnv1a } from "./prng.js";
import type { Beat, DNA, Needs, Turn } from "./schema.js";

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Some providers hand tool arguments over as a JSON string. */
function unwrap(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function get(o: unknown, key: string): unknown {
  if (!isObj(o)) return undefined;
  // Own properties only; never walk the prototype chain for keys like "__proto__".
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

export function toInt(x: unknown, min: number, max: number, dflt: number): number {
  let n: number;
  if (typeof x === "number") n = x;
  else if (typeof x === "string" && x.trim() !== "") n = Number(x.trim());
  else return dflt;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function toEnum<T extends string>(x: unknown, values: readonly T[], dflt: T): T {
  if (typeof x !== "string") return dflt;
  const s = x.trim().toLowerCase();
  return (values as readonly string[]).includes(s) ? (s as T) : dflt;
}

/**
 * Coerce to a single-line string of at most `max` code points. Control
 * characters become spaces; runs of whitespace collapse.
 */
export function toText(x: unknown, max: number, dflt = ""): string {
  if (typeof x !== "string") {
    if (typeof x === "number" && Number.isFinite(x)) x = String(x);
    else return dflt;
  }
  const clean = (x as string)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cps = Array.from(clean);
  if (cps.length <= max) return clean;
  return cps.slice(0, max).join("").trimEnd();
}

// ---------------------------------------------------------------------------
// DNA
// ---------------------------------------------------------------------------

export const DEFAULT_DNA: DNA = {
  v: 1,
  id: "pal_default",
  name: "Pal",
  seed: 1,
  look: {
    body: "blob",
    size: 5,
    plump: 5,
    eyes: "round",
    eyeSize: 5,
    eyeGap: 5,
    brows: "none",
    mouth: "smile",
    ears: "none",
    limbs: "nubs",
    tail: "none",
    marking: "none",
    accessory: "none",
    hue: 200,
    scheme: "analogous",
  },
  temper: { energy: 5, playful: 5, shy: 5, grumpy: 2, curious: 5 },
  baseMood: "neutral",
  persona: "",
  voice: { pitch: 5, speed: 5, timbre: "warm" },
};

/**
 * A voice that fits a temperament, for pals whose DNA has no timbre yet (created before
 * timbres existed, random pals, v1 share codes). The model picks one for new pals.
 */
export function timbreFor(
  temper: DNA["temper"],
  pitch: number,
  seed: number,
  persona = "",
): Timbre {
  // Pronouns in the persona beat the pitch digit for a woman's or man's voice.
  const high = /\b(she|her|hers)\b/i.test(persona)
    ? true
    : /\b(he|him|his)\b/i.test(persona)
      ? false
      : pitch >= 5;
  if (temper.grumpy >= 6) return high ? "bright" : "gruff";
  if (temper.shy >= 7) return "soft";
  if (temper.energy >= 7 && temper.playful >= 6) return high ? "bubbly" : "impish";
  if (temper.energy <= 3) return high ? "calm" : "gent";
  if (temper.curious >= 7) return high ? "posh" : "storyteller";
  return high ? (seed % 2 ? "warm" : "bright") : seed % 2 ? "buddy" : "impish";
}

const ID_RE = /^pal_[a-z0-9]{1,24}$/;

export function idFromSeed(seed: number): string {
  return `pal_${(seed >>> 0).toString(36)}`;
}

function stableHash(raw: unknown): number {
  try {
    return fnv1a(JSON.stringify(raw) ?? "");
  } catch {
    return 1;
  }
}

export interface NormalizeDnaOptions {
  /** Overrides whatever `raw` says. The brain always passes this. */
  id?: string;
  /** Overrides whatever `raw` says. The brain always passes this. */
  seed?: number;
}

export function normalizeDna(input: unknown, opts: NormalizeDnaOptions = {}): DNA {
  const raw = unwrap(input);
  const d = DEFAULT_DNA;
  const look = get(raw, "look");
  const temper = get(raw, "temper");
  const voice = get(raw, "voice");
  const digit = (o: unknown, k: string, dflt: number) => toInt(get(o, k), 0, DIGIT_MAX, dflt);

  const rawSeed = get(raw, "seed");
  const seed =
    opts.seed !== undefined
      ? toInt(opts.seed, 0, UINT32_MAX, 1)
      : typeof rawSeed === "number" &&
          Number.isInteger(rawSeed) &&
          rawSeed >= 0 &&
          rawSeed <= UINT32_MAX
        ? rawSeed
        : stableHash(raw);
  const rawId = get(raw, "id");
  const id =
    opts.id !== undefined && ID_RE.test(opts.id)
      ? opts.id
      : typeof rawId === "string" && ID_RE.test(rawId)
        ? rawId
        : idFromSeed(seed);

  const persona = toText(get(raw, "persona"), PERSONA_MAX);
  const temperOut = {
    energy: digit(temper, "energy", d.temper.energy),
    playful: digit(temper, "playful", d.temper.playful),
    shy: digit(temper, "shy", d.temper.shy),
    grumpy: digit(temper, "grumpy", d.temper.grumpy),
    curious: digit(temper, "curious", d.temper.curious),
  };

  return {
    v: 1,
    id,
    name: toText(get(raw, "name"), NAME_MAX) || d.name,
    seed,
    look: {
      body: toEnum(get(look, "body"), BODIES, d.look.body),
      size: digit(look, "size", d.look.size),
      plump: digit(look, "plump", d.look.plump),
      eyes: toEnum(get(look, "eyes"), EYES, d.look.eyes),
      eyeSize: digit(look, "eyeSize", d.look.eyeSize),
      eyeGap: digit(look, "eyeGap", d.look.eyeGap),
      brows: toEnum(get(look, "brows"), BROWS, d.look.brows),
      mouth: toEnum(get(look, "mouth"), MOUTHS, d.look.mouth),
      ears: toEnum(get(look, "ears"), EARS, d.look.ears),
      limbs: toEnum(get(look, "limbs"), LIMBS, d.look.limbs),
      tail: toEnum(get(look, "tail"), TAILS, d.look.tail),
      marking: toEnum(get(look, "marking"), MARKINGS, d.look.marking),
      accessory: toEnum(get(look, "accessory"), ACCESSORIES, d.look.accessory),
      hue: normalizeHue(get(look, "hue"), d.look.hue),
      scheme: toEnum(get(look, "scheme"), SCHEMES, d.look.scheme),
    },
    temper: temperOut,
    baseMood: toEnum(get(raw, "baseMood"), MOODS, d.baseMood),
    persona,
    voice: {
      pitch: digit(voice, "pitch", d.voice.pitch),
      speed: digit(voice, "speed", d.voice.speed),
      timbre: TIMBRES.includes(get(voice, "timbre") as Timbre)
        ? (get(voice, "timbre") as Timbre)
        : timbreFor(temperOut, digit(voice, "pitch", d.voice.pitch), seed, persona),
    },
  };
}

/** Hue wraps rather than clamps: 370 is 10, -30 is 330. */
function normalizeHue(x: unknown, dflt: number): number {
  const n = toInt(x, -1e9, 1e9, Number.NaN);
  if (Number.isNaN(n)) return dflt;
  return ((n % (HUE_MAX + 1)) + (HUE_MAX + 1)) % (HUE_MAX + 1);
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export const DEFAULT_BEAT: Beat = {
  mood: "neutral",
  intensity: 2,
  say: "",
  action: "none",
  look: "user",
  fx: "none",
};

export function normalizeBeat(input: unknown, fallbackMood: Mood = "neutral"): Beat {
  const raw = unwrap(input);
  if (typeof raw === "string")
    return { ...DEFAULT_BEAT, mood: fallbackMood, say: toText(raw, SAY_MAX) };
  return {
    mood: toEnum(get(raw, "mood"), MOODS, fallbackMood),
    intensity: toInt(get(raw, "intensity"), INTENSITY_MIN, INTENSITY_MAX, DEFAULT_BEAT.intensity),
    say: toText(get(raw, "say"), SAY_MAX),
    action: toEnum(get(raw, "action"), ACTIONS, DEFAULT_BEAT.action),
    look: toEnum(get(raw, "look"), LOOKS, DEFAULT_BEAT.look),
    fx: toEnum(get(raw, "fx"), FXS, DEFAULT_BEAT.fx),
  };
}

export function normalizeTurn(input: unknown, fallbackMood: Mood = "neutral"): Turn {
  const raw = unwrap(input);
  let beatsRaw = get(raw, "beats");
  beatsRaw = unwrap(beatsRaw);
  let list: unknown[];
  if (Array.isArray(beatsRaw)) list = beatsRaw;
  else if (isObj(beatsRaw)) list = [beatsRaw];
  // A bare beat at the top level ({ mood, say, ... }) is a common model mistake.
  else if (isObj(raw) && ("mood" in raw || "say" in raw)) list = [raw];
  else list = [];
  const beats = list.slice(0, BEATS_MAX).map((b) => normalizeBeat(b, fallbackMood));
  if (beats.length === 0) beats.push({ ...DEFAULT_BEAT, mood: fallbackMood });
  return { v: 1, beats, bond: toEnum(get(raw, "bond"), BONDS, "same") };
}

/** Split plain text into beats of at most SAY_MAX characters (PiBrain resolution step 2). */
export function textToTurn(text: string, mood: Mood = "neutral"): Turn {
  const clean = toText(text, SAY_MAX * BEATS_MAX * 4);
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > 0 && chunks.length < BEATS_MAX) {
    const cps = Array.from(rest);
    if (cps.length <= SAY_MAX) {
      chunks.push(rest);
      break;
    }
    const window = cps.slice(0, SAY_MAX).join("");
    // Prefer to break after a sentence end, then at a space.
    let cut = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
    );
    cut = cut > SAY_MAX / 3 ? cut + 1 : window.lastIndexOf(" ");
    if (cut <= 0) cut = window.length;
    let chunk = window.slice(0, cut).trim();
    rest = rest.slice(cut).trim();
    if (chunks.length === BEATS_MAX - 1 && rest.length > 0) {
      chunk = toText(chunk, SAY_MAX - 1) + "…";
    }
    chunks.push(chunk);
  }
  const beats = chunks.map((say) => ({ ...DEFAULT_BEAT, mood, say: toText(say, SAY_MAX) }));
  if (beats.length === 0) beats.push({ ...DEFAULT_BEAT, mood });
  return { v: 1, beats, bond: "same" };
}

/** The canned turn used when the model fails completely (PLAN 5.2 step 3). */
export const FALLBACK_TURN: Turn = {
  v: 1,
  beats: [
    { mood: "confused", intensity: 2, say: "…", action: "shake", look: "user", fx: "question" },
  ],
  bond: "same",
};

// ---------------------------------------------------------------------------
// Needs
// ---------------------------------------------------------------------------

export const DEFAULT_NEEDS: Needs = { energy: 80, hunger: 20, bond: 50 };

export function normalizeNeeds(input: unknown): Needs {
  const raw = unwrap(input);
  return {
    energy: toInt(get(raw, "energy"), 0, NEED_MAX, DEFAULT_NEEDS.energy),
    hunger: toInt(get(raw, "hunger"), 0, NEED_MAX, DEFAULT_NEEDS.hunger),
    bond: toInt(get(raw, "bond"), 0, NEED_MAX, DEFAULT_NEEDS.bond),
  };
}
