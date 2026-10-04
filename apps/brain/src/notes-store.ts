// Persistence for the second brain: every capture is kept as a note (raw and tidied,
// full-text searchable), and the things to do it contained become tasks.
import type { NoteInfo, NoteSource, TaskInfo } from "@tidbit/protocol";
import type { Store } from "./store.js";

type NoteRow = {
  id: number;
  text: string;
  raw: string;
  filed: string;
  source: NoteSource;
  recordedAt: number;
  createdAt: number;
  markers: string;
};
type TaskRow = {
  id: number;
  text: string;
  dueAt: number | null;
  allDay: number;
  doneAt: number | null;
  createdAt: number;
  noteId: number | null;
};

const noteColumns = (t = "") =>
  `${t}id, ${t}clean AS text, ${t}raw, ${t}filed, ${t}source, ${t}recorded_at AS recordedAt, ${t}created_at AS createdAt, ${t}markers`;
const NOTE_COLUMNS = noteColumns();
const TASK_COLUMNS =
  "id, text, due_at AS dueAt, all_day AS allDay, done_at AS doneAt, created_at AS createdAt, note_id AS noteId";

const toNote = (r: NoteRow): NoteInfo => ({
  ...r,
  filed: r.filed ? (JSON.parse(r.filed) as string[]) : [],
  markers: r.markers ? (JSON.parse(r.markers) as number[]) : [],
});
const toTask = (r: TaskRow): TaskInfo => ({ ...r, allDay: !!r.allDay });

/** Quote every token so user text can never inject FTS5 syntax. */
export function ftsQuery(text: string): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (!words.length) return undefined;
  return [...new Set(words)]
    .slice(0, 16)
    .map((w) => `"${w}"`)
    .join(" OR ");
}

export class NotesStore {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pal_id TEXT NOT NULL REFERENCES pals(id),
        owner_id TEXT NOT NULL,
        request_id TEXT,
        raw TEXT NOT NULL,
        clean TEXT NOT NULL,
        filed TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        markers TEXT NOT NULL DEFAULT '',
        recorded_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notes_request ON notes(owner_id, request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS notes_recent ON notes(pal_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        clean, raw, content='notes', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, clean, raw) VALUES (new.id, new.clean, new.raw);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, clean, raw) VALUES ('delete', old.id, old.clean, old.raw);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF clean, raw ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, clean, raw) VALUES ('delete', old.id, old.clean, old.raw);
        INSERT INTO notes_fts(rowid, clean, raw) VALUES (new.id, new.clean, new.raw);
      END;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pal_id TEXT NOT NULL REFERENCES pals(id),
        text TEXT NOT NULL,
        due_at INTEGER,
        all_day INTEGER NOT NULL DEFAULT 0,
        done_at INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_open ON tasks(pal_id, due_at) WHERE done_at IS NULL AND deleted = 0;
    `);
  }

  // --- notes ------------------------------------------------------------------------

  addNote(
    palId: string,
    ownerId: string,
    note: {
      raw: string;
      clean: string;
      source: NoteSource;
      recordedAt: number;
      markers?: number[];
      requestId?: string;
    },
    now: number,
  ): number {
    const res = this.store.db
      .prepare(
        "INSERT INTO notes (pal_id, owner_id, request_id, raw, clean, source, markers, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        palId,
        ownerId,
        note.requestId ?? null,
        note.raw,
        note.clean,
        note.source,
        note.markers?.length ? JSON.stringify(note.markers) : "",
        note.recordedAt,
        now,
      );
    return Number(res.lastInsertRowid);
  }

  /** A capture already stored under this request ID (an outbox retry). */
  noteByRequest(ownerId: string, requestId: string): (NoteInfo & { palId: string }) | undefined {
    const row = this.store.db
      .prepare(
        `SELECT ${NOTE_COLUMNS}, pal_id AS palId FROM notes WHERE owner_id = ? AND request_id = ?`,
      )
      .get(ownerId, requestId) as (NoteRow & { palId: string }) | undefined;
    return row && { ...toNote(row), palId: row.palId };
  }

  fileNote(id: number, clean: string, filed: string[]): void {
    this.store.db
      .prepare("UPDATE notes SET clean = ?, filed = ? WHERE id = ?")
      .run(clean, JSON.stringify(filed), id);
  }

  note(palId: string, id: number): NoteInfo | undefined {
    const row = this.store.db
      .prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE pal_id = ? AND id = ?`)
      .get(palId, id) as NoteRow | undefined;
    return row && toNote(row);
  }

  recentNotes(palId: string, limit = 50, before = Number.MAX_SAFE_INTEGER): NoteInfo[] {
    return (
      this.store.db
        .prepare(
          `SELECT ${NOTE_COLUMNS} FROM notes WHERE pal_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        )
        .all(palId, before, limit) as NoteRow[]
    ).map(toNote);
  }

  /** Full-text search over the tidied and raw text; best matches first. */
  searchNotes(palId: string, query: string, limit = 5): NoteInfo[] {
    const match = ftsQuery(query);
    if (!match) return [];
    return (
      this.store.db
        .prepare(
          `SELECT ${noteColumns("n.")} FROM notes_fts f
           JOIN notes n ON n.id = f.rowid
           WHERE notes_fts MATCH ? AND n.pal_id = ?
           ORDER BY bm25(notes_fts) LIMIT ?`,
        )
        .all(match, palId, limit) as NoteRow[]
    ).map(toNote);
  }

  deleteNote(palId: string, id: number): boolean {
    return (
      this.store.db.prepare("DELETE FROM notes WHERE pal_id = ? AND id = ?").run(palId, id)
        .changes > 0
    );
  }

  // --- tasks ------------------------------------------------------------------------

  addTask(
    palId: string,
    task: { text: string; dueAt?: number; allDay?: boolean; noteId?: number },
    now: number,
  ): number {
    const res = this.store.db
      .prepare(
        "INSERT INTO tasks (pal_id, text, due_at, all_day, note_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(palId, task.text, task.dueAt ?? null, task.allDay ? 1 : 0, task.noteId ?? null, now);
    return Number(res.lastInsertRowid);
  }

  task(palId: string, id: number): TaskInfo | undefined {
    const row = this.store.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE pal_id = ? AND id = ? AND deleted = 0`)
      .get(palId, id) as TaskRow | undefined;
    return row && toTask(row);
  }

  /** Open tasks, unsorted; the agenda orders them. */
  openTasks(palId: string): TaskInfo[] {
    return (
      this.store.db
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM tasks WHERE pal_id = ? AND done_at IS NULL AND deleted = 0 LIMIT 500`,
        )
        .all(palId) as TaskRow[]
    ).map(toTask);
  }

  doneSince(palId: string, since: number): TaskInfo[] {
    return (
      this.store.db
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM tasks WHERE pal_id = ? AND deleted = 0 AND done_at >= ? ORDER BY done_at DESC LIMIT 20`,
        )
        .all(palId, since) as TaskRow[]
    ).map(toTask);
  }

  setTaskDone(palId: string, id: number, done: boolean, now: number): boolean {
    return (
      this.store.db
        .prepare("UPDATE tasks SET done_at = ? WHERE pal_id = ? AND id = ? AND deleted = 0")
        .run(done ? now : null, palId, id).changes > 0
    );
  }

  updateTask(
    palId: string,
    id: number,
    patch: { text: string; dueAt: number | null; allDay: boolean },
  ): boolean {
    return (
      this.store.db
        .prepare(
          "UPDATE tasks SET text = ?, due_at = ?, all_day = ? WHERE pal_id = ? AND id = ? AND deleted = 0",
        )
        .run(patch.text, patch.dueAt, patch.allDay ? 1 : 0, palId, id).changes > 0
    );
  }

  deleteTask(palId: string, id: number): boolean {
    return (
      this.store.db
        .prepare("UPDATE tasks SET deleted = 1 WHERE pal_id = ? AND id = ? AND deleted = 0")
        .run(palId, id).changes > 0
    );
  }
}
