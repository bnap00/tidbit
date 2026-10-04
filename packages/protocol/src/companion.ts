import { Type, type Static } from "typebox";
import { fnv1a } from "./prng.js";
import type { DNA, Needs } from "./schema.js";
import type { Mood } from "./enums.js";
import { StringEnum } from "./schema.js";

export const PersonalitySchema = Type.Object(
  {
    humor: StringEnum(["gentle", "dry", "silly"] as const),
    speech: StringEnum(["quiet", "warm", "animated"] as const),
    interests: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
      minItems: 1,
      maxItems: 4,
    }),
    likes: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { minItems: 1, maxItems: 4 }),
    dislikes: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
      minItems: 1,
      maxItems: 4,
    }),
    quirk: Type.String({ minLength: 1, maxLength: 180 }),
    ritual: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
);
export type Personality = Static<typeof PersonalitySchema>;

/** Stable tastes complement the DNA; changes in mood never rewrite the character. */
export function personalityFor(dna: DNA): Personality {
  const choose = (items: readonly string[], salt: string) =>
    items[fnv1a(`${dna.seed}:${salt}`) % items.length]!;
  const cactus = /cactus|prickl/i.test(dna.persona);
  return {
    humor: dna.temper.grumpy >= 7 ? "dry" : dna.temper.playful >= 6 ? "silly" : "gentle",
    speech: dna.temper.shy >= 7 ? "quiet" : dna.temper.energy >= 7 ? "animated" : "warm",
    interests: [
      choose(
        ["stargazing", "tiny inventions", "gardening", "music", "cloud watching", "stories"],
        "interest",
      ),
    ],
    likes: [
      cactus
        ? "sunny windows"
        : choose(
            ["warm blankets", "head pats", "rainy afternoons", "crunchy snacks", "quiet company"],
            "like",
          ),
    ],
    dislikes: [
      cactus
        ? "too much water"
        : choose(["loud surprises", "being rushed", "cold snacks", "messy goodbyes"], "dislike"),
    ],
    quirk:
      dna.temper.grumpy >= 7
        ? "Pretends not to enjoy affection, but quietly leans into it."
        : dna.temper.shy >= 7
          ? "Glances away before sharing something heartfelt."
          : "Collects little observations and shares them when the moment fits.",
    ritual: choose(
      [
        "Share one tiny good thing from the day",
        "Invent a name for a passing cloud",
        "A little stretch and a snack break",
        "Say goodnight to the stars",
      ],
      "ritual",
    ),
  };
}

export interface ChatLine {
  id: number;
  conversationId: string;
  requestId: string | null;
  who: "you" | "pal" | "note";
  text: string;
  createdAt: number;
}
export interface ConversationInfo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Visible chat lines in the conversation. */
  messages: number;
  /** The latest line, trimmed, for browsing. */
  preview: string;
}
export interface PalInfo {
  id: string;
  name: string;
  persona: string;
  /** For drawing an avatar. */
  dna: DNA;
  /** Last conversation activity, or adoption time. */
  lastActive: number;
}
export interface CompanionState {
  revision: number;
  dna: DNA;
  needs: Needs;
  growth: number;
  personality: Personality;
  relationship: { stage: string; interactions: number; ritual: string };
  mood: Mood;
  conversationId: string;
  conversations: ConversationInfo[];
  pals: PalInfo[];
  lines: ChatLine[];
  hasOlder: boolean;
}
export interface MemoryInfo {
  id: number;
  fact: string;
  tags: string[];
  createdAt: number;
}
