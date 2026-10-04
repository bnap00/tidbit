// /playground: every DNA field, every mood / action / fx / look, touches and needs. No brain required.
import {
  ACCESSORIES,
  ACTIONS,
  BODIES,
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
  TOUCH_KINDS,
  decodeDnaCode,
  encodeDnaCode,
  normalizeDna,
  randomDna,
  type Beat,
  type DNA,
} from "@tidbit/protocol";
import { ACTIVITIES } from "@tidbit/rig";
import { h, nav } from "../dom.js";
import { perf } from "../pal-view.js";
import { Stage } from "../stage.js";

type LookKey = keyof DNA["look"];
type TemperKey = keyof DNA["temper"];

const ENUM_FIELDS: [LookKey, readonly string[]][] = [
  ["body", BODIES],
  ["eyes", EYES],
  ["brows", BROWS],
  ["mouth", MOUTHS],
  ["ears", EARS],
  ["limbs", LIMBS],
  ["tail", TAILS],
  ["marking", MARKINGS],
  ["accessory", ACCESSORIES],
  ["scheme", SCHEMES],
];
const DIGIT_FIELDS: LookKey[] = ["size", "plump", "eyeSize", "eyeGap"];
const TEMPER_FIELDS: TemperKey[] = ["energy", "playful", "shy", "grumpy", "curious"];

export function playgroundPage(root: HTMLElement): () => void {
  const params = new URLSearchParams(location.search);
  let dna: DNA =
    decodeDnaCode(params.get("dna") ?? "") ?? randomDna(Number(params.get("seed") ?? 7) || 7);
  const beat: Beat = {
    mood: "happy",
    intensity: 2,
    say: "Hi! I'm a pal.",
    action: "wave",
    look: "user",
    fx: "sparkles",
  };
  const stage = new Stage(dna, 420);
  (window as unknown as { __stage: Stage }).__stage = stage;
  const needs = { energy: 80, hunger: 20, bond: 50 };
  const flags = { thinking: false, speaking: false };
  const controls = new Map<string, HTMLSelectElement | HTMLInputElement>();

  const play = () => {
    stage.rig.apply({ v: 1, beats: [{ ...beat }], bond: "same" }, performance.now());
  };

  const update = (next: DNA) => {
    dna = normalizeDna(next, { id: next.id, seed: next.seed });
    stage.setDna(dna);
    stage.rig.setNeeds(needs);
    stage.rig.setThinking(flags.thinking);
    stage.rig.setSpeaking(flags.speaking);
    syncControls();
    json.textContent = JSON.stringify(dna, null, 2);
    bytes.textContent = `${new TextEncoder().encode(JSON.stringify(dna)).length} bytes of DNA`;
    // Keep the URL shareable: it always describes the pal on screen.
    history.replaceState(null, "", `/playground?dna=${encodeDnaCode(dna)}`);
  };

  // --- DNA controls ------------------------------------------------------------
  const select = (key: string, values: readonly string[], onChange: (v: string) => void) => {
    const el = h(
      "select",
      { "data-field": key },
      ...values.map((v) => h("option", { value: v }, v)),
    );
    el.addEventListener("change", () => onChange(el.value));
    controls.set(key, el);
    return h("label", { class: "field" }, h("span", {}, key), el);
  };
  const slider = (key: string, max: number, onChange: (v: number) => void) => {
    const el = h("input", { type: "range", min: 0, max, step: 1, "data-field": key });
    const out = h("output");
    el.addEventListener("input", () => {
      out.textContent = el.value;
      onChange(Number(el.value));
    });
    controls.set(key, el);
    return h("label", { class: "field" }, h("span", {}, key, " ", out), el);
  };

  const lookFields = [
    ...ENUM_FIELDS.map(([key, values]) =>
      select(key, values, (v) => update({ ...dna, look: { ...dna.look, [key]: v } })),
    ),
    ...DIGIT_FIELDS.map((key) =>
      slider(key, 9, (v) => update({ ...dna, look: { ...dna.look, [key]: v } })),
    ),
    slider("hue", 359, (v) => update({ ...dna, look: { ...dna.look, hue: v } })),
  ];
  const temperFields = [
    ...TEMPER_FIELDS.map((key) =>
      slider(`temper.${key}`, 9, (v) => update({ ...dna, temper: { ...dna.temper, [key]: v } })),
    ),
    select("baseMood", MOODS, (v) => update({ ...dna, baseMood: v as DNA["baseMood"] })),
  ];

  function syncControls(): void {
    for (const [key] of ENUM_FIELDS) controls.get(key)!.value = String(dna.look[key]);
    for (const key of [...DIGIT_FIELDS, "hue" as const]) {
      const el = controls.get(key)!;
      el.value = String(dna.look[key]);
      (el.parentElement?.querySelector("output") as HTMLOutputElement).textContent = el.value;
    }
    for (const key of TEMPER_FIELDS) {
      const el = controls.get(`temper.${key}`)!;
      el.value = String(dna.temper[key]);
      (el.parentElement?.querySelector("output") as HTMLOutputElement).textContent = el.value;
    }
    controls.get("baseMood")!.value = dna.baseMood;
  }

  // --- Turn controls -----------------------------------------------------------
  const chips = (
    label: string,
    values: readonly string[],
    key: "mood" | "action" | "fx" | "look",
  ) => {
    const buttons = values.map((v) =>
      h("button", {
        class: "chip",
        text: v,
        "data-testid": `${key}-${v}`,
        onclick: () => {
          (beat as unknown as Record<string, string>)[key] = v;
          buttons.forEach((b) => b.classList.toggle("on", b.textContent === v));
          play();
        },
      }),
    );
    buttons.forEach((b) => b.classList.toggle("on", b.textContent === beat[key]));
    return h(
      "div",
      { class: "chip-group" },
      h("h3", {}, label),
      h("div", { class: "chips" }, ...buttons),
    );
  };
  const intensity = h(
    "div",
    { class: "chips" },
    ...[1, 2, 3].map((n) =>
      h("button", {
        class: `chip${n === beat.intensity ? " on" : ""}`,
        text: `×${n}`,
        onclick: (e: Event) => {
          beat.intensity = n;
          intensity
            .querySelectorAll("button")
            .forEach((b) => b.classList.toggle("on", b === e.currentTarget));
          play();
        },
      }),
    ),
  );
  const say = h("input", {
    type: "text",
    value: beat.say,
    maxlength: 140,
    placeholder: "What the pal says",
  });
  say.addEventListener("input", () => (beat.say = say.value));
  say.addEventListener("keydown", (e) => e.key === "Enter" && play());

  // --- Needs & state -------------------------------------------------------------
  const needSlider = (key: keyof typeof needs) => {
    const el = h("input", { type: "range", min: 0, max: 100, value: needs[key] });
    el.addEventListener("input", () => {
      needs[key] = Number(el.value);
      stage.rig.setNeeds(needs);
    });
    return h("label", { class: "field" }, h("span", {}, key), el);
  };
  const toggle = (label: string, on: (v: boolean) => void) => {
    const el = h("input", { type: "checkbox" });
    el.addEventListener("change", () => on(el.checked));
    return h("label", { class: "toggle" }, el, label);
  };

  const json = h("pre", { class: "json" });
  const bytes = h("span", { class: "muted" });
  const fps = h("span", { class: "muted", "data-testid": "fps" });
  const perfTimer = setInterval(() => {
    fps.textContent = `${perf.fps.toFixed(0)} fps · ${perf.workMs.toFixed(2)} ms/frame`;
  }, 500);

  root.replaceChildren(
    nav("/playground"),
    h(
      "main",
      { class: "page playground" },
      h(
        "section",
        { class: "stage-col" },
        stage.el,
        h(
          "div",
          { class: "row" },
          ...TOUCH_KINDS.map((k) =>
            h("button", { text: k, "data-testid": `touch-${k}`, onclick: () => stage.touch(k) }),
          ),
        ),
        h(
          "div",
          { class: "row" },
          h("button", {
            text: "Random pal",
            class: "primary",
            onclick: () => update(randomDna((Math.random() * 2 ** 32) >>> 0)),
          }),
          fps,
        ),
        h("details", {}, h("summary", {}, "DNA ", bytes), json),
      ),
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "Turn"),
        h(
          "div",
          { class: "row" },
          say,
          h("button", { class: "primary", text: "Play", onclick: play }),
        ),
        chips("Mood", MOODS, "mood"),
        h("div", { class: "chip-group" }, h("h3", {}, "Intensity"), intensity),
        chips("Action", ACTIONS, "action"),
        chips("Effect", FXS, "fx"),
        chips("Look", LOOKS, "look"),
        h(
          "div",
          { class: "chip-group" },
          h("h3", {}, "Idle activity"),
          h(
            "div",
            { class: "chips" },
            ...ACTIVITIES.map((a) =>
              h("button", {
                class: "chip",
                text: a,
                "data-testid": `activity-${a}`,
                onclick: () => stage.rig.setActivity(a, performance.now()),
              }),
            ),
          ),
        ),
        h("h2", {}, "Needs"),
        h(
          "div",
          { class: "grid-fields" },
          needSlider("energy"),
          needSlider("hunger"),
          needSlider("bond"),
        ),
        h(
          "div",
          { class: "row" },
          toggle("thinking", (v) => stage.rig.setThinking((flags.thinking = v))),
          toggle("speaking", (v) => stage.rig.setSpeaking((flags.speaking = v))),
        ),
      ),
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "Look"),
        h("div", { class: "grid-fields" }, ...lookFields),
        h("h2", {}, "Temper"),
        h("div", { class: "grid-fields" }, ...temperFields),
      ),
    ),
  );
  update(dna);
  play();
  return () => {
    clearInterval(perfTimer);
    stage.dispose();
  };
}
