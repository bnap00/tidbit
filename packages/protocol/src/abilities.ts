// Skills, actions and routines: what a pal can learn and do beyond talking.
// Skills are SKILL.md-style instructions loaded on demand; actions are owner-defined
// HTTP calls; routines are reminders that repeat. None of them can run code.
import { Type, type Static } from "typebox";
import { PersonalitySchema } from "./companion.js";
import { LlmDnaSchema, StringEnum } from "./schema.js";

export const SKILL_NAME_MAX = 40;
export const SKILL_DESCRIPTION_MAX = 200;
export const SKILL_BODY_MAX = 4000;
/** Per pal, so the skills index stays small enough for every prompt. */
export const SKILLS_MAX = 30;
export const ACTIONS_MAX = 20;
export const ACTION_URL_MAX = 500;
export const ACTION_HEADERS_MAX = 1000;
export const ACTION_BODY_MAX = 1000;

export const SKILL_SOURCES = ["owner", "pal", "starter"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];
export const REPEATS = ["none", "hourly", "daily", "weekdays", "weekly"] as const;
export type Repeat = (typeof REPEATS)[number];
export const ACTION_METHODS = ["GET", "POST"] as const;

/** Lowercase kebab-case, as used by SKILL.md `name:` fields. Empty when nothing usable. */
export function skillSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/, "");
}

export const SkillInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: SKILL_NAME_MAX }),
    description: Type.String({ minLength: 1, maxLength: SKILL_DESCRIPTION_MAX }),
    body: Type.String({ minLength: 1, maxLength: SKILL_BODY_MAX }),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SkillInput = Static<typeof SkillInputSchema>;

export const ActionInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: SKILL_NAME_MAX }),
    description: Type.String({ minLength: 1, maxLength: SKILL_DESCRIPTION_MAX }),
    method: StringEnum(ACTION_METHODS),
    url: Type.String({ minLength: 8, maxLength: ACTION_URL_MAX }),
    /** "Name: value" lines. Write-only: never sent back to a browser or the model. */
    headers: Type.Optional(Type.String({ maxLength: ACTION_HEADERS_MAX })),
    /** POST body; `{input}` is replaced by the model's input, JSON-string escaped. */
    bodyTemplate: Type.Optional(Type.String({ maxLength: ACTION_BODY_MAX })),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ActionInput = Static<typeof ActionInputSchema>;

const dnaField = LlmDnaSchema.properties;
/**
 * A change the pal makes to itself on the user's request: only the fields that change.
 * Merged onto the current DNA and personality, then checked strictly; nothing is
 * silently replaced by a default. `id` and `seed` can never change.
 */
export const SelfUpdateSchema = Type.Object(
  {
    name: Type.Optional(dnaField.name),
    persona: Type.Optional(dnaField.persona),
    baseMood: Type.Optional(dnaField.baseMood),
    look: Type.Optional(Type.Partial(dnaField.look)),
    temper: Type.Optional(Type.Partial(dnaField.temper)),
    voice: Type.Optional(Type.Partial(dnaField.voice)),
    personality: Type.Optional(Type.Partial(PersonalitySchema)),
  },
  { additionalProperties: false },
);
export type SelfUpdate = Static<typeof SelfUpdateSchema>;

export interface SkillInfo {
  id: number;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source: SkillSource;
  uses: number;
  updatedAt: number;
}
export interface ActionInfo {
  id: number;
  name: string;
  description: string;
  method: (typeof ACTION_METHODS)[number];
  url: string;
  /** Header names only; values stay on the brain. */
  headerNames: string[];
  bodyTemplate: string;
  enabled: boolean;
  uses: number;
}
export interface RoutineInfo {
  id: number;
  dueAt: number;
  text: string;
  repeat: Repeat;
}
export interface AbilitiesState {
  skills: SkillInfo[];
  actions: ActionInfo[];
  routines: RoutineInfo[];
  /** Built-in abilities available on this brain, for display. */
  builtins: { name: string; description: string }[];
}

/**
 * Parse a SKILL.md (YAML-ish frontmatter with `name` and `description`, then markdown).
 * Also accepts plain markdown: the first heading becomes the name and the first
 * paragraph the description. Total: returns undefined instead of throwing.
 */
export function parseSkillMarkdown(text: string): SkillInput | undefined {
  const src = text.replace(/\r\n?/g, "\n").trim();
  let name = "",
    description = "",
    body = src;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (fm) {
    body = src.slice(fm[0].length).trim();
    for (const line of fm[1]!.split("\n")) {
      const m = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
      if (m[1] === "name") name = value;
      else if (m[1] === "description") description = value;
    }
  }
  if (!name) name = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
  if (!description)
    description =
      body
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .find((p) => p && !p.startsWith("#")) ?? "";
  const slug = skillSlug(name);
  description = description.replace(/\s+/g, " ").trim().slice(0, SKILL_DESCRIPTION_MAX);
  if (!slug || !description || !body) return undefined;
  return { name: slug, description, body: body.slice(0, SKILL_BODY_MAX) };
}

/** The SKILL.md form of a skill, for export and sharing. */
export function skillToMarkdown(skill: Pick<SkillInfo, "name" | "description" | "body">): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\n/g, " ")}\n---\n\n${skill.body.trim()}\n`;
}
