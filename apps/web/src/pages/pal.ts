import {
  decodeDnaCode,
  encodeDnaCode,
  randomDna,
  type ChatLine,
  type CompanionState,
  type DNA,
  type MemoryInfo,
  type Needs,
  type PalInfo,
  type Personality,
  type Turn,
} from "@tidbit/protocol";
import { abilitiesPanel } from "../abilities-panel.js";
import { BrainClient, defaultBrainUrl, type ConnState, type Pending } from "../brain-client.js";
import { secondBrainPanel } from "../second-brain-panel.js";
import { h, nav } from "../dom.js";
import { PalView } from "../pal-view.js";
import { Stage } from "../stage.js";
import { playTouchSound } from "../sfx.js";
import { KOKORO_DOWNLOAD_MB, Voice, type VoiceEngine } from "../voice.js";

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;

/** Short relative time for list rows: "5m ago", "3h ago", "Mon", "12 Sep". */
function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 7 * DAY) return new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function dayGroup(ms: number, now = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= today) return "Today";
  if (ms >= today - DAY) return "Yesterday";
  if (ms >= today - 6 * DAY) return "This week";
  return "Earlier";
}

export function palPage(root: HTMLElement): () => void {
  const stage = new Stage(randomDna(1), Math.min(360, window.innerWidth - 48));
  (window as unknown as { __stage: Stage }).__stage = stage;
  const client = new BrainClient(defaultBrainUrl());
  const voice = new Voice();
  let dna: DNA | null = null;
  let displayedPalId = "";
  let activeConversation = "";
  let thinking = false;
  let disposed = false;
  let memoryGeneration = 0;
  let lastError = "";
  let welcome = "";
  let profileJson = "";
  const lines = new Map<number, ChatLine>();
  const notes: string[] = [];
  let pending: readonly Pending[] = [];
  /** Queued chat messages; captures are shown in Today instead. */
  const queuedSays = () => pending.filter((p) => p.type === "say");
  const name = h("h2", { class: "pal-name", "data-testid": "pal-name", text: "Your pal" });
  const bio = h("p", { class: "pal-bio muted" });
  const status = h("span", { class: "status", "data-testid": "status" });
  const mood = h("span", {
    class: "pet-mood",
    "data-testid": "pet-mood",
    text: "Getting comfortable",
  });
  const relationship = h("span", { class: "relationship", "data-testid": "relationship" });
  const traits = h("div", { class: "pet-traits" });
  const actionNote = h("span", { class: "pet-hint", text: "Click to poke · stroke to pet" });
  const notice = h("p", { class: "companion-notice", role: "status", hidden: true });
  const outbox = h("div", { class: "outbox", "data-testid": "outbox", hidden: true });
  const report = (text: string) => {
    if (disposed) return;
    notice.textContent = text;
    notice.hidden = false;
  };
  const task = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (e) {
      report((e as Error).message);
    }
  };
  const bar = (label: string) => {
    const fill = h("span", { class: "fill" });
    const number = h("span", { class: "need-number" });
    return {
      el: h(
        "div",
        { class: `need need-${label}` },
        h("span", { class: "need-label" }, label, number),
        h("span", { class: "track" }, fill),
      ),
      set(value: number) {
        fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
        number.textContent = String(Math.round(value));
      },
    };
  };
  const energy = bar("energy"),
    fullness = bar("fullness"),
    bond = bar("bond");
  const setNeeds = (needs: Needs) => {
    stage.rig.setNeeds(needs);
    energy.set(needs.energy);
    fullness.set(100 - needs.hunger);
    bond.set(needs.bond);
  };
  const log = h("ol", {
    class: "transcript",
    "data-testid": "transcript",
    "aria-label": "Conversation",
  });
  const emptyLog = h(
    "div",
    { class: "conversation-empty" },
    h("span", { text: "A little hello goes a long way." }),
    h("p", { class: "muted", text: "Tell your pal about your day, or just enjoy the company." }),
  );
  function renderLog(older = false) {
    const oldHeight = log.scrollHeight,
      oldTop = log.scrollTop;
    const nearBottom = oldHeight - oldTop - log.clientHeight < 70;
    const canonical = [...lines.values()].sort((a, b) => a.id - b.id);
    const known = new Set(
      canonical.filter((line) => line.who === "you").map((line) => line.requestId),
    );
    const items = canonical.map((line) => ({
      who: line.who,
      text: line.text,
      queued:
        line.who === "you" && queuedSays().some((message) => message.requestId === line.requestId),
    }));
    for (const text of notes) items.push({ who: "note", text, queued: false });
    for (const item of queuedSays())
      if (item.conversationId === activeConversation && !known.has(item.requestId))
        items.push({ who: "you", text: item.text, queued: true });
    log.replaceChildren(
      ...items.map((item) =>
        h(
          "li",
          { class: item.who },
          h("span", {
            class: "who",
            text: item.who === "pal" ? (dna?.name ?? "pal") : item.who === "you" ? "you" : "",
          }),
          h(
            "span",
            { class: "chat-text" },
            item.text,
            item.queued
              ? h("small", {
                  class: "queued",
                  text: client.state === "open" ? "Sending…" : "Queued for reconnect",
                })
              : null,
          ),
        ),
      ),
    );
    emptyLog.hidden = items.length > 0;
    if (older) log.scrollTop = log.scrollHeight - oldHeight + oldTop;
    else if (nearBottom) log.scrollTop = log.scrollHeight;
  }
  function renderOutbox() {
    const waiting = pending.filter((message) =>
      message.type === "say"
        ? message.conversationId !== activeConversation
        : message.palId !== client.session?.dna.id,
    );
    outbox.hidden = !waiting.length;
    outbox.replaceChildren(
      ...waiting.map((message) =>
        h(
          "div",
          { class: "outbox-item" },
          h("span", {
            text:
              message.type === "say"
                ? `Queued in another conversation: ${message.text}`
                : `Note for another pal: ${message.text}`,
          }),
          h("button", {
            text: message.type === "say" ? "Continue and send" : "Switch and file",
            onclick: () =>
              void task(async () => {
                if (client.session?.dna.id !== message.palId)
                  await client.manage({ action: "switch_pal", palId: message.palId });
                if (message.type === "say")
                  await client.manage({
                    action: "resume",
                    conversationId: message.conversationId,
                  });
              }),
          }),
        ),
      ),
    );
  }
  const addNote = (text: string) => {
    notes.push(text);
    renderLog();
  };
  const input = h("input", {
    type: "text",
    maxlength: 1000,
    placeholder: "Tell your pal something… (/note to jot one down)",
    "aria-label": "Message your pal",
    "data-testid": "chat-input",
    autocomplete: "off",
  });
  const sendBtn = h("button", {
    type: "button",
    class: "primary",
    text: "Send",
    "data-testid": "send",
  });
  /** Chat shortcuts for the second brain: /note, /keep, /brief, /week. */
  const command = (text: string): boolean => {
    const m = /^\/(note|n|keep|brief|today|week)\b\s*([\s\S]*)$/i.exec(text);
    if (!m) return false;
    const verb = m[1]!.toLowerCase();
    const rest = m[2]!.trim();
    if (verb === "brief" || verb === "today" || verb === "week") {
      if (!client.brief(verb === "week" ? "week" : "day")) report("Reconnect for a briefing.");
    } else if (!rest) report("Write the note after the command, e.g. /note buy filament.");
    else brain.capture(rest, verb !== "keep");
    return true;
  };
  const send = () => {
    const text = input.value.trim();
    if (text && command(text)) {
      input.value = "";
      client.saveDraft("");
      return;
    }
    if (!text || !client.say(text)) return;
    input.value = "";
    client.saveDraft("");
    stage.rig.setTyping(false);
    if (client.state === "open") stage.rig.setThinking(true);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) send();
  });
  input.addEventListener("input", () => {
    client.saveDraft(input.value);
    stage.rig.setTyping(input.value.length > 0);
  });
  input.addEventListener("focus", () => stage.rig.setTyping(true));
  input.addEventListener("blur", () => stage.rig.setTyping(false));
  sendBtn.addEventListener("click", send);
  const setStatus = (state: ConnState) => {
    status.dataset.state = state;
    status.textContent =
      state === "open"
        ? "connected"
        : state === "connecting"
          ? "connecting…"
          : "brain offline, reconnecting…";
    input.disabled = !client.session;
    sendBtn.disabled = !client.session;
    if (state === "open") {
      if (/offline|reconnect/i.test(notice.textContent ?? "")) notice.hidden = true;
      lastError = "";
    }
    if (state !== "open") {
      thinking = false;
      stage.rig.setThinking(false);
    }
    renderLog();
  };
  const promptInput = h("input", {
    type: "text",
    placeholder: "a grumpy cactus cat…",
    "aria-label": "Describe your new pal",
    maxlength: 300,
    "data-testid": "create-input",
  });
  const createPal = (random = false) => {
    if (pending.length) {
      report("Let your queued messages finish first.");
      return;
    }
    const prompt = random ? "" : promptInput.value.trim();
    if (client.send({ type: "create", ...(prompt ? { prompt } : {}) })) {
      createPanel.hidden = true;
      promptInput.value = "";
      addNote(prompt ? `Creating “${prompt}”…` : "Meeting a new pal…");
    } else report("Reconnect to create a pal.");
  };
  const createPanel = h(
    "div",
    { class: "create", hidden: true },
    promptInput,
    h("button", {
      class: "primary",
      text: "Create",
      "data-testid": "create",
      onclick: () => createPal(),
    }),
    h("button", { text: "Random", "data-testid": "create-random", onclick: () => createPal(true) }),
  );
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createPal();
  });
  const share = async () => {
    if (!dna) return;
    const url = `${location.origin}/?pal=${encodeDnaCode(dna, { persona: true })}`;
    try {
      await navigator.clipboard.writeText(url);
      report("Pal link copied. Friends can adopt their own copy.");
    } catch {
      report(url);
    }
  };
  const shared = decodeDnaCode(new URLSearchParams(location.search).get("pal") ?? "");
  const adoptBar = h("div", { class: "adopt", hidden: !shared, "data-testid": "adopt-bar" });
  if (shared)
    adoptBar.append(
      h("span", { text: `Adopt ${shared.name}? Your other pals will stay in your collection.` }),
      h("button", {
        class: "primary",
        text: "Adopt",
        "data-testid": "adopt",
        onclick: () => {
          if (pending.length) return report("Let your queued messages finish first.");
          if (client.send({ type: "create", dna: shared })) {
            adoptBar.hidden = true;
            history.replaceState(null, "", "/");
          }
        },
      }),
      h("button", {
        text: "No thanks",
        onclick: () => {
          adoptBar.hidden = true;
          history.replaceState(null, "", "/");
        },
      }),
    );

  // Library: the pal shelf and the active pal's conversations. A drawer on narrow screens.
  let current: CompanionState | null = null;
  const library = h("aside", { class: "library", "aria-label": "Pals and conversations" });
  const scrim = h("div", { class: "library-scrim", hidden: true });
  const libraryToggle = h("button", {
    class: "library-toggle",
    text: "Pals",
    "aria-expanded": "false",
    "aria-label": "Show pals and conversations",
    "data-testid": "library-toggle",
  });
  const setDrawer = (open: boolean) => {
    if (open === library.classList.contains("open")) return;
    // Animate only on toggle, never when a resize crosses the breakpoint.
    library.classList.add("sliding");
    library.classList.toggle("open", open);
    scrim.hidden = !open;
    libraryToggle.setAttribute("aria-expanded", String(open));
  };
  library.addEventListener("transitionend", () => library.classList.remove("sliding"));
  libraryToggle.addEventListener("click", () => setDrawer(!library.classList.contains("open")));
  scrim.addEventListener("click", () => setDrawer(false));
  // One still frame per pal, redrawn only when its DNA changes; never in the animation loop.
  const avatars = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  const avatar = (pal: PalInfo) => {
    const key = JSON.stringify(pal.dna);
    let hit = avatars.get(pal.id);
    if (hit?.key !== key) {
      const view = new PalView(pal.dna, 52);
      view.draw(1200);
      view.canvas.className = "pal-avatar";
      view.canvas.setAttribute("aria-hidden", "true");
      hit = { key, canvas: view.canvas };
      avatars.set(pal.id, hit);
    }
    return hit.canvas;
  };
  const newPalTile = h(
    "li",
    {},
    h(
      "button",
      {
        class: "pal-tile pal-tile-new",
        "data-testid": "new-pal",
        "aria-label": "Create a new pal",
        onclick: () => {
          createPanel.hidden = !createPanel.hidden;
          if (!createPanel.hidden) promptInput.focus();
        },
      },
      h("span", { class: "pal-avatar pal-avatar-new", "aria-hidden": "true", text: "+" }),
      h("span", { class: "pal-tile-name", text: "New pal" }),
    ),
  );
  const palShelf = h("ul", { class: "pal-shelf", "data-testid": "pal-list" });
  function renderPals(state: CompanionState) {
    palShelf.replaceChildren(
      ...state.pals.map((pal) => {
        const active = pal.id === state.dna.id;
        return h(
          "li",
          {},
          h(
            "button",
            {
              class: "pal-tile",
              "data-id": pal.id,
              "aria-current": active ? "true" : false,
              title: pal.persona,
              onclick: () => {
                setDrawer(false);
                if (!active)
                  void task(() => client.manage({ action: "switch_pal", palId: pal.id }));
              },
            },
            avatar(pal),
            h("span", { class: "pal-tile-name", text: pal.name }),
            h("span", { class: "pal-tile-when", text: active ? "here now" : ago(pal.lastActive) }),
          ),
        );
      }),
      newPalTile,
    );
  }
  const conversationsTitle = h("h3", { text: "Conversations" });
  const conversationFilter = h("input", {
    type: "search",
    placeholder: "Search conversations",
    "aria-label": "Search conversations",
    "data-testid": "conversation-filter",
    hidden: true,
  });
  const conversationList = h("div", {
    class: "conversation-list",
    "data-testid": "conversation-list",
  });
  function renderConversations() {
    if (!current) return;
    const state = current;
    const query = conversationFilter.value.trim().toLowerCase();
    conversationsTitle.textContent = `With ${state.dna.name}`;
    conversationFilter.hidden = state.conversations.length < 6 && !query;
    const shown = state.conversations.filter(
      (c) => !query || `${c.title} ${c.preview}`.toLowerCase().includes(query),
    );
    const groups = new Map<string, HTMLElement[]>();
    for (const c of shown) {
      const active = c.id === state.conversationId;
      const row = h(
        "li",
        {},
        h(
          "button",
          {
            class: "thread",
            "data-id": c.id,
            "aria-current": active ? "true" : false,
            onclick: () => {
              setDrawer(false);
              if (!active)
                void task(() => client.manage({ action: "resume", conversationId: c.id }));
            },
          },
          h(
            "span",
            { class: "thread-top" },
            h("span", { class: "thread-title", text: c.messages ? c.title : "New conversation" }),
            h("span", { class: "thread-when", text: c.messages ? ago(c.updatedAt) : "" }),
          ),
          h("span", { class: "thread-preview", text: c.messages ? c.preview : "Nothing said yet" }),
        ),
      );
      const group = dayGroup(c.updatedAt);
      groups.set(group, [...(groups.get(group) ?? []), row]);
    }
    conversationList.replaceChildren(
      ...[...groups].flatMap(([label, rows]) => [
        h("h4", { class: "thread-group", text: label }),
        h("ul", { class: "thread-list" }, ...rows),
      ]),
    );
    if (!shown.length)
      conversationList.append(h("p", { class: "muted library-empty", text: "No matches." }));
  }
  conversationFilter.addEventListener("input", renderConversations);
  library.append(
    h(
      "section",
      { class: "library-section" },
      h("header", { class: "library-head" }, h("h3", { text: "Your pals" })),
      palShelf,
      createPanel,
    ),
    h(
      "section",
      { class: "library-section library-conversations" },
      h("header", { class: "library-head" }, conversationsTitle),
      conversationFilter,
      conversationList,
    ),
  );
  // The conversation header: what this chat is, and the way to start another.
  const chatTitle = h("h1", { class: "chat-title", "data-testid": "chat-title" });
  const chatMeta = h("p", { class: "chat-meta" });
  function renderChatHead() {
    if (!current) return;
    const info = current.conversations.find((c) => c.id === current!.conversationId);
    chatTitle.textContent = info?.messages ? info.title : `A new chat with ${current.dna.name}`;
    chatMeta.textContent = info?.messages
      ? `${info.messages} messages · started ${ago(info.createdAt)}`
      : "Nothing said yet";
  }
  const olderBtn = h("button", {
    class: "load-older",
    text: "Load earlier messages",
    "data-testid": "load-older",
    hidden: true,
    onclick: () =>
      void task(async () => {
        const conversation = activeConversation;
        const cursor = Math.min(...lines.keys());
        olderBtn.disabled = true;
        try {
          const history = await client.older(cursor);
          if (conversation !== activeConversation) return;
          history.lines.forEach((line) => lines.set(line.id, line));
          olderBtn.hidden = !history.hasOlder;
          renderLog(true);
        } finally {
          olderBtn.disabled = false;
        }
      }),
  });

  const memoriesList = h("div", { class: "memory-list", "data-testid": "memory-list" });
  let oldestMemory = 0;
  const earlierMemories = h("button", {
    text: "Load earlier memories",
    "data-testid": "earlier-memories",
    hidden: true,
    onclick: () => void task(() => loadMemories(oldestMemory)),
  });
  const memoryInput = h("input", {
    type: "text",
    maxlength: 300,
    placeholder: "Something you'd like your pal to remember",
    "aria-label": "New memory",
    "data-testid": "memory-input",
  });
  const memoryDetails = h(
    "details",
    { class: "companion-details" },
    h("summary", {}, "Memories", h("span", { text: "What stays with your pal" })),
    h("p", {
      class: "muted",
      text: "These memories carry across conversations. You can edit or forget them.",
    }),
    memoriesList,
    earlierMemories,
    h(
      "form",
      { class: "memory-create" },
      memoryInput,
      h("button", {
        class: "primary",
        type: "submit",
        text: "Remember",
        "data-testid": "remember-memory",
      }),
    ),
  );
  async function loadMemories(before?: number) {
    if (!client.session) return;
    const generation = ++memoryGeneration,
      palId = client.session.dna.id;
    const memories = await client.api<MemoryInfo[]>(
      before ? `memories?before=${before}` : "memories",
    );
    if (disposed || generation !== memoryGeneration || palId !== client.session?.dna.id) return;
    const entries = memories.map((memory) => {
      const edit = h("textarea", {
        maxlength: 600,
        "aria-label": `Memory ${memory.id}`,
        "data-testid": `memory-${memory.id}`,
      });
      edit.value = memory.fact;
      return h(
        "div",
        { class: "memory-item" },
        edit,
        h(
          "div",
          { class: "row" },
          h("button", {
            text: "Save",
            onclick: () =>
              void task(async () => {
                await client.manage({
                  action: "edit_memory",
                  memoryId: memory.id,
                  fact: edit.value.trim(),
                });
                await loadMemories();
              }),
          }),
          h("button", {
            text: "Forget",
            "data-testid": `forget-${memory.id}`,
            onclick: () =>
              void task(async () => {
                await client.manage({ action: "forget", memoryId: memory.id });
                await loadMemories();
              }),
          }),
        ),
      );
    });
    if (before) memoriesList.append(...entries);
    else memoriesList.replaceChildren(...entries);
    oldestMemory = memories.at(-1)?.id ?? 0;
    earlierMemories.hidden = memories.length < 100;
    if (!memories.length && !before)
      memoriesList.append(
        h("p", { class: "muted", text: "A fresh start. Share something worth keeping." }),
      );
  }
  memoryDetails.addEventListener("toggle", () => {
    if (memoryDetails.open) void task(loadMemories);
  });
  memoryDetails.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void task(async () => {
      await client.manage({ action: "remember", fact: memoryInput.value.trim() });
      memoryInput.value = "";
      await loadMemories();
    });
  });

  const profileControls = new Map<keyof Personality, HTMLInputElement | HTMLSelectElement>();
  const profileField = (key: keyof Personality, label: string, options?: string[]) => {
    const field = options
      ? h("select", {}, ...options.map((value) => h("option", { value, text: value })))
      : h("input", {
          type: "text",
          maxlength: key === "quirk" ? 180 : key === "ritual" ? 120 : 240,
        });
    field.setAttribute("data-testid", `personality-${key}`);
    profileControls.set(key, field);
    return h("label", { class: "field" }, label, field);
  };
  const personalityDetails = h(
    "details",
    { class: "companion-details" },
    h("summary", {}, "Personality", h("span", { text: "A character of their own" })),
    h(
      "form",
      { class: "personality-form" },
      h("p", {
        class: "muted",
        text: "Core tastes stay consistent. Mood and familiarity grow through your time together. Separate tastes with commas (up to four).",
      }),
      h(
        "div",
        { class: "grid-fields" },
        profileField("humor", "Humor", ["gentle", "dry", "silly"]),
        profileField("speech", "Voice and movement", ["quiet", "warm", "animated"]),
        profileField("interests", "Interests"),
        profileField("likes", "Likes"),
        profileField("dislikes", "Dislikes"),
      ),
      profileField("quirk", "Little quirk"),
      profileField("ritual", "Your shared ritual"),
      h("button", {
        class: "primary",
        type: "submit",
        text: "Save personality",
        "data-testid": "save-personality",
      }),
    ),
  );
  personalityDetails.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void task(async () => {
      const values = Object.fromEntries(
        [...profileControls].map(([key, field]) => [
          key,
          ["interests", "likes", "dislikes"].includes(key)
            ? field.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean)
            : field.value.trim(),
        ]),
      );
      await client.manage({ action: "personality", personality: values });
      report("Personality saved. Your pal will carry it into every conversation.");
    });
  });

  const abilities = abilitiesPanel(client, task, report);
  const brain = secondBrainPanel(client, task, report);

  const pairCode = h("output", { class: "pair-code", "data-testid": "pair-code" });
  const pairExpiry = h("span", { class: "muted" });
  let expiresAt = 0;
  const pairInput = h("input", {
    type: "text",
    placeholder: "ABCDE-12345",
    maxlength: 11,
    "aria-label": "Pairing code from your other device",
    "data-testid": "pair-input",
    autocomplete: "off",
  });
  const deviceCode = h("input", {
    type: "text",
    inputmode: "numeric",
    placeholder: "123456",
    maxlength: 7,
    "aria-label": "Code shown on the device",
    "data-testid": "device-code",
    autocomplete: "off",
  });
  const deviceList = h("ul", { class: "device-list", "data-testid": "device-list" });
  type DeviceInfo = { id: number; name: string; createdAt: number; lastSeen: number | null };
  const loadDevices = async () => {
    const list = await client.api<DeviceInfo[]>("devices");
    deviceList.replaceChildren(
      ...list.map((d) =>
        h(
          "li",
          {},
          h("span", { text: d.name }),
          h("small", {
            class: "muted",
            text: d.lastSeen ? `seen ${ago(d.lastSeen)}` : `paired ${ago(d.createdAt)}`,
          }),
          h("button", {
            text: "Remove",
            onclick: () =>
              void task(async () => {
                await client.api("devices/revoke", { id: d.id });
                await loadDevices();
              }),
          }),
        ),
      ),
    );
  };
  const deviceForm = h(
    "form",
    { class: "pair-form" },
    deviceCode,
    h("button", { type: "submit", text: "Connect device", "data-testid": "device-approve" }),
  );
  deviceForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void task(async () => {
      const result = await client.api<{ name: string }>("device/pair/approve", {
        code: deviceCode.value.trim(),
      });
      deviceCode.value = "";
      report(`${result.name} is connected. It shares this pal, its tasks and notes.`);
      await loadDevices();
    });
  });
  const pairingDetails = h(
    "details",
    { class: "companion-details" },
    h("summary", {}, "Your devices", h("span", { text: "The same pal, wherever you are" })),
    h("p", {
      class: "muted",
      text: "Generate a code here, then enter it in your other browser. Paired devices share your pets, conversations and memories.",
    }),
    h("button", {
      text: "Generate pairing code",
      "data-testid": "generate-pair-code",
      onclick: () =>
        void task(async () => {
          const result = await client.api<{ code: string; expiresAt: number }>("pair", {});
          pairCode.textContent = result.code;
          expiresAt = result.expiresAt;
          pairExpiry.textContent = "One use · expires in 10 minutes";
        }),
    }),
    h("div", { class: "pair-output" }, pairCode, pairExpiry),
    h(
      "form",
      { class: "pair-form" },
      pairInput,
      h("button", { type: "submit", text: "Pair this browser", "data-testid": "redeem-pair-code" }),
    ),
    h("h4", { class: "devices-head", text: "Connect a device" }),
    h("p", {
      class: "muted",
      text: "A pal device (such as the ESP32 screen) shows a 6-digit code when it pairs. Enter it here.",
    }),
    deviceForm,
    deviceList,
  );
  pairingDetails.addEventListener("toggle", () => {
    if (pairingDetails.open) void task(loadDevices);
  });
  pairingDetails.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    void task(async () => {
      if (pending.length) throw new Error("Let your queued messages finish before pairing.");
      await client.pair(pairInput.value.trim());
      pairInput.value = "";
      pairCode.textContent = "";
      expiresAt = 0;
      report("Paired. Your pal and conversations are here.");
    });
  });
  const expiryTimer = setInterval(() => {
    if (expiresAt && Date.now() >= expiresAt) {
      pairCode.textContent = "";
      pairExpiry.textContent = "Code expired. Generate a new one.";
      expiresAt = 0;
    }
  }, 1000);

  const voiceToggle = h("button", { "data-testid": "voice-toggle" });
  const micBtn = h("button", {
    text: "🎤",
    title: "Speak",
    "aria-label": "Speak a message",
    "data-testid": "mic",
  });
  const syncVoice = () => {
    const { loaded, total } = voice.kokoroProgress;
    voiceToggle.textContent = !voice.enabled
      ? "Voice: off"
      : voice.engine === "kokoro" && voice.kokoroState === "loading"
        ? total > 0
          ? `Voice: loading ${Math.round(loaded)}/${Math.round(total)} MB`
          : "Voice: loading…"
        : "Voice: on";
    voiceToggle.title =
      voice.engine === "kokoro"
        ? voice.kokoroState === "error"
          ? "Natural voice failed to load; using the browser voice"
          : "Natural voice (Kokoro)"
        : "Browser voice";
    voiceToggle.classList.toggle("on", voice.enabled);
    micBtn.hidden = !voice.enabled || !voice.canListen;
  };
  voiceToggle.addEventListener("click", () => {
    voice.setEnabled(!voice.enabled);
    syncVoice();
  });
  micBtn.addEventListener(
    "click",
    () =>
      void task(async () => {
        micBtn.classList.add("on");
        try {
          const heard = await voice.listen();
          if (heard) {
            input.value = heard;
            send();
          }
        } finally {
          micBtn.classList.remove("on");
        }
      }),
  );
  if (!voice.canSpeak && !voice.canKokoro) voiceToggle.hidden = true;
  voice.onKokoroChange = syncVoice;

  // First visit: ask which voice to use. Kokoro sounds natural but is a real download.
  const voiceChoice = h(
    "dialog",
    {
      class: "voice-choice",
      "data-testid": "voice-choice",
      "aria-labelledby": "voice-choice-title",
    },
    h("h3", { id: "voice-choice-title", text: "How should your pal sound?" }),
    h("p", {
      text: `A natural voice runs on this device with Kokoro-82M. It is a one-time download of about ${KOKORO_DOWNLOAD_MB} MB, then works offline. Or keep your browser's built-in voice: no download, but it can sound robotic.`,
    }),
    h(
      "div",
      { class: "voice-choice-actions" },
      voice.canKokoro &&
        h("button", {
          class: "primary",
          value: "kokoro",
          "data-testid": "voice-choice-kokoro",
          text: `Download natural voice (~${KOKORO_DOWNLOAD_MB} MB)`,
        }),
      h("button", {
        value: "browser",
        "data-testid": "voice-choice-browser",
        text: "Keep browser voice",
      }),
    ),
  );
  voiceChoice.addEventListener("click", (e) => {
    const engine = (e.target as HTMLElement).closest("button")?.value as VoiceEngine | undefined;
    if (!engine) return;
    voice.setEngine(engine);
    // Choosing the download is a clear yes to hearing the pal.
    if (engine === "kokoro") voice.setEnabled(true);
    voiceChoice.close();
    syncVoice();
  });
  // Escape dismisses without choosing; ask again next visit.
  voiceChoice.addEventListener("cancel", () => voiceChoice.close());

  client.onState = setStatus;
  client.onPending = (messages) => {
    pending = messages;
    brain.setPending(messages, client.session?.dna.id);
    renderLog();
    renderOutbox();
  };
  client.onError = (text) => {
    if (text !== lastError) {
      lastError = text;
      report(text);
    }
  };
  client.onSnapshot = (state: CompanionState) => {
    if (disposed) return;
    const changed = displayedPalId !== state.dna.id;
    displayedPalId = state.dna.id;
    if (changed || JSON.stringify(dna) !== JSON.stringify(state.dna)) {
      dna = state.dna;
      stage.setDna(dna);
    }
    name.textContent = state.dna.name;
    bio.textContent = state.dna.persona;
    stage.rig.setGrowth(state.growth);
    stage.rig.setRestMood(state.mood);
    stage.rig.setPersonality(state.personality);
    stage.rig.setThinking(thinking);
    setNeeds(state.needs);
    if (activeConversation !== state.conversationId) {
      activeConversation = state.conversationId;
      input.value = client.draft();
      stage.rig.setTyping(document.activeElement === input);
      lines.clear();
      notes.length = 0;
      log.scrollTop = 0;
      if (welcome) {
        notes.push(welcome);
        welcome = "";
      }
    }
    // A pal reply held for its voice (see performTurn) stays hidden until it is spoken.
    for (const line of state.lines)
      if (!heldLines.some((held) => held.id === line.id)) lines.set(line.id, line);
    renderOutbox();
    if (lines.size <= 50) olderBtn.hidden = !state.hasOlder;
    renderLog();
    relationship.textContent = state.relationship.stage;
    if (!thinking) mood.textContent = `Feeling ${state.mood}`;
    traits.replaceChildren(
      h("span", { text: state.personality.humor + " humor" }),
      h("span", { text: state.personality.interests[0] }),
      h("span", { text: state.personality.speech }),
    );
    current = state;
    renderPals(state);
    renderConversations();
    renderChatHead();
    const json = JSON.stringify(state.personality);
    if (json !== profileJson) {
      profileJson = json;
      for (const [key, field] of profileControls) {
        const value = state.personality[key];
        field.value = Array.isArray(value) ? value.join(", ") : value;
      }
    }
    if (changed) {
      memoryGeneration++;
      memoriesList.replaceChildren();
      if (memoryDetails.open) void task(loadMemories);
      abilities.reset();
      brain.reset();
      brain.setPending(pending, state.dna.id);
    }
    input.disabled = false;
    sendBtn.disabled = false;
  };
  // With the natural voice, a reply is held (the pal keeps thinking) until its first
  // audio is ready, then each beat's text appears as its audio starts, so text and
  // sound arrive together instead of the text racing ahead.
  let performing = 0;
  let awaitingVoice = false;
  let heldLines: ChatLine[] = [];
  let heldTimer: ReturnType<typeof setTimeout> | undefined;
  const releaseLines = () => {
    clearTimeout(heldTimer);
    awaitingVoice = false;
    for (const line of heldLines)
      if (line.conversationId === activeConversation) lines.set(line.id, line);
    if (heldLines.length) renderLog();
    heldLines = [];
  };
  const holdLine = (line: ChatLine) => {
    heldLines.push(line);
    awaitingVoice = true;
    clearTimeout(heldTimer);
    // Never hide a reply for long, even if its turn never arrives or audio stalls.
    heldTimer = setTimeout(releaseLines, 20_000);
  };
  const withTimeout = (p: Promise<void>, ms: number) =>
    Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
  const nextFrame = () => new Promise<void>((r) => setTimeout(r, 100));

  const performTurn = async (turn: Turn) => {
    const id = ++performing;
    voice.stopSpeaking();
    const spoken = dna
      ? voice.prepareTurn(turn.beats, voiceDna(dna), (on) => stage.rig.setSpeaking(on))
      : null;
    if (!spoken) {
      performing = 0;
      releaseLines();
      stage.rig.setThinking(false);
      stage.rig.apply(turn, performance.now());
      return;
    }
    stage.rig.setThinking(true);
    for (const [i, beat] of turn.beats.entries()) {
      await withTimeout(spoken[i]!.ready, 20_000);
      if (id !== performing || disposed) return;
      if (i === 0) {
        releaseLines();
        stage.rig.setThinking(false);
      }
      stage.rig.apply(
        { ...turn, beats: [beat], bond: i === turn.beats.length - 1 ? turn.bond : "same" },
        performance.now(),
      );
      await spoken[i]!.play();
      // Let the typewriter finish the beat's text before the next one replaces it.
      const length = Array.from(beat.say).length;
      while (id === performing && !disposed) {
        const st = stage.rig.status(performance.now());
        if (st.beat !== null && st.typed < length) await nextFrame();
        else break;
      }
      if (id !== performing || disposed) return;
    }
    performing = 0;
  };

  client.onMessage = (msg) => {
    if (disposed) return;
    switch (msg.type) {
      case "character": {
        const fresh = dna !== null && dna.id !== msg.dna.id;
        if (fresh && !client.session?.pals.some((p) => p.id === msg.dna.id)) {
          welcome = `Meet ${msg.dna.name}: ${msg.dna.persona}`;
          voice.stop();
        }
        // Same pal with new DNA when it changed itself in conversation.
        if (JSON.stringify(dna) !== JSON.stringify(msg.dna)) {
          dna = msg.dna;
          stage.setDna(dna);
        }
        name.textContent = msg.dna.name;
        break;
      }
      case "chat":
        if (msg.line.conversationId === activeConversation) {
          if (msg.line.who === "pal" && voice.natural) {
            holdLine(msg.line);
            break;
          }
          lines.set(msg.line.id, msg.line);
          renderLog();
        }
        break;
      case "thinking":
        thinking = msg.on;
        if (msg.on || !awaitingVoice) stage.rig.setThinking(msg.on);
        mood.textContent = msg.on
          ? "Thinking of a reply…"
          : `Feeling ${client.session?.mood ?? "happy"}`;
        break;
      case "turn":
        void performTurn(msg.turn);
        setNeeds(msg.needs);
        mood.textContent = `Feeling ${msg.turn.beats.at(-1)?.mood ?? "happy"}`;
        // The pal may have learned a skill or set a routine during the turn.
        abilities.refresh();
        break;
      case "needs":
        setNeeds(msg);
        break;
      case "agenda":
        brain.agendaChanged();
        break;
      case "captured":
        brain.captured(msg.requestId, msg.filed);
        break;
      case "growth":
        stage.rig.setGrowth(msg.stage);
        break;
      case "mood":
        if (awaitingVoice) break;
        stage.rig.setThinking(false);
        stage.rig.apply(
          {
            v: 1,
            beats: [
              { mood: msg.mood, intensity: 2, say: "", action: "none", look: "user", fx: "none" },
            ],
            bond: "same",
          },
          performance.now(),
        );
        break;
      case "error":
        stage.rig.setThinking(false);
        report(msg.message);
        break;
    }
  };
  stage.onTouch = (kind) => {
    client.send({ type: "touch", kind });
    if (voice.enabled && dna) playTouchSound(kind, dna);
    actionNote.textContent =
      kind === "pet"
        ? client.session?.personality.humor === "dry"
          ? "Fine. One more head pat."
          : "A little closer. A little happier."
        : kind === "feed"
          ? "Crunch, crunch. Thank you!"
          : "Hey! I felt that.";
  };
  /** The pal's DNA with its speaking speed adjusted for energy and speech style. */
  const voiceDna = (d: DNA): DNA => {
    const speech = client.session?.personality.speech;
    const speed =
      (client.session?.needs.energy ?? 80) < 25
        ? Math.min(2, d.voice.speed)
        : speech === "quiet"
          ? Math.min(3, d.voice.speed)
          : speech === "animated"
            ? Math.max(7, d.voice.speed)
            : d.voice.speed;
    return { ...d, voice: { ...d.voice, speed } };
  };
  stage.onBeat = (beat) => {
    // Turns spoken with the natural voice are paced by performTurn instead.
    if (dna && !performing) voice.speak(beat, voiceDna(dna), (on) => stage.rig.setSpeaking(on));
  };

  root.replaceChildren(
    nav("/"),
    voiceChoice,
    h(
      "main",
      { class: "pal-page" },
      adoptBar,
      scrim,
      h(
        "div",
        { class: "companion-layout" },
        library,
        h(
          "section",
          { class: "chat-pane", "aria-label": "Conversation" },
          h(
            "header",
            { class: "chat-head" },
            libraryToggle,
            h("div", { class: "chat-head-text" }, chatTitle, chatMeta),
            status,
            h("button", {
              class: "primary",
              text: "New conversation",
              "data-testid": "new-conversation",
              onclick: () => void task(() => client.manage({ action: "new_conversation" })),
            }),
          ),
          h("div", { class: "chat-body" }, olderBtn, emptyLog, log),
          h(
            "footer",
            { class: "chat-foot" },
            outbox,
            notice,
            h("form", { class: "chat" }, micBtn, input, sendBtn),
          ),
        ),
        h(
          "div",
          { class: "pet-pane" },
          h(
            "section",
            { class: "pet-card", "aria-label": "Your pet" },
            h(
              "header",
              { class: "pet-card-head" },
              name,
              h("div", { class: "pet-state" }, mood, relationship),
            ),
            stage.el,
            actionNote,
            h(
              "div",
              { class: "pet-actions" },
              h("button", {
                text: "Feed",
                "data-testid": "feed",
                onclick: () => stage.touch("feed"),
              }),
              h("button", { text: "Pet", "data-testid": "pet", onclick: () => stage.touch("pet") }),
              h("button", { text: "Share", "data-testid": "share", onclick: () => void share() }),
              voiceToggle,
            ),
            h("div", { class: "needs" }, energy.el, fullness.el, bond.el),
          ),
          brain.today,
          h(
            "aside",
            { class: "pal-settings", "aria-label": "About your pal" },
            bio,
            traits,
            memoryDetails,
            brain.notes,
            personalityDetails,
            abilities.el,
            pairingDetails,
          ),
        ),
      ),
    ),
  );
  root.querySelector("form.chat")!.addEventListener("submit", (e) => e.preventDefault());
  syncVoice();
  if (voice.needsChoice) voiceChoice.showModal();
  setStatus("connecting");
  client.start();
  return () => {
    disposed = true;
    clearTimeout(heldTimer);
    clearInterval(expiryTimer);
    voice.dispose();
    client.stop();
    stage.dispose();
  };
}
