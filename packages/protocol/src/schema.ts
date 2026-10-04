import { Type, type Static, type TSchema } from "typebox";
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
  TIMBRE_HINTS,
} from "./enums.js";
import {
  BEATS_MAX,
  BEATS_MIN,
  DIGIT_MAX,
  HUE_MAX,
  INTENSITY_MAX,
  INTENSITY_MIN,
  NAME_MAX,
  NEED_MAX,
  PERSONA_MAX,
  SAY_MAX,
  TAG_MAX,
  TAGS_MAX,
  UINT32_MAX,
} from "./limits.js";

/**
 * String enum as plain `{ type: "string", enum }`. `Type.Enum` emits
 * `anyOf`/`const`, which some providers reject (PLAN 3).
 */
export function StringEnum<const T extends readonly string[]>(values: T, description?: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(description ? { description } : {}),
  });
}

const Digit = (description?: string) =>
  Type.Integer({ minimum: 0, maximum: DIGIT_MAX, ...(description ? { description } : {}) });

// LLM-facing integers carry the range only as prose (PLAN 3.1).
const LlmDigit = (description: string) => Type.Integer({ description: `0-9. ${description}` });

// ---------------------------------------------------------------------------
// DNA (PLAN 3.2)
// ---------------------------------------------------------------------------

export const LookSchema = Type.Object(
  {
    body: StringEnum(BODIES),
    size: Digit(),
    plump: Digit(),
    eyes: StringEnum(EYES),
    eyeSize: Digit(),
    eyeGap: Digit(),
    brows: StringEnum(BROWS),
    mouth: StringEnum(MOUTHS),
    ears: StringEnum(EARS),
    limbs: StringEnum(LIMBS),
    tail: StringEnum(TAILS),
    marking: StringEnum(MARKINGS),
    accessory: StringEnum(ACCESSORIES),
    hue: Type.Integer({ minimum: 0, maximum: HUE_MAX }),
    scheme: StringEnum(SCHEMES),
  },
  { additionalProperties: false },
);

export const TemperSchema = Type.Object(
  {
    energy: Digit(),
    playful: Digit(),
    shy: Digit(),
    grumpy: Digit(),
    curious: Digit(),
  },
  { additionalProperties: false },
);

export const VoiceSchema = Type.Object(
  { pitch: Digit(), speed: Digit(), timbre: StringEnum(TIMBRES) },
  { additionalProperties: false },
);

export const DnaSchema = Type.Object(
  {
    v: Type.Literal(1),
    id: Type.String({ pattern: "^pal_[a-z0-9]{1,24}$" }),
    name: Type.String({ minLength: 1, maxLength: NAME_MAX }),
    seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    look: LookSchema,
    temper: TemperSchema,
    baseMood: StringEnum(MOODS),
    persona: Type.String({ maxLength: PERSONA_MAX }),
    voice: VoiceSchema,
  },
  { additionalProperties: false },
);

/** What the model fills in when creating a character. No `v`, `id`, or `seed`. */
export const LlmDnaSchema = Type.Object(
  {
    name: Type.String({ description: `Short name, at most ${NAME_MAX} characters.` }),
    look: Type.Object(
      {
        body: StringEnum(BODIES, "Overall body silhouette."),
        size: LlmDigit("Overall scale."),
        plump: LlmDigit("0 = slim and tall, 9 = wide and round."),
        eyes: StringEnum(EYES, "Eye style."),
        eyeSize: LlmDigit("Eye size."),
        eyeGap: LlmDigit("Distance between the eyes."),
        brows: StringEnum(BROWS, "Eyebrows."),
        mouth: StringEnum(MOUTHS, "Mouth style."),
        ears: StringEnum(EARS, "Ears or head feature."),
        limbs: StringEnum(LIMBS, "Arms or equivalent."),
        tail: StringEnum(TAILS, "Tail."),
        marking: StringEnum(MARKINGS, "Body pattern."),
        accessory: StringEnum(ACCESSORIES, "Worn accessory."),
        hue: Type.Integer({
          description: "0-359. Main colour hue in degrees (0 red, 120 green, 240 blue).",
        }),
        scheme: StringEnum(SCHEMES, "How the other colours relate to the main hue."),
      },
      { additionalProperties: false },
    ),
    temper: Type.Object(
      {
        energy: LlmDigit("How lively."),
        playful: LlmDigit("How playful."),
        shy: LlmDigit("How shy."),
        grumpy: LlmDigit("How grumpy."),
        curious: LlmDigit("How curious."),
      },
      { additionalProperties: false },
    ),
    baseMood: StringEnum(MOODS, "Resting mood."),
    persona: Type.String({
      description: `One or two sentences describing the personality, at most ${PERSONA_MAX} characters.`,
    }),
    voice: Type.Object(
      {
        pitch: LlmDigit("Voice pitch."),
        speed: LlmDigit("Speaking speed."),
        timbre: StringEnum(
          TIMBRES,
          `Voice character that fits the personality: ${TIMBRES.map((t) => `${t} = ${TIMBRE_HINTS[t]}`).join("; ")}.`,
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Turn (PLAN 3.3)
// ---------------------------------------------------------------------------

export const BeatSchema = Type.Object(
  {
    mood: StringEnum(MOODS),
    intensity: Type.Integer({ minimum: INTENSITY_MIN, maximum: INTENSITY_MAX }),
    say: Type.String({ maxLength: SAY_MAX }),
    action: StringEnum(ACTIONS),
    look: StringEnum(LOOKS),
    fx: StringEnum(FXS),
  },
  { additionalProperties: false },
);

export const TurnSchema = Type.Object(
  {
    v: Type.Literal(1),
    beats: Type.Array(BeatSchema, { minItems: BEATS_MIN, maxItems: BEATS_MAX }),
    bond: StringEnum(BONDS),
  },
  { additionalProperties: false },
);

// Field order matters: `mood` precedes `say` so streaming can change the face first.
export const LlmBeatSchema = Type.Object(
  {
    mood: StringEnum(MOODS, "Facial expression for this beat."),
    intensity: Type.Integer({ description: "1-3. How strongly the mood shows." }),
    say: Type.String({
      description: `What the pal says, at most ${SAY_MAX} characters. May be empty.`,
    }),
    action: StringEnum(ACTIONS, "Body gesture."),
    look: StringEnum(LOOKS, "Where the pal looks."),
    fx: StringEnum(FXS, "Small visual effect around the pal."),
  },
  { additionalProperties: false },
);

export const LlmTurnSchema = Type.Object(
  {
    beats: Type.Array(LlmBeatSchema, {
      description: `1-${BEATS_MAX} beats played in order, e.g. think, react, answer.`,
    }),
    bond: StringEnum(BONDS, "How this exchange made the pal feel about the user."),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Needs (PLAN 5.6)
// ---------------------------------------------------------------------------

const Need = () => Type.Integer({ minimum: 0, maximum: NEED_MAX });
export const NeedsSchema = Type.Object(
  { energy: Need(), hunger: Need(), bond: Need() },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Memory tool parameters (portable subset, PLAN 5.4)
// ---------------------------------------------------------------------------

export const MemoryTagSchema = Type.String({
  description: `Short tag, at most ${TAG_MAX} characters.`,
});
export const MemoryTagsSchema = Type.Array(MemoryTagSchema, {
  description: `At most ${TAGS_MAX} tags.`,
});

export type DNA = Static<typeof DnaSchema>;
export type Look = Static<typeof LookSchema>;
export type Temper = Static<typeof TemperSchema>;
export type Voice = Static<typeof VoiceSchema>;
export type LlmDNA = Static<typeof LlmDnaSchema>;
export type Beat = Static<typeof BeatSchema>;
export type Turn = Static<typeof TurnSchema>;
export type LlmTurn = Static<typeof LlmTurnSchema>;
export type Needs = Static<typeof NeedsSchema>;

/** Every schema that is published as a JSON Schema file. */
export const PUBLISHED_SCHEMAS: Record<string, TSchema> = {
  dna: DnaSchema,
  "llm-dna": LlmDnaSchema,
  turn: TurnSchema,
  "llm-turn": LlmTurnSchema,
  beat: BeatSchema,
  needs: NeedsSchema,
};
