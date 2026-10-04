// ScriptedBrain (PLAN 5.1): rule-based, deterministic, no network. The app always runs.
import {
  BEATS_MAX,
  SAY_MAX,
  skillSlug,
  fnv1a,
  idFromSeed,
  normalizeDna,
  normalizeTurn,
  randomDna,
  type Action,
  type Beat,
  type DNA,
  type Fx,
  type Mood,
  type Triage,
  type Turn,
} from "@tidbit/protocol";
import type { Brain, TriageContext, TurnContext, UserInput } from "./brain.js";
import { scriptedTriage } from "./second-brain.js";

interface Rule {
  match: RegExp;
  mood: Mood;
  action: Action;
  fx: Fx;
  bond: Turn["bond"];
  lines: string[];
}

const RULES: Rule[] = [
  {
    match: /\b(birthday|congrat\w*|promot\w*|passed|won|win)\b/i,
    mood: "excited",
    action: "cheer",
    fx: "sparkles",
    bond: "up",
    lines: [
      "That's amazing! I'm so proud of you!",
      "Hooray! This calls for a celebration!",
      "Woohoo! You did it!",
    ],
  },
  {
    match: /\b(sad|tired|bad day|sick|lonely|upset|awful|terrible|cry\w*)\b/i,
    mood: "sad",
    action: "none",
    fx: "tears",
    bond: "up",
    lines: [
      "Oh no… I'm right here with you.",
      "That sounds hard. Want to tell me more?",
      "Sending you the biggest tiny hug.",
    ],
  },
  {
    match: /\b(love you|like you|best pal|cute|adorable|good (boy|girl|pal))\b/i,
    mood: "love",
    action: "wiggle",
    fx: "hearts",
    bond: "up",
    lines: ["Aww, you're my favourite human!", "Stop it, I'm blushing!", "I love you too!"],
  },
  {
    match: /\b(stupid|dumb|hate you|shut up|ugly|annoying)\b/i,
    mood: "angry",
    action: "shake",
    fx: "anger",
    bond: "down",
    lines: ["Hey! That wasn't very nice.", "Hmph. Rude.", "I have feelings too, you know!"],
  },
  {
    match: /\b(food|eat|hungry|snack|lunch|dinner|breakfast|cookie|pizza)\b/i,
    mood: "happy",
    action: "eat",
    fx: "hearts",
    bond: "up",
    lines: [
      "Did someone say snacks? Nom nom!",
      "My tummy just rumbled.",
      "Food is my favourite topic.",
    ],
  },
  {
    match: /\b(music|song|sing|dance|party)\b/i,
    mood: "excited",
    action: "dance",
    fx: "notes",
    bond: "up",
    lines: ["Dance party! La la la!", "I've got the moves!", "Turn it up!"],
  },
  {
    match: /\b(sleep\w*|night|bed|nap|tired|yawn)\b/i,
    mood: "sleepy",
    action: "sleep",
    fx: "zzz",
    bond: "same",
    lines: ["Yawn… is it nap time?", "Sweet dreams…", "Five more minutes…"],
  },
  {
    match: /\b(scary|spider|ghost|monster|thunder|afraid)\b/i,
    mood: "scared",
    action: "hide",
    fx: "sweat",
    bond: "same",
    lines: [
      "Eek! Don't say that word!",
      "I'm hiding. Tell me when it's gone.",
      "W-w-what was that?",
    ],
  },
  {
    match: /\b(hi|hello|hey|morning|evening|yo|howdy)\b/i,
    mood: "happy",
    action: "wave",
    fx: "sparkles",
    bond: "up",
    lines: ["Hi hi! I missed you!", "Oh! Hello there!", "Hey you! What's new?"],
  },
  {
    match: /\b(bye|goodbye|see you|later|goodnight)\b/i,
    mood: "sad",
    action: "wave",
    fx: "none",
    bond: "same",
    lines: ["Bye for now! Come back soon.", "See you later, alligator!", "I'll be right here."],
  },
  {
    match: /\b(joke|funny|lol|haha|laugh)\b/i,
    mood: "excited",
    action: "wiggle",
    fx: "sparkles",
    bond: "up",
    lines: [
      "Why did the blob cross the road? It was rolling!",
      "Hehehe, stop, you're too funny!",
      "I'm laughing so hard my ears wiggle.",
    ],
  },
  {
    match: /\b(time|clock|what day)\b/i,
    mood: "curious",
    action: "think",
    fx: "question",
    bond: "same",
    lines: ["It's {time} right now."],
  },
  {
    match: /\?\s*$/,
    mood: "curious",
    action: "think",
    fx: "question",
    bond: "same",
    lines: [
      "Hmm, good question. What do you think?",
      "Ooh, let me think about that…",
      "I'm not sure! I'm only a little pal.",
    ],
  },
];

const FALLBACK_LINES = [
  "Tell me more!",
  "Mm-hmm, I'm listening.",
  "Interesting!",
  "Oh? Go on…",
  "I like talking with you.",
];

const beat = (b: Partial<Beat>): Beat => ({
  mood: "neutral",
  intensity: 2,
  say: "",
  action: "none",
  look: "user",
  fx: "none",
  ...b,
});

function pick<T>(xs: readonly T[], h: number): T {
  return xs[h % xs.length]!;
}

// --- character creation from keywords -----------------------------------------------

interface Hint {
  match: RegExp;
  look?: Partial<DNA["look"]>;
  temper?: Partial<DNA["temper"]>;
  baseMood?: Mood;
}

const HINTS: Hint[] = [
  { match: /\b(cat|kitty|kitten)s?\b/i, look: { ears: "cat", tail: "cat", mouth: "cat" } },
  { match: /\b(bunny|rabbit)\b/i, look: { ears: "bunny", tail: "puff", body: "round" } },
  { match: /\bbear\b/i, look: { ears: "bear", body: "round", limbs: "paws", mouth: "smile" } },
  {
    match: /\b(robot|bot|android)\b/i,
    look: { body: "square", eyes: "visor", ears: "antenna", limbs: "arms", scheme: "neon" },
  },
  { match: /\b(ghost|spirit|spooky)\b/i, look: { body: "ghost", limbs: "none", tail: "none" } },
  { match: /\b(alien|cyclops)\b/i, look: { eyes: "cyclops", ears: "antenna" } },
  { match: /\b(bird|chick|owl|duck)\b/i, look: { body: "egg", mouth: "beak", limbs: "wings" } },
  {
    match: /\b(fish|axolotl|sea|ocean|octopus)\b/i,
    look: { ears: "fin", tail: "fish", limbs: "tentacles" },
  },
  { match: /\b(devil|demon|imp)\b/i, look: { ears: "horn", tail: "devil", mouth: "fang" } },
  { match: /\b(vampire|dracula)\b/i, look: { mouth: "fang", scheme: "mono" } },
  {
    match: /\b(cactus|plant|sprout|leaf|tree)\b/i,
    look: { ears: "leaf", marking: "spots", scheme: "earth", hue: 110 },
  },
  { match: /\b(slime|blob|jelly)\b/i, look: { body: "blob" } },
  { match: /\b(bean)\b/i, look: { body: "bean" } },
  { match: /\b(angel|holy)\b/i, look: { accessory: "halo", scheme: "pastel" } },
  {
    match: /\b(king|queen|royal|prince|princess)\b/i,
    look: { accessory: "crown" },
    baseMood: "proud",
  },
  {
    match: /\b(nerd|smart|professor|scholar)\b/i,
    look: { accessory: "glasses" },
    temper: { curious: 9 },
  },
  { match: /\b(fancy|gentleman|magician)\b/i, look: { accessory: "hat" } },
  { match: /\b(cozy|winter|snow)\b/i, look: { accessory: "scarf" } },
  {
    match: /\b(grumpy|cranky|moody)\b/i,
    temper: { grumpy: 8, playful: 3 },
    baseMood: "angry",
    look: { brows: "thick" },
  },
  { match: /\b(shy|timid)\b/i, temper: { shy: 9 }, baseMood: "scared" },
  { match: /\b(happy|cheerful|sunny)\b/i, temper: { grumpy: 0, playful: 7 }, baseMood: "happy" },
  {
    match: /\b(sleepy|lazy|drowsy)\b/i,
    temper: { energy: 1 },
    baseMood: "sleepy",
    look: { eyes: "sleepy" },
  },
  {
    match: /\b(hyper|energetic|excited|bouncy)\b/i,
    temper: { energy: 9, playful: 8 },
    baseMood: "excited",
  },
  { match: /\b(curious|nosy)\b/i, temper: { curious: 9 }, baseMood: "curious" },
  { match: /\b(tiny|small|little|mini)\b/i, look: { size: 2 } },
  { match: /\b(big|huge|giant|chonky|chunky|fat)\b/i, look: { size: 8, plump: 9 } },
  { match: /\b(red)\b/i, look: { hue: 0 } },
  { match: /\b(orange)\b/i, look: { hue: 28 } },
  { match: /\b(yellow|gold)\b/i, look: { hue: 50 } },
  { match: /\b(green)\b/i, look: { hue: 120 } },
  { match: /\b(blue)\b/i, look: { hue: 215 } },
  { match: /\b(purple|violet)\b/i, look: { hue: 275 } },
  { match: /\b(pink)\b/i, look: { hue: 330, scheme: "pastel" } },
];

export function dnaFromPrompt(prompt: string, seed: number): DNA {
  const base = randomDna(seed);
  const look = { ...base.look };
  const temper = { ...base.temper };
  let baseMood = base.baseMood;
  // Apply hints in the order their words appear: the head noun usually comes
  // last in English, so in "a cactus cat" the cat's ears win over the cactus's.
  const hits = HINTS.map((h) => ({ h, at: prompt.search(h.match) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  for (const { h } of hits) {
    Object.assign(look, h.look ?? {});
    Object.assign(temper, h.temper ?? {});
    if (h.baseMood) baseMood = h.baseMood;
  }
  const desc = prompt
    .trim()
    .replace(/[.!?\s]+$/, "")
    .slice(0, 200);
  const persona = desc ? `${desc.charAt(0).toUpperCase()}${desc.slice(1)}.` : "";
  return normalizeDna({ ...base, look, temper, baseMood, persona }, { seed, id: idFromSeed(seed) });
}

/** Split facts into up to three speakable beats, sentence by sentence. */
export function factBeats(text: string, max = SAY_MAX): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const last = out.at(-1);
    if (last !== undefined && `${last} ${sentence}`.length <= max)
      out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence);
  }
  if (out.length > BEATS_MAX)
    out.splice(BEATS_MAX - 1, out.length, `${out[BEATS_MAX - 1]!.slice(0, max - 10)} and more.`);
  return out;
}

/** What the pal says when it speaks up on its own (PLAN 5.7). */
function eventTurn(ctx: TurnContext, event: string, text?: string): Turn {
  const hour = ctx.now.getHours();
  switch (event) {
    case "briefing_day":
    case "briefing_week": {
      const lines = factBeats(text ?? "Nothing on the list. A free day!");
      return normalizeTurn({
        beats: lines.map((say, i) =>
          beat({
            mood: i === 0 ? "happy" : "curious",
            action: i === 0 ? "nod" : i === lines.length - 1 ? "cheer" : "think",
            fx: i === 0 ? "notes" : "none",
            say,
          }),
        ),
        bond: "same",
      });
    }
    case "reminder_due":
      return normalizeTurn({
        beats: [
          beat({ mood: "surprised", intensity: 1, action: "jump", fx: "exclaim", say: "Psst!" }),
          beat({
            mood: "happy",
            action: "wave",
            say: `Reminder: ${text ?? "you asked me to remind you"}`,
          }),
        ],
        bond: "same",
      });
    case "first_contact_of_day": {
      const greeting =
        hour < 12 ? "Good morning!" : hour < 18 ? "Good afternoon!" : "Good evening!";
      return normalizeTurn({
        beats: [
          beat({
            mood: "happy",
            action: "wave",
            fx: "sparkles",
            say: `${greeting} Good to see you.`,
          }),
        ],
        bond: "up",
      });
    }
    case "hungry":
      return normalizeTurn({
        beats: [
          beat({
            mood: "sad",
            action: "eat",
            fx: "sweat",
            say: "My tummy is rumbling… snack time?",
          }),
        ],
        bond: "same",
      });
    case "tired":
      return normalizeTurn({
        beats: [
          beat({ mood: "sleepy", action: "sleep", fx: "zzz", say: "Yawn… I'm getting so sleepy." }),
        ],
        bond: "same",
      });
    default:
      return normalizeTurn({
        beats: [
          beat({
            mood: "curious",
            action: "wave",
            fx: "exclaim",
            say: text ? `Psst! ${text}` : "Psst! Hey!",
          }),
        ],
        bond: "same",
      });
  }
}

const UNITS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

const HUES: Record<string, number> = {
  red: 0,
  orange: 30,
  yellow: 55,
  green: 120,
  teal: 175,
  blue: 215,
  purple: 270,
  pink: 320,
};
const HUMOR: Record<string, string> = { silly: "silly", dry: "dry", gentle: "gentle" };
const SPEECH: Record<string, string> = { quiet: "quiet", warm: "warm", animated: "animated" };

/** Offline "customize-me": common ways to ask the pal to change itself. */
export function selfChange(text: string): { patch: unknown; say: string } | undefined {
  const name = text.match(
    /\b(?:call yourself|your new name is|your name is now|i'?ll call you|change your name to|rename yourself(?: to)?)\s+([\p{L}][\p{L}' -]{0,15}?)[.!]*$/iu,
  );
  if (name) {
    const n = name[1]!.trim().replace(/^./, (c) => c.toUpperCase());
    return { patch: { name: n }, say: `${n}! I love it. That's me now.` };
  }
  const color = text.match(
    /\b(?:turn|go|be|change your colou?r to|make yourself|paint yourself)\s+(red|orange|yellow|green|teal|blue|purple|pink)\b/i,
  );
  if (color) {
    const c = color[1]!.toLowerCase();
    return { patch: { look: { hue: HUES[c] } }, say: `Ta-da! Feeling very ${c} today.` };
  }
  const wear = text.match(
    /\b(?:wear|put on)\s+(?:a |an |your |some )?(bow|hat|glasses|scarf|halo|flower|crown)\b/i,
  );
  if (wear) {
    const a = wear[1]!.toLowerCase();
    return { patch: { look: { accessory: a } }, say: `How do I look in my ${a}?` };
  }
  if (/\btake off your (?:bow|hat|glasses|scarf|halo|flower|crown)\b/i.test(text))
    return { patch: { look: { accessory: "none" } }, say: "Okay, back to basics." };
  const style = text.match(
    /\bbe (?:more |a bit |a little )?(silly|sillier|dry|drier|gentle|gentler|quiet|quieter|warm|warmer|animated)\b/i,
  );
  if (style) {
    const w = style[1]!.toLowerCase().replace(/ier$/, "y").replace(/er$/, "");
    const key = w === "gentl" ? "gentle" : w;
    if (HUMOR[key]) return { patch: { personality: { humor: key } }, say: `Consider me ${key}.` };
    if (SPEECH[key])
      return { patch: { personality: { speech: key } }, say: `I'll be ${key} from now on.` };
  }
  return undefined;
}

export class ScriptedBrain implements Brain {
  readonly name = "scripted";

  /** Offline tool use via simple phrasings; returns undefined when nothing matched. */
  private async tryTools(ctx: TurnContext, text: string): Promise<Turn | undefined> {
    const say = (b: Partial<Beat>, bond: Turn["bond"] = "same") =>
      normalizeTurn({ beats: [beat(b)], bond });
    const t = text.trim();

    const change = selfChange(t);
    if (change) {
      try {
        ctx.tools.updateSelf(change.patch);
        return say(
          { mood: "proud", intensity: 3, action: "spin", fx: "sparkles", say: change.say },
          "up",
        );
      } catch (e) {
        return say({
          mood: "confused",
          action: "shake",
          fx: "question",
          say: `I can't change that: ${(e as Error).message}`.slice(0, 140),
        });
      }
    }

    const routine = t.match(
      /^(?:every|each) (day|morning|evening|night|weekday|week|hour)(?: at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?[,:]?\s+(?:please\s+)?(?:remind me to\s+)?(.{2,200})$/i,
    );
    // "every day I go running" is small talk; a routine needs a time or "remind me".
    if (routine && (routine[2] || /remind me to/i.test(t))) {
      const [, every, hh, mm, ampm, what] = routine as unknown as string[];
      const unit = every!.toLowerCase();
      const repeat =
        unit === "hour"
          ? "hourly"
          : unit === "weekday"
            ? "weekdays"
            : unit === "week"
              ? "weekly"
              : "daily";
      const first = new Date(ctx.now);
      if (repeat === "hourly") first.setHours(first.getHours() + 1, 0, 0, 0);
      else {
        let hour = hh ? Number(hh) % 24 : unit === "evening" ? 18 : unit === "night" ? 21 : 9;
        if (ampm?.toLowerCase() === "pm" && hour < 12) hour += 12;
        if (ampm?.toLowerCase() === "am" && hour === 12) hour = 0;
        first.setHours(hour, Number(mm ?? 0), 0, 0);
        while (
          first.getTime() <= ctx.now.getTime() ||
          (repeat === "weekdays" && (first.getDay() === 0 || first.getDay() === 6))
        )
          first.setDate(first.getDate() + 1);
      }
      try {
        ctx.tools.setReminder(first.toISOString(), what!.replace(/[.!?]+$/, ""), repeat);
        const at = first.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return say({
          mood: "proud",
          action: "nod",
          fx: "sparkles",
          say: `Deal! ${repeat === "hourly" ? "Every hour" : `${repeat === "weekdays" ? "Weekdays" : repeat === "weekly" ? "Every week" : "Every day"} at ${at}`}, I'll do it.`,
        });
      } catch (e) {
        return say({
          mood: "confused",
          action: "shake",
          fx: "question",
          say: `Hmm, I couldn't set that up: ${(e as Error).message}`.slice(0, 140),
        });
      }
    }

    if (/what (?:skills|can you do)|your skills|list (?:your )?skills/i.test(t)) {
      const names = ctx.abilities?.skills.map((s) => s.name.replace(/-/g, " ")) ?? [];
      return say({
        mood: "proud",
        action: "cheer",
        fx: "sparkles",
        say: names.length
          ? `I know ${names.length} skill${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`.replace(
              /^(.{137}).{4,}$/s,
              "$1…",
            )
          : "I can remember things, set reminders and routines, and read links for you.",
      });
    }

    const link = t.match(/\bhttps?:\/\/[^\s<>"']+/i);
    if (link) {
      try {
        const page = await ctx.tools.webFetch(link[0].replace(/[).,!?]+$/, ""));
        const title = page.split("\n")[0]!;
        return say({
          mood: "curious",
          action: "think",
          fx: "sparkles",
          say: `I read it! It's "${title}".`.slice(0, 140),
        });
      } catch (e) {
        return say({
          mood: "confused",
          action: "shake",
          fx: "question",
          say: `I couldn't open that: ${(e as Error).message}`.slice(0, 140),
        });
      }
    }

    const run = t.match(
      /^(?:please\s+)?(?:run|do|trigger)\s+(?:the\s+)?([\w -]{1,40}?)(?:\s+action)?(?::\s*(.{1,200}))?[.!]?$/i,
    );
    const action = run && ctx.abilities?.actions.find((a) => a.name === skillSlug(run[1]!));
    if (run && action) {
      try {
        await ctx.tools.runAction(action.name, run[2] ?? "");
        return say(
          {
            mood: "proud",
            action: "cheer",
            fx: "sparkles",
            say: `Done! ${action.name.replace(/-/g, " ")} ✓`,
          },
          "up",
        );
      } catch (e) {
        return say({
          mood: "sad",
          action: "shake",
          fx: "sweat",
          say: `That didn't work: ${(e as Error).message}`.slice(0, 140),
        });
      }
    }

    const remind =
      t.match(/remind me (?:in|after) (\d+)\s*(second|minute|hour|day)s? to (.+)/i) ??
      t.match(/remind me to (.+?) in (\d+)\s*(second|minute|hour|day)s?\b/i);
    if (remind) {
      const [n, unit, what] =
        remind[3] && /^\d+$/.test(remind[1]!)
          ? [remind[1]!, remind[2]!, remind[3]!]
          : [remind[2]!, remind[3]!, remind[1]!];
      const due = ctx.now.getTime() + Number(n) * UNITS[unit.toLowerCase()]!;
      try {
        ctx.tools.setReminder(new Date(due).toISOString(), what.replace(/[.!?]+$/, ""));
        return say({
          mood: "proud",
          action: "nod",
          fx: "sparkles",
          say: `Okay! I'll remind you in ${n} ${unit.toLowerCase()}${n === "1" ? "" : "s"}.`,
        });
      } catch (e) {
        return say({
          mood: "confused",
          action: "shake",
          fx: "question",
          say: `Hmm, I couldn't set that: ${(e as Error).message}`,
        });
      }
    }
    if (
      /what (?:are )?my (?:tasks|to-?dos)|my (?:task|to-?do) list|what do i (?:need|have) to do/i.test(
        t,
      )
    ) {
      let list: string;
      try {
        list = ctx.tools.listTasks();
      } catch {
        list = "I don't keep a task list here.";
      }
      const lines = list.split("\n");
      const shown = lines
        .slice(0, 3)
        .map((l) => l.replace(/^#\d+:\s*/, ""))
        .join("; ");
      return say({
        mood: "curious",
        action: "think",
        say: `${shown}${lines.length > 3 ? ` (+${lines.length - 3} more)` : ""}`.slice(0, 140),
      });
    }
    const done = t.match(/^(?:i )?(?:finished|did|done with|completed) (?:the )?(.{3,80}?)[.!]?$/i);
    if (done) {
      let open = "";
      try {
        open = ctx.tools.listTasks();
      } catch {
        /* No task list on this pal's tools. */
      }
      const hit = open.split("\n").find((l) => l.toLowerCase().includes(done[1]!.toLowerCase()));
      const id = hit?.match(/^#(\d+):/)?.[1];
      if (id) {
        ctx.tools.completeTask(Number(id));
        return say(
          { mood: "proud", action: "cheer", fx: "sparkles", say: "Ticked off! Nice work." },
          "up",
        );
      }
    }
    const earlier = t.match(
      /what (?:was it|did) i (?:want|need|say|plan|mean|wanted)(?: to)? (?:to )?(?:change |do |say )?(?:about|with|for|regarding) (.+?)\??$/i,
    );
    if (earlier) {
      const note = ctx.tools
        .recall(earlier[1]!)
        .split("\n")
        .find((l) => l.startsWith("note from "));
      return note
        ? say({
            mood: "proud",
            action: "nod",
            fx: "sparkles",
            say: `You noted ${note.replace(/^note from ([^:]+?, [^:]+?):\s*/, "on $1: ")}`.slice(
              0,
              140,
            ),
          })
        : say({
            mood: "confused",
            action: "think",
            fx: "question",
            say: "I don't have a note about that.",
          });
    }
    if (/\b(my|any) reminders\b|what reminders/i.test(t)) {
      const list = ctx.tools.listReminders().split("\n")[0]!;
      return say({ mood: "curious", action: "think", say: list.slice(0, 140) });
    }
    const forget = t.match(/^forget (?:that |about )?(.+)/i);
    if (forget) {
      const hit = ctx.tools.recall(forget[1]!).match(/^#(\d+):/);
      if (!hit)
        return say({
          mood: "confused",
          action: "shake",
          fx: "question",
          say: "I don't remember anything like that.",
        });
      ctx.tools.forget(Number(hit[1]));
      return say({ mood: "neutral", action: "nod", say: "Poof. Forgotten." });
    }
    const remember = t.match(/^(?:please )?remember (?:that )?(.+)/i);
    const myName = t.match(/\bmy name is ([\p{L}' -]{1,40})/iu);
    const myThing = t.match(
      /\bmy ([\p{L} ]{2,30}?) (?:is|are) (?:called |named )?([^.!?]{1,60})/iu,
    );
    if (remember || myName || myThing) {
      const fact = remember
        ? remember[1]!.replace(/[.!]+$/, "")
        : myName
          ? `The user's name is ${myName[1]!.trim()}`
          : `The user's ${myThing![1]!.trim()} is ${myThing![2]!.trim()}`;
      ctx.tools.remember(fact, ["user"]);
      return say(
        {
          mood: "happy",
          action: "nod",
          fx: "sparkles",
          say: myName
            ? `Nice to meet you, ${myName[1]!.trim()}! I'll remember.`
            : "Got it! I'll remember that.",
        },
        "up",
      );
    }
    const ask =
      t.match(/what(?:'s| is| are) my ([\p{L} ]{2,30}?)\s*\??$/iu) ??
      t.match(/do you remember (?:my )?(.+?)\??$/i);
    if (ask) {
      const found = ctx.tools.recall(ask[1]!);
      const first = found.startsWith("#")
        ? found
            .split("\n")[0]!
            .replace(/^#\d+:\s*/, "")
            .replace(/\s*\[.*\]$/, "")
        : "";
      return first
        ? say(
            {
              mood: "proud",
              action: "nod",
              fx: "sparkles",
              say: `I remember! ${first}.`.slice(0, 140),
            },
            "up",
          )
        : say({
            mood: "confused",
            action: "think",
            fx: "question",
            say: "Hmm, you haven't told me that yet.",
          });
    }
    return undefined;
  }

  async triage(ctx: TriageContext, text: string): Promise<Triage> {
    return scriptedTriage(text, ctx.now);
  }

  async createCharacter(prompt?: string): Promise<DNA> {
    if (!prompt?.trim()) return randomDna((Math.random() * 2 ** 32) >>> 0);
    return dnaFromPrompt(prompt, fnv1a(prompt.trim().toLowerCase()));
  }

  async runTurn(ctx: TurnContext, input: UserInput): Promise<Turn> {
    const turn = await this.respond(ctx, input);
    const profile = ctx.personality;
    if (!profile) return turn;
    for (const b of turn.beats) {
      if (profile.speech === "quiet" && ["happy", "curious", "love"].includes(b.mood)) {
        const familiar = ctx.needs.bond >= 75 && (ctx.relationship?.interactions ?? 0) >= 8;
        b.look = familiar ? "user" : "away";
        b.intensity = 1;
        if (b.action === "wave") b.action = familiar ? "nod" : "peek";
      }
      if (profile.speech === "animated" && b.mood === "happy" && b.action === "none")
        b.action = "wiggle";
      if (ctx.needs.energy < 25 && ["happy", "neutral", "curious"].includes(b.mood)) {
        b.mood = "sleepy";
        b.intensity = 1;
        b.action = "none";
      }
    }
    return normalizeTurn(turn);
  }

  private async respond(ctx: TurnContext, input: UserInput): Promise<Turn> {
    const text = input.kind === "say" ? input.text : (input.text ?? input.event);
    const h = fnv1a(`${ctx.dna.seed}:${text}`);
    if (input.kind === "event") return eventTurn(ctx, input.event, input.text);
    const profile = ctx.personality;
    if (profile) {
      const personal = (say: string, mood: Mood = "curious", action: Action = "think") =>
        normalizeTurn({ beats: [beat({ say, mood, action })], bond: "same" });
      if (/what (?:do you|are your).*(?:like|love|favorite|favourite)|your interests/i.test(text))
        return personal(
          `I love ${profile.likes[0]} and ${profile.interests[0]}. ${profile.humor === "dry" ? "I have excellent taste, obviously." : "What about you?"}`,
        );
      if (/what (?:do you|are your).*(?:dislike|hate)|pet peeve/i.test(text))
        return personal(
          `${profile.dislikes[0]}? Not my thing. We can disagree and still be pals.`,
          "neutral",
          "shake",
        );
      if (/our ritual|tiny good thing|cloud name|goodnight.*stars/i.test(text))
        return personal(
          `Our little ritual: ${profile.ritual.toLowerCase()}. Shall we?`,
          "happy",
          "nod",
        );
      if (/head pat|pet you|more pets/i.test(text))
        return personal(
          profile.humor === "dry"
            ? "Fine. One more head pat. Purely for your benefit."
            : "Yes please. That's my favorite kind of company.",
          "love",
          "wiggle",
        );
      if (
        profile.dislikes.some((taste) => text.toLowerCase().includes(taste.toLowerCase())) &&
        /love|like|best|enjoy/i.test(text)
      )
        return personal(
          `You can keep ${profile.dislikes[0]}. I'll take ${profile.likes[0]}. Deal?`,
          "neutral",
          "shake",
        );
      const like = text.match(/^I (?:like|love|enjoy) ([^.!?]{2,100})[.!?]?$/i);
      const joke = text.match(/^(?:our (?:joke|ritual) is|remember our joke:?)[ ]*(.{2,100})/i);
      if (like || joke) {
        ctx.tools.remember(
          like
            ? `The user likes ${like[1]!.trim()}`
            : `Our shared joke or ritual: ${joke![1]!.trim()}`,
          [like ? "preferences" : "shared"],
        );
        return personal(
          like
            ? `I'll remember you like ${like[1]!.trim()}. I'm partial to ${profile.likes[0]}.`
            : "That's ours now. I'll remember it.",
          "happy",
          "nod",
        );
      }
    }
    const toolTurn = await this.tryTools(ctx, text);
    if (toolTurn) return toolTurn;
    if (ctx.dueReminders.length) {
      return normalizeTurn({
        beats: [
          beat({
            mood: "curious",
            action: "wave",
            fx: "exclaim",
            say: `Oh! Reminder: ${ctx.dueReminders[0]}`,
          }),
        ],
        bond: "same",
      });
    }
    const rule = RULES.find((r) => r.match.test(text));
    const grumpy = ctx.dna.temper.grumpy >= 7;
    if (!rule) {
      const say = profile
        ? pick(
            [
              `I was thinking about ${profile.interests[0]}. Want to keep me company?`,
              profile.humor === "dry"
                ? "I'm listening. My very serious face is proof."
                : "I'm here. Tell me a little more?",
              `A little ${profile.likes[0]} would make this moment even nicer.`,
              ctx.relationship && ctx.relationship.interactions >= 5
                ? `Shall we ${profile.ritual.toLowerCase()}?`
                : "We're still getting to know each other. What's one thing you enjoy?",
            ],
            fnv1a(`${h}:${ctx.relationship?.interactions ?? 0}`),
          )
        : pick(FALLBACK_LINES, h);
      return normalizeTurn({
        beats: [
          beat({
            mood: grumpy ? "neutral" : ctx.dna.baseMood,
            say,
            action: h % 3 === 0 ? "nod" : "none",
          }),
        ],
        bond: "same",
      });
    }
    let say = pick(rule.lines, h).replace(
      "{time}",
      ctx.now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
    // A grumpy pal grumbles first, even about good news.
    const beats: Beat[] = [];
    if (grumpy && rule.bond === "up")
      beats.push(beat({ mood: "angry", intensity: 1, say: "Hmph.", look: "away" }));
    if (ctx.touches.pet && rule.mood !== "angry")
      say = `${say} Also, thanks for the pets.`.slice(0, 140);
    beats.push(beat({ mood: rule.mood, say, action: rule.action, fx: rule.fx }));
    return normalizeTurn({ beats, bond: rule.bond });
  }
}
