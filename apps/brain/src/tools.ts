// The pal's tools (PLAN 5.4) as a plain API bound to one pal. No pi here: PiBrain
// wraps these as AgentTools, ScriptedBrain calls them directly. Failures throw.
import {
  REPEATS,
  TASK_TEXT_MAX,
  isOverdue,
  parseWhen,
  SKILL_BODY_MAX,
  SKILL_DESCRIPTION_MAX,
  TAG_MAX,
  TAGS_MAX,
  skillSlug,
  toText,
  type Repeat,
} from "@tidbit/protocol";
import type { AbilitiesStore } from "./abilities-store.js";
import type { NotesStore } from "./notes-store.js";
import { describeWhen, spokenWhen, sortTasks } from "./second-brain.js";
import type { Store } from "./store.js";
import {
  fetchPage,
  runHttpAction,
  searchEnabled,
  webSearch,
  type Lookup,
  type SearchConfig,
} from "./web.js";

export const FACT_MAX = 300;
export const REMINDER_TEXT_MAX = 200;
export const REMINDER_HORIZON_MS = 366 * 24 * 3_600_000;
export const TOOL_TIMEOUT_MS = 5_000;
/** Network actions get longer: pages and home automations can be slow. */
export const WEB_TIMEOUT_MS = 10_000;
export const ACTION_INPUT_MAX = 500;

export interface ToolDeps {
  store: Store;
  palId: string;
  clock: () => number;
  fetch: typeof fetch;
  /** IANA time zone for rendering times; defaults to the host's. */
  timeZone?: string;
  /** Memory ids the model has now seen (remember, recall) or that were forgotten. */
  onMemory?: (kind: "seen" | "forgotten", ids: number[]) => void;
  /** Skills, actions and repeating reminders. Without it those tools report "unavailable". */
  abilities?: AbilitiesStore;
  /** Web search provider, if the owner configured one. */
  search?: SearchConfig;
  /** Let owner-defined actions reach private networks (home automation on the LAN). */
  allowPrivateActions?: boolean;
  lookup?: Lookup;
  /** Apply a change the user asked the pal to make to itself; returns a summary. */
  updateSelf?: (patch: unknown) => string;
  /** Notes and tasks (the second brain). Without it those tools report "unavailable". */
  notes?: NotesStore;
}

export interface PalTools {
  remember(fact: string, tags?: readonly string[]): string;
  recall(query: string): string;
  forget(memoryId: number): string;
  setReminder(whenIso: string, text: string, repeat?: string): string;
  listReminders(): string;
  cancelReminder(id: number): string;
  getTime(): string;
  getWeather(place: string, signal?: AbortSignal): Promise<string>;
  /** Load a skill's full instructions by name. */
  useSkill(name: string): string;
  /** Write down (or improve) a skill the pal worked out itself. */
  saveSkill(name: string, description: string, instructions: string): string;
  webFetch(url: string, signal?: AbortSignal): Promise<string>;
  webSearch(query: string, signal?: AbortSignal): Promise<string>;
  runAction(name: string, input: string, signal?: AbortSignal): Promise<string>;
  /** Change the pal's own name, look, temperament, voice or personality. */
  updateSelf(patch: unknown): string;
  /** Add something the user needs to do, optionally due at an ISO date or date-time. */
  addTask(text: string, due?: string): string;
  listTasks(): string;
  completeTask(id: number): string;
}

export function formatTime(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

// Words that carry no fact on their own; "The user's dog" and "my dog" are the same fact.
const FILLER = new Set(
  "a an the is are was were be been am and or of to in on at for with by as that this it its user users i me my mine you your their they them he she his her has have had do does called named".split(
    " ",
  ),
);

function factWords(fact: string): Set<string> {
  const words =
    fact
      .toLowerCase()
      .replace(/['’]s\b/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => !FILLER.has(w)));
}

/** True when `fact` adds nothing to `existing`: all its content words are already there, or nearly so. */
export function sameFact(fact: string, existing: string): boolean {
  const a = factWords(fact),
    b = factWords(existing);
  if (!a.size || !b.size) return fact.trim().toLowerCase() === existing.trim().toLowerCase();
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared === a.size || shared / (a.size + b.size - shared) >= 0.75;
}

function cleanTags(tags: readonly string[] = []): string[] {
  return [
    ...new Set(
      tags.map((t) => toText(t, TAG_MAX).toLowerCase().replace(/\s+/g, "-")).filter(Boolean),
    ),
  ].slice(0, TAGS_MAX);
}

/** Abort after `ms` or when `outer` aborts, whichever comes first. */
export function timeoutSignal(outer: AbortSignal | undefined, ms = TOOL_TIMEOUT_MS): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, t]) : t;
}

const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "severe thunderstorm with hail",
};

export function createTools(deps: ToolDeps): PalTools {
  const { store, palId } = deps;
  const now = () => deps.clock();
  return {
    remember(fact, tags) {
      const clean = toText(fact, FACT_MAX);
      if (!clean) throw new Error("fact is empty");
      // Session summaries are loose prose; only discrete facts count as duplicates.
      const known = store
        .searchMemories(palId, clean, 10)
        .find((m) => !m.tags.includes("session") && sameFact(clean, m.fact));
      if (known) {
        deps.onMemory?.("seen", [known.id]);
        return `Already remembered as memory #${known.id}: ${known.fact}`;
      }
      const id = store.addMemory(palId, clean, cleanTags(tags), now());
      deps.onMemory?.("seen", [id]);
      return `Remembered as memory #${id}.`;
    },

    recall(query) {
      const q = toText(query, 200);
      const found = store.searchMemories(palId, q, 5);
      const notes = deps.notes?.searchNotes(palId, q, 3) ?? [];
      if (!found.length && !notes.length) return "No matching memories.";
      if (found.length)
        deps.onMemory?.(
          "seen",
          found.map((m) => m.id),
        );
      return [
        ...found.map((m) => `#${m.id}: ${m.fact}${m.tags.length ? ` [${m.tags.join(", ")}]` : ""}`),
        // Notes are the user's own captured words, dated; they are not memory ids.
        ...notes.map(
          (n) => `note from ${formatTime(n.recordedAt, deps.timeZone)}: ${n.text.slice(0, 600)}`,
        ),
      ].join("\n");
    },

    forget(memoryId) {
      if (!Number.isInteger(memoryId)) throw new Error("memoryId must be an integer");
      if (!store.deleteMemory(palId, memoryId)) throw new Error(`no memory #${memoryId}`);
      deps.onMemory?.("forgotten", [memoryId]);
      return `Forgot memory #${memoryId}.`;
    },

    setReminder(whenIso, text, repeat = "none") {
      const due = Date.parse(whenIso);
      if (!Number.isFinite(due)) throw new Error(`"${whenIso}" is not an ISO date-time`);
      const t = now();
      // A few seconds of slack for "in 0 minutes" style requests.
      if (due < t - 5_000)
        throw new Error(`that time is in the past (now is ${new Date(t).toISOString()})`);
      if (due > t + REMINDER_HORIZON_MS) throw new Error("reminders can be at most a year ahead");
      const clean = toText(text, REMINDER_TEXT_MAX);
      if (!clean) throw new Error("reminder text is empty");
      const every = (REPEATS as readonly string[]).includes(repeat) ? (repeat as Repeat) : "none";
      if (every !== "none" && !deps.abilities)
        throw new Error("repeating reminders are unavailable");
      const id = store.addReminder(palId, Math.max(due, t), clean, t);
      if (every !== "none") deps.abilities!.setRepeat(id, every);
      return `${every === "none" ? "Reminder" : "Routine"} #${id} set for ${formatTime(due, deps.timeZone)}${every === "none" ? "" : `, repeating ${every}`}.`;
    },

    listReminders() {
      const list = store.pendingReminders(palId);
      if (!list.length) return "No pending reminders.";
      return list
        .map((r) => {
          const every = deps.abilities?.repeatOf(r.id) ?? "none";
          return `#${r.id}: ${formatTime(r.dueAt, deps.timeZone)}${every === "none" ? "" : ` (repeats ${every})`} — ${r.text}`;
        })
        .join("\n");
    },

    cancelReminder(id) {
      if (!Number.isInteger(id)) throw new Error("id must be an integer");
      if (!store.cancelReminder(palId, id)) throw new Error(`no pending reminder #${id}`);
      return `Cancelled reminder #${id}.`;
    },

    getTime() {
      const t = now();
      const zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      return `${formatTime(t, deps.timeZone)} (${zone}); ISO ${new Date(t).toISOString()}`;
    },

    // Open-Meteo: free, no API key (PLAN 5.4).
    async getWeather(place, signal) {
      const name = toText(place, 100);
      if (!name) throw new Error("place is empty");
      const sig = timeoutSignal(signal);
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(name)}`;
      const geoRes = await deps.fetch(geoUrl, { signal: sig });
      if (!geoRes.ok) throw new Error(`geocoding failed (${geoRes.status})`);
      const geo = (await geoRes.json()) as {
        results?: { name: string; country?: string; latitude: number; longitude: number }[];
      };
      const loc = geo.results?.[0];
      if (!loc) throw new Error(`no place called "${name}"`);
      const wxUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
        `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
      const wxRes = await deps.fetch(wxUrl, { signal: sig });
      if (!wxRes.ok) throw new Error(`forecast failed (${wxRes.status})`);
      const wx = (await wxRes.json()) as {
        current?: {
          temperature_2m: number;
          apparent_temperature: number;
          weather_code: number;
          wind_speed_10m: number;
          precipitation: number;
        };
        daily?: { temperature_2m_max: number[]; temperature_2m_min: number[] };
      };
      const c = wx.current;
      if (!c) throw new Error("no current weather");
      const hi = wx.daily?.temperature_2m_max?.[0];
      const lo = wx.daily?.temperature_2m_min?.[0];
      return (
        `${loc.name}${loc.country ? `, ${loc.country}` : ""}: ${WEATHER_CODES[c.weather_code] ?? "unknown conditions"}, ` +
        `${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C), wind ${Math.round(c.wind_speed_10m)} km/h` +
        (hi !== undefined && lo !== undefined
          ? `; today ${Math.round(lo)}–${Math.round(hi)}°C`
          : "")
      );
    },

    useSkill(name) {
      const abilities = deps.abilities;
      if (!abilities) throw new Error("skills are unavailable");
      const skill = abilities.skill(palId, skillSlug(name));
      if (!skill || !skill.enabled) {
        const known = abilities
          .skills(palId)
          .filter((s) => s.enabled)
          .map((s) => s.name);
        throw new Error(`no skill "${name}". Known skills: ${known.join(", ") || "none"}`);
      }
      abilities.countSkillUse(palId, skill.name);
      return `Skill "${skill.name}" — follow these instructions for this request:\n\n${skill.body}`;
    },

    saveSkill(name, description, instructions) {
      const abilities = deps.abilities;
      if (!abilities) throw new Error("skills are unavailable");
      const slug = skillSlug(name);
      if (!slug) throw new Error("name must contain letters or digits");
      const about = toText(description, SKILL_DESCRIPTION_MAX);
      const body = instructions.trim().slice(0, SKILL_BODY_MAX);
      if (!about || !body) throw new Error("description and instructions are required");
      const existing = abilities.skill(palId, slug);
      // Owner-written skills are the owner's to change; the pal may only refine its own.
      if (existing && existing.source !== "pal")
        throw new Error(`"${slug}" was written by the user; ask them to edit it in Skills`);
      abilities.saveSkill(palId, { name: slug, description: about, body }, "pal", now());
      return `${existing ? "Updated" : "Saved"} skill "${slug}". It will be offered in future conversations.`;
    },

    async webFetch(url, signal) {
      return fetchPage(deps, toText(url, 2000), timeoutSignal(signal, WEB_TIMEOUT_MS));
    },

    async webSearch(query, signal) {
      if (!deps.search || !searchEnabled(deps.search)) throw new Error("web search is not set up");
      const q = toText(query, 200);
      if (!q) throw new Error("query is empty");
      return webSearch(deps, deps.search, q, timeoutSignal(signal, WEB_TIMEOUT_MS));
    },

    async runAction(name, input, signal) {
      const abilities = deps.abilities;
      if (!abilities) throw new Error("actions are unavailable");
      const action = abilities.action(palId, skillSlug(name));
      if (!action || !action.enabled) {
        const known = abilities
          .actions(palId)
          .filter((a) => a.enabled)
          .map((a) => a.name);
        throw new Error(`no action "${name}". Known actions: ${known.join(", ") || "none"}`);
      }
      const result = await runHttpAction(
        { ...deps, allowPrivate: deps.allowPrivateActions },
        action,
        toText(input, ACTION_INPUT_MAX),
        timeoutSignal(signal, WEB_TIMEOUT_MS),
      );
      abilities.countActionUse(palId, action.id);
      return result;
    },

    updateSelf(patch) {
      if (!deps.updateSelf) throw new Error("changing myself is unavailable here");
      return deps.updateSelf(patch);
    },

    addTask(text, due) {
      if (!deps.notes) throw new Error("tasks are unavailable");
      const clean = toText(text, TASK_TEXT_MAX);
      if (!clean) throw new Error("task text is empty");
      const when = due?.trim() ? (parseWhen(due) ?? spokenWhen(due, new Date(now()))) : undefined;
      if (due?.trim() && !when) throw new Error(`"${due}" is not an ISO date or date-time`);
      const id = deps.notes.addTask(
        palId,
        { text: clean, ...(when ? { dueAt: when.at, allDay: when.allDay } : {}) },
        now(),
      );
      return `Task #${id} added${when ? `, due ${describeWhen(when.at, when.allDay, now())}` : ""}.`;
    },

    listTasks() {
      if (!deps.notes) throw new Error("tasks are unavailable");
      const t = now();
      const open = sortTasks(deps.notes.openTasks(palId), t);
      if (!open.length) return "No open tasks.";
      return open
        .slice(0, 25)
        .map(
          (task) =>
            `#${task.id}: ${task.text}${task.dueAt !== null ? ` (due ${describeWhen(task.dueAt, task.allDay, t)}${isOverdue(task, t) ? ", OVERDUE" : ""})` : ""}`,
        )
        .join("\n");
    },

    completeTask(id) {
      if (!deps.notes) throw new Error("tasks are unavailable");
      if (!Number.isInteger(id)) throw new Error("id must be an integer");
      const task = deps.notes.task(palId, id);
      if (!task || task.doneAt !== null) throw new Error(`no open task #${id}`);
      deps.notes.setTaskDone(palId, id, true, now());
      return `Done: ${task.text}.`;
    },
  };
}
