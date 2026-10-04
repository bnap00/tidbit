// Emits rig-data.ts and JSON Schema files from the protocol sources.
// Usage: tsx scripts/codegen.ts [--check]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../src/enums.js";
import { PUBLISHED_SCHEMAS } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const root = join(pkg, "..", "..");
const check = process.argv.includes("--check");

type Num = number;
interface RigDataJson {
  pose: { neutral: Record<string, Num>; min: Record<string, Num>; max: Record<string, Num> };
  intensityScale: Num[];
  moods: Record<string, Record<string, Num>>;
  actions: Record<string, { ms: Num; tracks: Record<string, [Num, Num][]> }>;
  schemes: Record<string, Record<string, [Num, Num, Num]>>;
  tables: Record<string, Record<string, Record<string, Num>>>;
  constants?: Record<string, Num>;
  touch: Record<string, Record<string, string | Num>>;
}

/** Part tables are keyed by the enum they describe. */
const TABLE_ENUMS: Record<string, readonly string[]> = {
  body: E.BODIES,
  eyes: E.EYES,
  brows: E.BROWS,
  mouth: E.MOUTHS,
  ears: E.EARS,
  limbs: E.LIMBS,
  tail: E.TAILS,
  marking: E.MARKINGS,
  accessory: E.ACCESSORIES,
  fx: E.FXS,
  action: E.ACTIONS,
  mood: E.MOODS,
  touch: E.TOUCH_KINDS,
};

const errors: string[] = [];
const warnings: string[] = [];
const fail = (m: string) => errors.push(m);

const data = JSON.parse(readFileSync(join(pkg, "rig-data.json"), "utf8")) as RigDataJson;
const CH = E.POSE_CHANNELS as readonly string[];

function channelRow(obj: Record<string, Num>, where: string, fill: Num | null): Num[] {
  for (const k of Object.keys(obj)) if (!CH.includes(k)) fail(`${where}: unknown channel "${k}"`);
  return CH.map((c) => {
    const v = obj[c];
    if (v === undefined) {
      if (fill === null) fail(`${where}: missing channel "${c}"`);
      return fill ?? 0;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) fail(`${where}.${c}: not a finite number`);
    return v;
  });
}

function coverage(obj: object, values: readonly string[], where: string) {
  for (const v of values) if (!(v in obj)) fail(`${where}: missing "${v}"`);
  for (const k of Object.keys(obj)) if (!values.includes(k)) fail(`${where}: unknown key "${k}"`);
}

// --- pose --------------------------------------------------------------------
const poseNeutral = channelRow(data.pose.neutral, "pose.neutral", null);
const poseMin = channelRow(data.pose.min, "pose.min", null);
const poseMax = channelRow(data.pose.max, "pose.max", null);
if (data.intensityScale.length !== 3) fail("intensityScale must have 3 entries");

// --- moods -------------------------------------------------------------------
coverage(data.moods, E.MOODS, "moods");
const moodPose = E.MOODS.map((m) => channelRow(data.moods[m] ?? {}, `moods.${m}`, 0));

// --- actions -----------------------------------------------------------------
coverage(data.actions, E.ACTIONS, "actions");
interface TrackOut {
  channel: number;
  keys: [Num, Num][];
}
const actionMs: Num[] = [];
const actionTracks: TrackOut[][] = [];
for (const a of E.ACTIONS) {
  const act = data.actions[a] ?? { ms: 0, tracks: {} };
  actionMs.push(act.ms);
  const tracks: TrackOut[] = [];
  for (const [ch, keys] of Object.entries(act.tracks)) {
    const idx = CH.indexOf(ch);
    if (idx < 0) fail(`actions.${a}: unknown channel "${ch}"`);
    let prev = -1;
    for (const k of keys) {
      if (!Array.isArray(k) || k.length !== 2) fail(`actions.${a}.${ch}: key must be [t, v]`);
      if (k[0] < prev) fail(`actions.${a}.${ch}: keys not sorted by time`);
      if (k[0] > act.ms) fail(`actions.${a}.${ch}: key at ${k[0]} beyond duration ${act.ms}`);
      prev = k[0];
    }
    tracks.push({ channel: idx, keys });
  }
  actionTracks.push(tracks);
}

// --- schemes -----------------------------------------------------------------
coverage(data.schemes, E.SCHEMES, "schemes");
const schemeHsl = E.SCHEMES.map((s) =>
  E.PAL_SLOTS.map((slot) => {
    const v = data.schemes[s]?.[slot];
    if (!v) {
      warnings.push(`schemes.${s}.${slot} missing; using [0,0,0]`);
      return [0, 0, 0] as [Num, Num, Num];
    }
    if (v.length !== 3) fail(`schemes.${s}.${slot}: expected [dHue, sat, light]`);
    return v;
  }),
);

// --- tables ------------------------------------------------------------------
interface TableOut {
  name: string;
  values: readonly string[];
  fields: string[];
  rows: Num[][];
}
const tables: TableOut[] = [];
for (const [name, table] of Object.entries(data.tables)) {
  const values = TABLE_ENUMS[name];
  if (!values) {
    fail(`tables.${name}: no enum with that name`);
    continue;
  }
  coverage(table, values, `tables.${name}`);
  const fields = [...new Set(Object.values(table).flatMap((r) => Object.keys(r)))].sort();
  const rows = values.map((v) =>
    fields.map((f) => {
      const n = table[v]?.[f];
      // Missing fields default to 0 so parts only list what they use.
      if (n === undefined) return 0;
      if (typeof n !== "number" || !Number.isFinite(n))
        fail(`tables.${name}.${v}.${f}: not a number`);
      return n;
    }),
  );
  tables.push({ name, values, fields, rows });
}
const constants = data.constants ?? {};

// --- touch reactions ---------------------------------------------------------
coverage(data.touch, E.TOUCH_KINDS, "touch");
const TOUCH_FIELDS: [string, readonly string[] | null][] = [
  ["mood", E.MOODS],
  ["intensity", null],
  ["action", E.ACTIONS],
  ["fx", E.FXS],
  ["look", E.LOOKS],
  ["grumpyMood", E.MOODS],
  ["grumpyAction", E.ACTIONS],
  ["grumpyFx", E.FXS],
];
const touchRows = E.TOUCH_KINDS.map((kind) =>
  TOUCH_FIELDS.map(([field, values]) => {
    const v = data.touch[kind]?.[field];
    if (values === null) {
      if (typeof v !== "number") fail(`touch.${kind}.${field}: expected a number`);
      return Number(v);
    }
    const i = values.indexOf(String(v));
    if (i < 0) fail(`touch.${kind}.${field}: "${String(v)}" is not a valid value`);
    return i;
  }),
);

if (errors.length) {
  console.error("rig-data.json is invalid:\n  " + errors.join("\n  "));
  process.exit(1);
}

// --- TypeScript --------------------------------------------------------------
const HEADER =
  "// GENERATED by packages/protocol/scripts/codegen.ts from rig-data.json. Do not edit.";
const j = (x: unknown) => JSON.stringify(x);
const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const upper = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

let ts = `${HEADER}\n/* eslint-disable */\n\n`;
ts += `export const POSE_NEUTRAL: readonly number[] = ${j(poseNeutral)};\n`;
ts += `export const POSE_MIN: readonly number[] = ${j(poseMin)};\n`;
ts += `export const POSE_MAX: readonly number[] = ${j(poseMax)};\n`;
ts += `export const INTENSITY_SCALE: readonly number[] = ${j(data.intensityScale)};\n\n`;
ts += `/** Mood → pose delta, indexed [MOODS index][POSE_CHANNELS index]. */\n`;
ts += `export const MOOD_POSE: readonly (readonly number[])[] = ${j(moodPose)};\n\n`;
ts += `export const ACTION_MS: readonly number[] = ${j(actionMs)};\n`;
ts += `export interface ActionTrack { readonly channel: number; readonly keys: readonly (readonly [number, number])[] }\n`;
ts += `/** Action → additive keyframe tracks, indexed by ACTIONS index. */\n`;
ts += `export const ACTION_TRACKS: readonly (readonly ActionTrack[])[] = ${j(actionTracks)};\n\n`;
ts += `/** Scheme → palette slot → [hueOffset°, saturation 0-1, lightness 0-1]. */\n`;
ts += `export const SCHEME_HSL: readonly (readonly (readonly [number, number, number])[])[] = ${j(schemeHsl)};\n\n`;
for (const t of tables) {
  const row = `${pascal(t.name)}Params`;
  ts += `export interface ${row} { ${t.fields.map((f) => `readonly ${f}: number;`).join(" ")} }\n`;
  const objs = t.rows.map((r) => Object.fromEntries(t.fields.map((f, i) => [f, r[i]])));
  ts += `/** Indexed by the ${t.name} enum. */\n`;
  ts += `export const ${upper(t.name)}_PARAMS: readonly ${row}[] = ${j(objs)};\n\n`;
}
ts += `export const RIG_CONSTANTS = ${j(constants)} as const;\n\n`;
ts += `/** Touch kind → [mood, intensity, action, fx, look, grumpyMood, grumpyAction, grumpyFx] (enum indices). */\n`;
ts += `export const TOUCH_REACTIONS: readonly (readonly number[])[] = ${j(touchRows)};\n`;

// --- write / check -----------------------------------------------------------
const outputs: [string, string][] = [[join(pkg, "src", "generated", "rig-data.ts"), ts]];
for (const [name, schema] of Object.entries(PUBLISHED_SCHEMAS)) {
  outputs.push([
    join(pkg, "schemas", `${name}.schema.json`),
    JSON.stringify(schema, null, 2) + "\n",
  ]);
}

let stale = 0;
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) continue;
  if (check) {
    console.error(`stale: ${relative(root, path)}`);
    stale++;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${relative(root, path)}`);
  }
}
if (warnings.length > 3) console.warn(`warning: ${warnings[0]} (and ${warnings.length - 1} more)`);
else for (const w of warnings) console.warn(`warning: ${w}`);
if (stale) {
  console.error("generated files are out of date; run `pnpm codegen`");
  process.exit(1);
}
