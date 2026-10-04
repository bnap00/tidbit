// Second-brain logic shared by the service and both brains: offline triage of a
// capture (keywords and spoken dates), the agenda, and the facts for a briefing.
import {
  CAPTURE_TEXT_MAX,
  TASK_TEXT_MAX,
  TRIAGE_ITEMS_MAX,
  isOverdue,
  normalizeTriage,
  type AgendaEvent,
  type AgendaInfo,
  type BriefScope,
  type TaskInfo,
  type Triage,
  type TriageItem,
} from "@tidbit/protocol";

const DAY = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Local ISO 8601 with offset, e.g. 2026-10-01T09:30:00+05:30 (what models expect). */
export function localIso(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Keep a capture's line breaks (long notes have paragraphs) but drop control characters
 * and runs of blank space.
 */
export function cleanRaw(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, CAPTURE_TEXT_MAX);
}

/** Speech fillers removed by the offline tidy-up. The model does a better job when online. */
const FILLERS =
  /\b(?:u+h+|u+m+|e+r+m*|hmm+|you know|i mean|like,|so,? basically|okay so)\b[,.]?\s*/gi;

/** Offline tidy-up: no fillers or stutters, sentences capitalised and ended. */
export function tidy(text: string): string {
  return text
    .split(/\n/)
    .map((line) =>
      line
        .replace(FILLERS, "")
        .replace(/\b(\w+)(\s+\1\b)+/gi, "$1")
        .replace(/\s+([,.!?])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim()
        .replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, p: string, c: string) => p + c.toUpperCase())
        .replace(/([^.!?…:])$/, "$1."),
    )
    .filter((line) => line !== ".")
    .join("\n");
}

/**
 * A spoken date or time ("tomorrow", "on Friday at 3pm", "by 5", "on the 29th", "in 2
 * hours") relative to `now`. Undefined when the text names no time.
 */
export function spokenWhen(text: string, now: Date): { at: number; allDay: boolean } | undefined {
  const t = text.toLowerCase();
  let day: Date | undefined;
  const rel = /\bin (\d{1,3}) (minute|hour|day|week)s?\b/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { minute: 60_000, hour: 3_600_000, day: DAY, week: 7 * DAY }[rel[2]!]!;
    return { at: now.getTime() + n * unit, allDay: rel[2] === "day" || rel[2] === "week" };
  }
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) day = new Date(now);
  else if (/\bday after tomorrow\b/.test(t)) {
    day = new Date(now);
    day.setDate(day.getDate() + 2);
  } else if (/\btomorrow\b/.test(t)) {
    day = new Date(now);
    day.setDate(day.getDate() + 1);
  } else {
    const wd = new RegExp(`\\b(next |this |on )?(${WEEKDAYS.join("|")})\\b`).exec(t);
    const nth = /\bon the (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
    if (wd) {
      day = new Date(now);
      const target = WEEKDAYS.indexOf(wd[2]!);
      let ahead = (target - day.getDay() + 7) % 7;
      if (ahead === 0 || wd[1] === "next ") ahead = ahead || 7;
      day.setDate(day.getDate() + ahead);
    } else if (nth) {
      const date = Number(nth[1]);
      day = new Date(now.getFullYear(), now.getMonth(), date);
      if (date < now.getDate()) day.setMonth(day.getMonth() + 1);
    }
  }
  const time =
    /\b(?:at|by|around|before|until)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d.])/.exec(
      t,
    ) ??
    /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/.exec(t) ??
    /\b(\d{1,2}):(\d{2})\b()/.exec(t);
  const noon = /\b(at |by )?noon\b/.test(t);
  if (!time && !noon) return day && { at: startOfDay(day.getTime()), allDay: true };
  let hour = noon ? 12 : Number(time![1]);
  const minute = noon ? 0 : Number(time![2] ?? 0);
  const meridiem = noon ? "" : (time![3] ?? "").replace(/\./g, "");
  if (hour > 23 || minute > 59) return day && { at: startOfDay(day.getTime()), allDay: true };
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  // "at 5" with no am/pm during the day means the afternoon.
  if (!meridiem && !noon && hour >= 1 && hour <= 7 && !/:\d{2}/.test(time![0])) hour += 12;
  const at = new Date(day ?? now);
  at.setHours(hour, minute, 0, 0);
  if (!day && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return { at: at.getTime(), allDay: false };
}

const TASK_CUE =
  /\b(?:i (?:really )?(?:need|have|got|must|should|want) to|i've got to|i gotta|need to|have to|don't forget to|do not forget to|remember to|remind me to|to-?do:?|todo:?)\s+(.+)/i;
const TASK_VERB =
  /^(?:buy|order|call|email|text|pick up|book|pay|send|fix|clean|finish|print|return|renew|schedule|cancel|water|feed|check|submit|write|reply to|ring)\b/i;
const APPOINTMENT_CUE =
  /\b(appointment|meeting|dentist|doctor|interview|call with|lunch with|dinner with|coffee with|flight|train|party|class|session|game|concert|visit)\b/i;
const MEMORY_CUE =
  /^(?:my ([\p{L} ]{2,30}?) (?:is|are) (?:called |named )?(.{1,80})|i (?:really )?(?:like|love|hate|prefer) (.{2,80}))$/iu;
/** Words that only say when; they don't belong in a task's text. */
const WHEN_WORDS =
  /\s*\b(?:(?:by |on |at |before |until )?(?:today|tonight|tomorrow|the day after tomorrow|this (?:morning|afternoon|evening)|(?:next |this |on )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|on the \d{1,2}(?:st|nd|rd|th)|in \d{1,3} (?:minute|hour|day|week)s?)|(?:at|by|around|before) \d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|(?:at |by )?noon)\b/gi;

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function itemText(s: string): string {
  const text = s
    .replace(WHEN_WORDS, "")
    .replace(/\s+(?:please|asap)\b/gi, "")
    .replace(/[\s,;:.!?]+$/, "")
    .replace(/^(?:also|and|then|so)\s+/i, "")
    .trim();
  return sentenceCase(text).slice(0, TASK_TEXT_MAX);
}

/**
 * Offline triage: one item per sentence that reads like a task, appointment or fact.
 * A when that is said separately ("I need to do this today") applies to the item before.
 */
export function scriptedTriage(capture: string, now: Date): Triage {
  const clean = tidy(cleanRaw(capture));
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const items: TriageItem[] = [];
  for (const sentence of sentences) {
    if (items.length >= TRIAGE_ITEMS_MAX) break;
    const when = spokenWhen(sentence, now);
    const bare = sentence.replace(/[.!?]+$/, "");
    const task = TASK_CUE.exec(bare);
    const callback = /^(?:i (?:need|have|must|should) to |)(?:do|finish|get) (?:this|that|it)\b/i;
    // "I need to do this today" sets the when of the item just before it.
    if (task && callback.test(task[0]) && items.length) {
      const last = items.at(-1)!;
      if (when && last.kind !== "memory" && last.when === undefined)
        Object.assign(last, { when: when.at, allDay: when.allDay });
      continue;
    }
    if (APPOINTMENT_CUE.test(bare) && when && !when.allDay && !task) {
      items.push({ kind: "appointment", text: itemText(bare), when: when.at, allDay: false });
      continue;
    }
    if (task || TASK_VERB.test(bare)) {
      const text = itemText(task ? task[1]! : bare);
      if (!text) continue;
      items.push({ kind: "task", text, ...(when ? { when: when.at, allDay: when.allDay } : {}) });
      continue;
    }
    const fact = MEMORY_CUE.exec(bare);
    if (fact)
      items.push({
        kind: "memory",
        text: fact[1]
          ? `The user's ${fact[1].trim()} is ${fact[2]!.trim()}`
          : `The user ${/^i (?:really )?(\w+)/i.exec(bare)![1]!.toLowerCase()}s ${fact[3]!.trim()}`,
      });
  }
  return normalizeTriage(
    {
      clean,
      items: items.map((i) => ({
        kind: i.kind,
        text: i.text,
        when:
          i.when === undefined
            ? ""
            : i.allDay
              ? new Date(i.when).toLocaleDateString("en-CA")
              : new Date(i.when).toISOString(),
      })),
    },
    capture,
  );
}

/** Open tasks first by urgency: overdue, then due soonest, then the newest undated. */
export function sortTasks(tasks: TaskInfo[], now: number): TaskInfo[] {
  const rank = (t: TaskInfo) => (isOverdue(t, now) ? 0 : t.dueAt !== null ? 1 : 2);
  return [...tasks].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dueAt ?? 0) - (b.dueAt ?? 0) ||
      (rank(a) === 2 ? b.createdAt - a.createdAt : a.createdAt - b.createdAt),
  );
}

export function buildAgenda(
  tasks: TaskInfo[],
  done: TaskInfo[],
  events: AgendaEvent[],
  now: number,
): AgendaInfo {
  const open = sortTasks(tasks, now);
  return {
    generatedAt: now,
    tasks: open,
    done,
    events: events.filter((e) => e.at <= now + 31 * DAY).slice(0, 30),
    overdue: open.filter((t) => isOverdue(t, now)).length,
  };
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const weekday = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "today 17:00", "tomorrow", "Fri 3 Oct 10:00". */
export function describeWhen(at: number, allDay: boolean, now: number): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  const day =
    days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : weekday(at);
  return allDay ? day : `${day} ${clock(at)}`;
}

const list = (xs: string[], max: number) =>
  xs.slice(0, max).join("; ") + (xs.length > max ? ` (+${xs.length - max} more)` : "");

/**
 * The facts for a briefing, in plain sentences. The model phrases them in character;
 * the offline brain reads them out as they are.
 */
export function briefingFacts(agenda: AgendaInfo, scope: BriefScope, now: number): string {
  const end = scope === "day" ? startOfDay(now) + DAY : startOfDay(now) + 7 * DAY;
  const events = agenda.events.filter((e) => e.at < end);
  const overdue = agenda.tasks.filter((t) => isOverdue(t, now));
  const due = agenda.tasks.filter((t) => !isOverdue(t, now) && t.dueAt !== null && t.dueAt < end);
  const undated = agenda.tasks.filter((t) => t.dueAt === null);
  const parts: string[] = [];
  const when = (at: number, allDay: boolean) =>
    scope === "day" && !allDay ? clock(at) : describeWhen(at, allDay, now);
  parts.push(
    events.length
      ? `${scope === "day" ? "Today" : "This week"}: ${list(
          events.map((e) => `${e.text} ${when(e.at, false)}`),
          scope === "day" ? 4 : 6,
        )}.`
      : `Nothing scheduled ${scope === "day" ? "today" : "this week"}.`,
  );
  if (due.length)
    parts.push(
      `Due: ${list(
        due.map((t) => `${t.text} (${when(t.dueAt!, t.allDay)})`),
        4,
      )}.`,
    );
  if (undated.length)
    parts.push(
      `Open tasks: ${list(
        undated.map((t) => t.text),
        3,
      )}.`,
    );
  parts.push(
    overdue.length
      ? `Overdue: ${list(
          overdue.map((t) => t.text),
          3,
        )}.`
      : "Nothing is overdue.",
  );
  return parts.join(" ");
}

/** One line per filed item, for the pal's acknowledgement and the notes list. */
export function describeTriage(
  items: { kind: string; text: string; when?: number; allDay?: boolean }[],
  now: number,
): string {
  if (!items.length) return "Saved as a note.";
  return items
    .map(
      (i) =>
        `${i.kind === "task" ? "Task" : i.kind === "appointment" ? "Appointment" : "Remembered"}: ${i.text}${
          i.when !== undefined ? ` (${describeWhen(i.when, !!i.allDay, now)})` : ""
        }`,
    )
    .join(" · ");
}
