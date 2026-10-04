// Every enum in the protocol. Order is significant: the C++ rig and the
// generated tables index by position, so only ever append.

export const BODIES = ["blob", "round", "tall", "squat", "bean", "ghost", "egg", "square"] as const;
export const EYES = [
  "dot",
  "round",
  "oval",
  "tall",
  "sleepy",
  "sparkle",
  "cyclops",
  "visor",
] as const;
export const BROWS = ["none", "thin", "thick"] as const;
export const MOUTHS = ["smile", "cat", "beak", "fang", "line", "o"] as const;
export const EARS = ["none", "cat", "bunny", "bear", "horn", "antenna", "fin", "leaf"] as const;
export const LIMBS = ["none", "nubs", "arms", "wings", "tentacles", "paws"] as const;
export const TAILS = ["none", "cat", "puff", "devil", "fish", "leaf"] as const;
export const MARKINGS = ["none", "belly", "spots", "stripes", "mask", "freckles"] as const;
export const ACCESSORIES = [
  "none",
  "bow",
  "hat",
  "glasses",
  "scarf",
  "halo",
  "flower",
  "crown",
] as const;
export const SCHEMES = [
  "mono",
  "analogous",
  "complement",
  "triad",
  "pastel",
  "neon",
  "earth",
] as const;

export const MOODS = [
  "neutral",
  "happy",
  "excited",
  "sad",
  "angry",
  "scared",
  "surprised",
  "sleepy",
  "curious",
  "love",
  "confused",
  "proud",
] as const;
export const ACTIONS = [
  "none",
  "nod",
  "shake",
  "jump",
  "spin",
  "wave",
  "dance",
  "wiggle",
  "bow",
  "cheer",
  "think",
  "hide",
  "peek",
  "sleep",
  "eat",
  "shiver",
] as const;
export const LOOKS = ["user", "left", "right", "up", "down", "away"] as const;
export const FXS = [
  "none",
  "hearts",
  "sparkles",
  "zzz",
  "sweat",
  "question",
  "exclaim",
  "notes",
  "anger",
  "tears",
] as const;
export const BONDS = ["down", "same", "up"] as const;
/**
 * The character of a pal's voice. Descriptive rather than engine-specific: the web app
 * maps each one to a Kokoro voice. The model picks one to fit the personality.
 */
export const TIMBRES = [
  "warm",
  "bubbly",
  "soft",
  "calm",
  "bright",
  "posh",
  "gent",
  "storyteller",
  "buddy",
  "gruff",
  "impish",
] as const;
export const TIMBRE_HINTS: Record<(typeof TIMBRES)[number], string> = {
  warm: "friendly, caring young woman",
  bubbly: "excitable, energetic girl",
  soft: "hushed, breathy whisper (shy or sleepy)",
  calm: "gentle, soothing woman",
  bright: "clear, confident woman",
  posh: "polite, proper British woman",
  gent: "dignified older British man",
  storyteller: "whimsical British narrator",
  buddy: "easygoing, friendly young man",
  gruff: "deep, rough, grumbly man",
  impish: "cheeky, playful young man",
};
export const TOUCH_KINDS = ["poke", "pet", "shake", "feed"] as const;

/** Palette slot names; a `Pal` is an index into this list. */
export const PAL_SLOTS = [
  "bg",
  "outline",
  "body",
  "shade",
  "accent",
  "eyeWhite",
  "dark",
  "fx",
] as const;

/** Pose vector channels (PLAN 4.4). Order is the channel index. */
export const POSE_CHANNELS = [
  "eyeOpen",
  "eyeSquint",
  "browAngle",
  "browRaise",
  "pupilSize",
  "gazeX",
  "gazeY",
  "mouthCurve",
  "mouthOpen",
  "bodyY",
  "bodySquash",
  "bodyTilt",
  "earAngle",
  "blush",
  "flipX",
  // Not in PLAN 4.4's list of 15: wave and cheer need arms (see DECISIONS.md).
  "armL",
  "armR",
] as const;

export type Body = (typeof BODIES)[number];
export type Eyes = (typeof EYES)[number];
export type Brows = (typeof BROWS)[number];
export type Mouth = (typeof MOUTHS)[number];
export type Ears = (typeof EARS)[number];
export type Limbs = (typeof LIMBS)[number];
export type Tail = (typeof TAILS)[number];
export type Marking = (typeof MARKINGS)[number];
export type Accessory = (typeof ACCESSORIES)[number];
export type Scheme = (typeof SCHEMES)[number];
export type Mood = (typeof MOODS)[number];
export type Action = (typeof ACTIONS)[number];
export type LookDir = (typeof LOOKS)[number];
export type Fx = (typeof FXS)[number];
export type Bond = (typeof BONDS)[number];
export type Timbre = (typeof TIMBRES)[number];
export type TouchKind = (typeof TOUCH_KINDS)[number];
export type PalSlot = (typeof PAL_SLOTS)[number];
export type PoseChannel = (typeof POSE_CHANNELS)[number];

/**
 * The Kokoro voice for each timbre: the best-graded voice with that character. Shared by
 * the browser's local Kokoro and the brain's speech endpoint for devices.
 */
export const KOKORO_VOICES: Record<Timbre, string> = {
  warm: "af_heart",
  bubbly: "af_bella",
  soft: "af_nicole",
  calm: "af_sarah",
  bright: "af_kore",
  posh: "bf_emma",
  gent: "bm_george",
  storyteller: "bm_fable",
  buddy: "am_michael",
  gruff: "am_fenrir",
  impish: "am_puck",
};
