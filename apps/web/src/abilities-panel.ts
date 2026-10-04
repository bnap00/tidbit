// "Skills & actions": teach the pal SKILL.md skills, give it HTTP actions, and see its
// routines. Everything is rendered with textContent; secrets are write-only.
import {
  ACTION_BODY_MAX,
  ACTION_HEADERS_MAX,
  ACTION_URL_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  skillToMarkdown,
  type AbilitiesState,
  type ActionInfo,
  type SkillInfo,
} from "@tidbit/protocol";
import type { BrainClient } from "./brain-client.js";
import { h } from "./dom.js";

const SOURCE_LABEL: Record<SkillInfo["source"], string> = {
  owner: "yours",
  pal: "learned",
  starter: "starter",
};

export interface AbilitiesPanel {
  el: HTMLDetailsElement;
  /** Reload if open (after a turn, when the pal may have learned something). */
  refresh(): void;
  /** The active pal changed: drop what is shown. */
  reset(): void;
}

export function abilitiesPanel(
  client: BrainClient,
  task: (operation: () => Promise<unknown>) => Promise<void>,
  report: (text: string) => void,
): AbilitiesPanel {
  let generation = 0;
  const builtins = h("div", { class: "pet-traits ability-builtins" });
  const skillList = h("div", { class: "ability-list", "data-testid": "skill-list" });
  const actionList = h("div", { class: "ability-list", "data-testid": "action-list" });
  const routineList = h("div", { class: "ability-list", "data-testid": "routine-list" });

  // --- skill editor: one SKILL.md textarea, like OpenClaw / Hermes skills -------------
  const skillText = h("textarea", {
    class: "skill-editor",
    maxlength: 6000,
    rows: 8,
    spellcheck: false,
    placeholder: `---\nname: plan-a-picnic\ndescription: Plan a picnic around the weather.\n---\n\n1. Ask where and when.\n2. Call get_weather for that place.\n3. Suggest snacks the user likes.`,
    "aria-label": "Skill (SKILL.md)",
    "data-testid": "skill-editor",
  });
  const skillForm = h(
    "form",
    { class: "ability-form" },
    h("p", {
      class: "muted",
      text: "Write or paste a SKILL.md: a name, a one-line description of when to use it, then the steps. Your pal loads a skill when a request matches it.",
    }),
    skillText,
    h(
      "div",
      { class: "row" },
      h("button", {
        class: "primary",
        type: "submit",
        text: "Save skill",
        "data-testid": "save-skill",
      }),
      h("button", { type: "button", text: "Clear", onclick: () => (skillText.value = "") }),
    ),
  );
  skillForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void task(async () => {
      await client.manage({ action: "save_skill", skillMarkdown: skillText.value });
      skillText.value = "";
      report("Skill saved. Your pal will use it when it fits.");
      await load();
    });
  });

  // --- action editor --------------------------------------------------------------------
  const field = <T extends HTMLElement>(label: string, control: T) =>
    h("label", { class: "field" }, label, control);
  const actionName = h("input", {
    type: "text",
    maxlength: SKILL_NAME_MAX,
    placeholder: "lamp-on",
    "data-testid": "action-name",
  });
  const actionDescription = h("input", {
    type: "text",
    maxlength: SKILL_DESCRIPTION_MAX,
    placeholder: "Turn on the lamp. Input is the room.",
    "data-testid": "action-description",
  });
  const actionMethod = h(
    "select",
    { "data-testid": "action-method" },
    h("option", { value: "POST", text: "POST" }),
    h("option", { value: "GET", text: "GET" }),
  );
  const actionUrl = h("input", {
    type: "text",
    maxlength: ACTION_URL_MAX,
    placeholder: "https://example.com/hook?room={input}",
    "data-testid": "action-url",
  });
  const actionHeaders = h("textarea", {
    rows: 2,
    maxlength: ACTION_HEADERS_MAX,
    placeholder: "Authorization: Bearer …",
    spellcheck: false,
    "data-testid": "action-headers",
  });
  const actionBody = h("textarea", {
    rows: 2,
    maxlength: ACTION_BODY_MAX,
    placeholder: '{"message": "{input}"}  (default {"input": …})',
    spellcheck: false,
    "data-testid": "action-body",
  });
  let editingHeaders: string[] = [];
  const actionForm = h(
    "form",
    { class: "ability-form personality-form" },
    h("p", {
      class: "muted",
      text: "Actions are web requests your pal can make when you ask, like a Home Assistant or ntfy webhook. {input} is replaced by what your pal passes in. Headers are stored on your brain and never shown again.",
    }),
    h("div", { class: "grid-fields" }, field("Name", actionName), field("Method", actionMethod)),
    field("When to use it", actionDescription),
    field("URL", actionUrl),
    field("Headers (optional, one per line)", actionHeaders),
    field("Body template (POST, optional)", actionBody),
    h("button", {
      class: "primary",
      type: "submit",
      text: "Save action",
      "data-testid": "save-action",
    }),
  );
  const resetActionForm = () => {
    actionForm.reset();
    editingHeaders = [];
    actionHeaders.placeholder = "Authorization: Bearer …";
  };
  actionForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void task(async () => {
      const headers = actionHeaders.value.trim();
      await client.manage({
        action: "save_http_action",
        httpAction: {
          name: actionName.value.trim(),
          description: actionDescription.value.trim(),
          method: actionMethod.value,
          url: actionUrl.value.trim(),
          // Blank while editing keeps the saved (hidden) headers.
          ...(headers || !editingHeaders.length ? { headers } : {}),
          bodyTemplate: actionBody.value.trim(),
        },
      });
      resetActionForm();
      report("Action saved. Ask your pal to use it.");
      await load();
    });
  });
  const editAction = (a: ActionInfo) => {
    actionName.value = a.name;
    actionDescription.value = a.description;
    actionMethod.value = a.method;
    actionUrl.value = a.url;
    actionBody.value = a.bodyTemplate;
    actionHeaders.value = "";
    editingHeaders = a.headerNames;
    actionHeaders.placeholder = a.headerNames.length
      ? `Saved: ${a.headerNames.join(", ")}. Leave blank to keep.`
      : "Authorization: Bearer …";
    actionName.focus();
  };

  const toggle = (label: string, checked: boolean, onchange: (on: boolean) => void) => {
    const box = h("input", { type: "checkbox", "aria-label": label });
    box.checked = checked;
    box.addEventListener("change", () => onchange(box.checked));
    return h("label", { class: "ability-toggle", title: checked ? "On" : "Off" }, box);
  };

  function renderSkill(s: SkillInfo) {
    return h(
      "div",
      { class: `ability-item${s.enabled ? "" : " off"}`, "data-testid": `skill-${s.name}` },
      h(
        "div",
        { class: "ability-head" },
        toggle(
          `Use ${s.name}`,
          s.enabled,
          (on) =>
            void task(async () => {
              await client.manage({ action: "toggle_skill", itemId: s.id, enabled: on });
              await load();
            }),
        ),
        h("strong", { text: s.name }),
        h("span", { class: `ability-badge source-${s.source}`, text: SOURCE_LABEL[s.source] }),
        s.uses ? h("span", { class: "muted ability-uses", text: `used ${s.uses}×` }) : null,
      ),
      h("p", { class: "muted", text: s.description }),
      h(
        "div",
        { class: "row" },
        h("button", {
          text: "Edit",
          onclick: () => {
            skillText.value = skillToMarkdown(s);
            skillText.focus();
          },
        }),
        h("button", {
          text: "Copy SKILL.md",
          onclick: () =>
            void task(async () => {
              await navigator.clipboard.writeText(skillToMarkdown(s));
              report(`Copied ${s.name} as SKILL.md.`);
            }),
        }),
        h("button", {
          text: "Delete",
          "data-testid": `delete-skill-${s.name}`,
          onclick: () =>
            void task(async () => {
              await client.manage({ action: "delete_skill", itemId: s.id });
              await load();
            }),
        }),
      ),
    );
  }

  function renderAction(a: ActionInfo) {
    let host = a.url;
    try {
      host = new URL(a.url.replaceAll("{input}", "x")).host;
    } catch {
      /* shown as typed */
    }
    return h(
      "div",
      { class: `ability-item${a.enabled ? "" : " off"}`, "data-testid": `action-${a.name}` },
      h(
        "div",
        { class: "ability-head" },
        toggle(
          `Allow ${a.name}`,
          a.enabled,
          (on) =>
            void task(async () => {
              await client.manage({ action: "toggle_http_action", itemId: a.id, enabled: on });
              await load();
            }),
        ),
        h("strong", { text: a.name }),
        h("span", { class: "ability-badge", text: `${a.method} ${host}` }),
        a.uses ? h("span", { class: "muted ability-uses", text: `used ${a.uses}×` }) : null,
      ),
      h("p", { class: "muted", text: a.description }),
      h(
        "div",
        { class: "row" },
        h("button", { text: "Edit", onclick: () => editAction(a) }),
        h("button", {
          text: "Delete",
          onclick: () =>
            void task(async () => {
              await client.manage({ action: "delete_http_action", itemId: a.id });
              await load();
            }),
        }),
      ),
    );
  }

  async function load() {
    if (!client.session) return;
    const mine = ++generation,
      palId = client.session.dna.id;
    const state = await client.api<AbilitiesState>("abilities");
    if (mine !== generation || palId !== client.session?.dna.id) return;
    builtins.replaceChildren(
      ...state.builtins.map((b) => h("span", { text: b.name, title: b.description })),
    );
    skillList.replaceChildren(
      ...(state.skills.length
        ? state.skills.map(renderSkill)
        : [h("p", { class: "muted", text: "No skills yet. Teach your pal one below." })]),
    );
    actionList.replaceChildren(
      ...(state.actions.length
        ? state.actions.map(renderAction)
        : [h("p", { class: "muted", text: "No actions yet." })]),
    );
    routineList.replaceChildren(
      ...(state.routines.length
        ? state.routines.map((r) =>
            h(
              "div",
              { class: "ability-item", "data-testid": `routine-${r.id}` },
              h(
                "div",
                { class: "ability-head" },
                h("strong", {
                  text: new Date(r.dueAt).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                    ...(r.dueAt - Date.now() > 6 * 86_400_000
                      ? { day: "numeric", month: "short" }
                      : {}),
                  }),
                }),
                r.repeat !== "none" ? h("span", { class: "ability-badge", text: r.repeat }) : null,
              ),
              h("p", { class: "muted", text: r.text }),
              h("button", {
                text: r.repeat === "none" ? "Cancel" : "Stop routine",
                onclick: () =>
                  void task(async () => {
                    await client.manage({ action: "cancel_routine", itemId: r.id });
                    await load();
                  }),
              }),
            ),
          )
        : [
            h("p", {
              class: "muted",
              text: 'Ask your pal: "every weekday at 8, give me a morning briefing".',
            }),
          ]),
    );
  }

  const el = h(
    "details",
    { class: "companion-details abilities", "data-testid": "abilities" },
    h("summary", {}, "Skills & actions", h("span", { text: "What your pal knows how to do" })),
    builtins,
    h("h3", { class: "ability-title", text: "Skills" }),
    skillList,
    skillForm,
    h("h3", { class: "ability-title", text: "Actions" }),
    actionList,
    actionForm,
    h("h3", { class: "ability-title", text: "Routines & reminders" }),
    routineList,
  );
  el.addEventListener("toggle", () => {
    if (el.open) void task(load);
  });
  return {
    el,
    refresh: () => {
      if (el.open) void task(load);
    },
    reset: () => {
      generation++;
      for (const list of [builtins, skillList, actionList, routineList]) list.replaceChildren();
      skillText.value = "";
      resetActionForm();
      if (el.open) void task(load);
    },
  };
}
