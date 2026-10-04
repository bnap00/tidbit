// The second brain in the browser: a "Today" card (capture box, tasks, what's coming up,
// briefings) and a searchable Notes list. Captures file themselves on the brain; this
// only shows the result. Everything is rendered with textContent.
import {
  CAPTURE_WIRE_MAX,
  TASK_TEXT_MAX,
  isOverdue,
  type AgendaInfo,
  type NoteInfo,
  type TaskInfo,
} from "@tidbit/protocol";
import type { BrainClient, Pending, PendingCapture } from "./brain-client.js";
import { h } from "./dom.js";

const DAY = 86_400_000;

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "today", "tomorrow 17:00", "Fri 3 Oct". */
export function whenLabel(at: number, allDay: boolean, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  const day =
    days === 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : days === -1
          ? "yesterday"
          : new Date(at).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
            });
  return allDay
    ? day
    : `${day} ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

const FILED_LABEL: Record<string, string> = {
  task: "task",
  appointment: "appointment",
  memory: "memory",
};

export interface SecondBrainPanel {
  today: HTMLElement;
  notes: HTMLDetailsElement;
  /** The agenda changed on the brain. */
  agendaChanged(): void;
  /** A capture was filed: show what it became. */
  captured(requestId: string, filed: string): void;
  /** The outbox changed: show captures still waiting to be filed. */
  setPending(list: readonly Pending[], palId: string | undefined): void;
  /** The active pal changed, or the first snapshot arrived. */
  reset(): void;
  /** Capture from elsewhere (chat commands). */
  capture(text: string, file?: boolean): boolean;
}

export function secondBrainPanel(
  client: BrainClient,
  task: (operation: () => Promise<unknown>) => Promise<void>,
  report: (text: string) => void,
): SecondBrainPanel {
  let generation = 0;
  let loading: Promise<void> | null = null;
  let again = false;
  let waiting: PendingCapture[] = [];
  const mine = new Set<string>();

  // --- capture ------------------------------------------------------------------------
  const captureText = h("textarea", {
    rows: 2,
    maxlength: CAPTURE_WIRE_MAX,
    placeholder: "What's on your mind? A task, a plan, an idea…",
    "aria-label": "Capture a thought",
    "data-testid": "capture-input",
  });
  const keepOnly = h("input", { type: "checkbox", "data-testid": "capture-keep" });
  const captureResult = h("p", {
    class: "capture-result",
    role: "status",
    "data-testid": "capture-result",
    hidden: true,
  });
  const queued = h("ul", { class: "capture-queue", "data-testid": "capture-queue", hidden: true });
  const submitCapture = () => {
    const text = captureText.value.trim();
    if (!text) return;
    if (!capture(text, !keepOnly.checked)) return;
    captureText.value = "";
    keepOnly.checked = false;
  };
  const captureForm = h(
    "form",
    { class: "capture" },
    captureText,
    h(
      "div",
      { class: "capture-row" },
      h(
        "label",
        { class: "capture-keep", title: "Save it as a note without filing tasks or dates" },
        keepOnly,
        "Just keep it",
      ),
      h("button", {
        class: "primary",
        type: "submit",
        text: "File it",
        "data-testid": "capture-submit",
      }),
    ),
    captureResult,
    queued,
  );
  captureForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitCapture();
  });
  captureText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitCapture();
    }
  });
  function capture(text: string, file = true): boolean {
    const before = new Set(pendingCaptures().map((p) => p.requestId));
    // The outbox reports synchronously, so the new request is pending once this returns.
    if (!client.capture(text.slice(0, CAPTURE_WIRE_MAX), file)) return false;
    // Remember which request is ours, so its result shows here.
    for (const p of pendingCaptures()) if (!before.has(p.requestId)) mine.add(p.requestId);
    captureResult.hidden = false;
    captureResult.textContent =
      client.state === "open" ? "Filing…" : "Saved here. It will be filed when your pal is back.";
    return true;
  }
  let latestPending: readonly Pending[] = [];
  const pendingCaptures = () =>
    latestPending.filter((p): p is PendingCapture => p.type === "capture");

  // --- briefings ------------------------------------------------------------------------
  const briefRow = h(
    "div",
    { class: "brief-row" },
    h("button", {
      text: "Brief me: today",
      "data-testid": "brief-day",
      onclick: () => {
        if (!client.brief("day")) report("Reconnect for a briefing.");
      },
    }),
    h("button", {
      text: "This week",
      "data-testid": "brief-week",
      onclick: () => {
        if (!client.brief("week")) report("Reconnect for a briefing.");
      },
    }),
  );

  // --- tasks and what's coming up --------------------------------------------------------
  const dateLabel = h("span", { class: "today-date" });
  const overdueBadge = h("span", { class: "overdue-badge", hidden: true });
  const taskList = h("ul", { class: "task-list", "data-testid": "task-list" });
  const doneLine = h("p", { class: "done-line", hidden: true });
  const eventList = h("ul", { class: "event-list", "data-testid": "event-list" });
  const eventsHead = h("h4", { text: "Coming up" });
  const newTask = h("input", {
    type: "text",
    maxlength: TASK_TEXT_MAX,
    placeholder: "Add a task",
    "aria-label": "New task",
    "data-testid": "task-input",
  });
  const newDue = h("input", {
    type: "date",
    "aria-label": "Due date (optional)",
    "data-testid": "task-due",
  });
  const addTaskForm = h(
    "form",
    { class: "task-add" },
    newTask,
    newDue,
    h("button", { type: "submit", text: "Add", "data-testid": "task-add" }),
  );
  addTaskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = newTask.value.trim();
    if (!text) return;
    void task(async () => {
      await client.manage({
        action: "add_task",
        text,
        ...(newDue.value ? { due: newDue.value } : {}),
      });
      newTask.value = "";
      newDue.value = "";
      await load();
    });
  });

  const taskRow = (t: TaskInfo, now: number) => {
    const late = isOverdue(t, now);
    const check = h("input", {
      type: "checkbox",
      "aria-label": `Done: ${t.text}`,
      "data-testid": `task-done-${t.id}`,
    });
    check.addEventListener(
      "change",
      () =>
        void task(async () => {
          await client.manage({ action: "complete_task", itemId: t.id, enabled: check.checked });
          await load();
        }),
    );
    return h(
      "li",
      { class: late ? "task overdue" : "task", "data-id": t.id },
      h("label", { class: "task-main" }, check, h("span", { class: "task-text", text: t.text })),
      t.dueAt !== null
        ? h("span", {
            class: "task-due",
            text: late
              ? `overdue · ${whenLabel(t.dueAt, t.allDay, now)}`
              : whenLabel(t.dueAt, t.allDay, now),
          })
        : null,
      h("button", {
        class: "task-delete",
        text: "×",
        title: "Delete task",
        "aria-label": `Delete ${t.text}`,
        onclick: () =>
          void task(async () => {
            await client.manage({ action: "delete_task", itemId: t.id });
            await load();
          }),
      }),
    );
  };

  function render(agenda: AgendaInfo) {
    const now = Date.now();
    dateLabel.textContent = new Date(now).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    overdueBadge.hidden = !agenda.overdue;
    overdueBadge.textContent = `${agenda.overdue} overdue`;
    taskList.replaceChildren(...agenda.tasks.slice(0, 50).map((t) => taskRow(t, now)));
    if (!agenda.tasks.length)
      taskList.append(
        h("li", {
          class: "muted empty",
          text: "Nothing to do. Capture a thought and it will land here if it's a task.",
        }),
      );
    const doneToday = agenda.done.filter((t) => (t.doneAt ?? 0) >= startOfDay(now));
    doneLine.hidden = !doneToday.length;
    doneLine.textContent = `✓ ${doneToday.length} done today: ${doneToday
      .map((t) => t.text)
      .slice(0, 3)
      .join(", ")}`;
    eventsHead.hidden = !agenda.events.length;
    eventList.replaceChildren(
      ...agenda.events
        .slice(0, 8)
        .map((e) =>
          h(
            "li",
            {},
            h("time", { text: whenLabel(e.at, false, now) }),
            h("span", { text: e.repeat === "none" ? e.text : `${e.text} (${e.repeat})` }),
          ),
        ),
    );
  }

  async function load(): Promise<void> {
    if (!client.session) return;
    if (loading) {
      again = true;
      return loading;
    }
    loading = (async () => {
      do {
        again = false;
        const g = generation;
        const agenda = await client.api<AgendaInfo>("agenda");
        if (g === generation) render(agenda);
      } while (again);
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }

  const today = h(
    "section",
    { class: "today-card", "aria-label": "Today", "data-testid": "today" },
    h("header", { class: "today-head" }, h("h3", { text: "Today" }), dateLabel, overdueBadge),
    captureForm,
    briefRow,
    h("h4", { text: "Tasks" }),
    taskList,
    doneLine,
    addTaskForm,
    eventsHead,
    eventList,
  );

  // --- notes --------------------------------------------------------------------------------
  const noteSearch = h("input", {
    type: "search",
    placeholder: "Search your notes",
    "aria-label": "Search notes",
    "data-testid": "note-search",
  });
  const noteList = h("div", { class: "note-list", "data-testid": "note-list" });
  let oldestNote = 0;
  const earlierNotes = h("button", {
    text: "Load earlier notes",
    hidden: true,
    onclick: () => void task(() => loadNotes(oldestNote)),
  });
  const notes = h(
    "details",
    { class: "companion-details", "data-testid": "notes" },
    h("summary", {}, "Notes", h("span", { text: "Everything you captured, searchable" })),
    h("p", {
      class: "muted",
      text: "Each capture is kept in your words, tidied, with what it became. Ask your pal about any of it.",
    }),
    noteSearch,
    noteList,
    earlierNotes,
  );
  const noteItem = (n: NoteInfo) =>
    h(
      "article",
      { class: "note-item", "data-id": n.id },
      h(
        "header",
        {},
        h("time", { text: whenLabel(n.recordedAt, false) }),
        n.source === "device" ? h("span", { class: "note-chip", text: "device" }) : null,
        ...n.filed.map((f) =>
          h("span", {
            class: "note-chip filed",
            text: f.replace(/^(\w+)/, (k) => FILED_LABEL[k] ?? k),
          }),
        ),
      ),
      h("p", { class: "note-text", text: n.text }),
      n.raw !== n.text
        ? h(
            "details",
            { class: "note-raw" },
            h("summary", { text: "As captured" }),
            h("p", { text: n.raw }),
          )
        : null,
      n.markers.length
        ? h("p", {
            class: "muted",
            text: `Markers at ${n.markers.map((m) => `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, "0")}`).join(", ")}`,
          })
        : null,
      h("button", {
        text: "Delete",
        onclick: () =>
          void task(async () => {
            await client.manage({ action: "delete_note", itemId: n.id });
            await loadNotes();
          }),
      }),
    );
  async function loadNotes(before?: number) {
    if (!client.session) return;
    const g = generation;
    const q = noteSearch.value.trim();
    const list = await client.api<NoteInfo[]>(
      q ? `notes?q=${encodeURIComponent(q)}` : before ? `notes?before=${before}` : "notes",
    );
    if (g !== generation) return;
    const items = list.map(noteItem);
    if (before) noteList.append(...items);
    else noteList.replaceChildren(...items);
    oldestNote = list.at(-1)?.id ?? 0;
    earlierNotes.hidden = !!q || list.length < 50;
    if (!list.length && !before)
      noteList.append(
        h("p", {
          class: "muted",
          text: q ? "No notes match." : "No notes yet. Capture something in Today.",
        }),
      );
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  noteSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void task(() => loadNotes()), 200);
  });
  notes.addEventListener("toggle", () => {
    if (notes.open) void task(() => loadNotes());
  });

  return {
    today,
    notes,
    agendaChanged: () => void task(load),
    captured(requestId, filed) {
      if (mine.delete(requestId)) {
        captureResult.hidden = false;
        captureResult.textContent = filed;
      }
      if (notes.open) void task(() => loadNotes());
    },
    setPending(list, palId) {
      latestPending = list;
      waiting = pendingCaptures().filter((p) => p.palId === palId);
      queued.hidden = !waiting.length;
      queued.replaceChildren(
        ...waiting.map((p) =>
          h(
            "li",
            {},
            h("span", { text: p.text }),
            h("small", { text: client.state === "open" ? "Filing…" : "Waiting to be filed" }),
          ),
        ),
      );
    },
    reset() {
      generation++;
      noteList.replaceChildren();
      captureResult.hidden = true;
      if (notes.open) void task(() => loadNotes());
      void task(load);
    },
    capture,
  };
}
