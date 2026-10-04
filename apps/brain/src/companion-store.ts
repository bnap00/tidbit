import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  personalityFor,
  type ChatLine,
  type ConversationInfo,
  type DNA,
  type Personality,
} from "@tidbit/protocol";
import type { Store } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface Identity {
  ownerId: string;
  token: string;
}
export interface SavedRequest {
  text: string;
  palId: string;
  conversationId: string;
  result: string | null;
}

/** Owner credentials and the visible conversation log are independent of model context. */
export class CompanionStore {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, active_pal TEXT);
      CREATE TABLE IF NOT EXISTS owner_tokens (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id));
      CREATE TABLE IF NOT EXISTS owner_pals (pal_id TEXT PRIMARY KEY REFERENCES pals(id), owner_id TEXT NOT NULL REFERENCES owners(id));
      CREATE TABLE IF NOT EXISTS pairings (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, pal_id TEXT NOT NULL REFERENCES pals(id), title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT, who TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_history ON chat_lines(conversation_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS chat_request_role ON chat_lines(conversation_id, request_id, who) WHERE request_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS chat_requests (owner_id TEXT NOT NULL, id TEXT NOT NULL, pal_id TEXT NOT NULL, conversation_id TEXT NOT NULL, text TEXT NOT NULL, result TEXT, PRIMARY KEY(owner_id, id));
      CREATE TABLE IF NOT EXISTS personalities (pal_id TEXT PRIMARY KEY REFERENCES pals(id), json TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, fact, tags) VALUES ('delete', old.id, old.fact, old.tags);
        INSERT INTO memories_fts(rowid, fact, tags) VALUES (new.id, new.fact, new.tags);
      END;
    `);
    const columns = store.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "conversation_id"))
      store.db.exec(
        "ALTER TABLE sessions ADD COLUMN conversation_id TEXT REFERENCES conversations(id)",
      );
  }

  owner(token: string): string | undefined {
    return (
      this.store.db
        .prepare("SELECT owner_id AS id FROM owner_tokens WHERE hash = ?")
        .get(hash(token)) as { id: string } | undefined
    )?.id;
  }
  private credential(ownerId: string): Identity {
    const token = randomBytes(32).toString("hex");
    this.store.db
      .prepare("INSERT INTO owner_tokens(hash, owner_id) VALUES (?, ?)")
      .run(hash(token), ownerId);
    return { ownerId, token };
  }
  /** A fresh credential for a device the owner approved; returns its hash for revoking. */
  deviceCredential(ownerId: string): Identity & { hash: string } {
    const identity = this.credential(ownerId);
    return { ...identity, hash: hash(identity.token) };
  }
  revokeCredential(tokenHash: string, ownerId: string): boolean {
    return (
      this.store.db
        .prepare("DELETE FROM owner_tokens WHERE hash = ? AND owner_id = ?")
        .run(tokenHash, ownerId).changes > 0
    );
  }
  createOwner(): Identity {
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const first = !db.prepare("SELECT id FROM owners LIMIT 1").get();
      const ownerId = randomUUID();
      db.prepare("INSERT INTO owners(id) VALUES (?)").run(ownerId);
      // Preserve the installation's existing pal and memories for its first owner.
      if (first) {
        db.prepare(
          "INSERT INTO owner_pals(pal_id, owner_id) SELECT id, ? FROM pals WHERE id NOT IN (SELECT pal_id FROM owner_pals)",
        ).run(ownerId);
        const active = this.store.activePal();
        if (active)
          db.prepare("UPDATE owners SET active_pal = ? WHERE id = ?").run(active.id, ownerId);
      }
      const identity = this.credential(ownerId);
      db.exec("COMMIT");
      return identity;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  owns(ownerId: string, palId: string): boolean {
    return !!this.store.db
      .prepare("SELECT 1 FROM owner_pals WHERE owner_id = ? AND pal_id = ?")
      .get(ownerId, palId);
  }
  activePal(ownerId: string): DNA | undefined {
    const row = this.store.db
      .prepare("SELECT active_pal AS id FROM owners WHERE id = ?")
      .get(ownerId) as { id: string | null } | undefined;
    return row?.id ? this.store.getPal(row.id) : undefined;
  }
  adopt(ownerId: string, dna: DNA): void {
    if (
      this.store.db
        .prepare("SELECT owner_id FROM owner_pals WHERE pal_id = ? AND owner_id != ?")
        .get(dna.id, ownerId)
    )
      throw new Error("This pal belongs to another owner.");
    this.store.db
      .prepare("INSERT OR IGNORE INTO owner_pals(pal_id, owner_id) VALUES (?, ?)")
      .run(dna.id, ownerId);
    this.store.db.prepare("UPDATE owners SET active_pal = ? WHERE id = ?").run(dna.id, ownerId);
  }
  pals(ownerId?: string) {
    const active =
      "COALESCE((SELECT MAX(updated_at) FROM conversations c WHERE c.pal_id = p.id), p.created_at) AS lastActive";
    const rows = ownerId
      ? this.store.db
          .prepare(
            `SELECT p.dna, ${active} FROM pals p JOIN owner_pals o ON o.pal_id = p.id WHERE o.owner_id = ? ORDER BY lastActive DESC`,
          )
          .all(ownerId)
      : this.store.db.prepare(`SELECT p.dna, ${active} FROM pals p ORDER BY lastActive DESC`).all();
    return (rows as { dna: string; lastActive: number }[]).map((row) => {
      const dna = JSON.parse(row.dna) as DNA;
      return { id: dna.id, name: dna.name, persona: dna.persona, dna, lastActive: row.lastActive };
    });
  }
  pair(ownerId: string, now: number) {
    const code = randomBytes(5).toString("hex").toUpperCase();
    this.store.db
      .prepare("DELETE FROM pairings WHERE expires_at < ? OR owner_id = ?")
      .run(now, ownerId);
    const expiresAt = now + 10 * 60_000;
    this.store.db
      .prepare("INSERT INTO pairings VALUES (?, ?, ?)")
      .run(hash(code), ownerId, expiresAt);
    return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt };
  }
  redeem(code: string, now: number): Identity {
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const digest = hash(code.replace(/-/g, "").toUpperCase());
      const row = db
        .prepare("SELECT owner_id AS ownerId FROM pairings WHERE hash = ? AND expires_at > ?")
        .get(digest, now) as { ownerId: string } | undefined;
      if (!row) throw new Error("Pairing code is invalid or expired.");
      db.prepare("DELETE FROM pairings WHERE hash = ?").run(digest);
      const identity = this.credential(row.ownerId);
      db.exec("COMMIT");
      return identity;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  newConversation(palId: string, now: number): string {
    // Reuse an untouched conversation rather than leaving empty ones behind.
    const empty = this.store.db
      .prepare(
        "SELECT id FROM conversations c WHERE pal_id = ? AND NOT EXISTS (SELECT 1 FROM chat_lines l WHERE l.conversation_id = c.id) ORDER BY created_at DESC LIMIT 1",
      )
      .get(palId) as { id: string } | undefined;
    if (empty) {
      this.store.db
        .prepare("UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, empty.id);
      this.store.setMeta(`conversation:${palId}`, empty.id);
      return empty.id;
    }
    const id = randomUUID();
    this.store.db
      .prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)")
      .run(id, palId, "New conversation", now, now);
    this.store.setMeta(`conversation:${palId}`, id);
    return id;
  }
  conversation(palId: string, now: number): string {
    const current = this.store.getMeta(`conversation:${palId}`);
    if (current && this.hasConversation(palId, current)) return current;
    const id = this.newConversation(palId, now);
    const sessions = this.store.db
      .prepare("SELECT id FROM sessions WHERE pal_id = ? AND conversation_id IS NULL ORDER BY id")
      .all(palId) as { id: number }[];
    // Recover visible text from older model logs without exposing tool or context messages.
    for (const session of sessions) {
      this.store.db
        .prepare("UPDATE sessions SET conversation_id = ? WHERE id = ?")
        .run(id, session.id);
      for (const value of this.store.loadMessages(session.id)) {
        const m = value as {
          role?: string;
          content?:
            | string
            | {
                type?: string;
                text?: string;
                name?: string;
                arguments?: { beats?: { say?: string }[] };
              }[];
          timestamp?: number;
        };
        if (m.role === "user") {
          const text =
            typeof m.content === "string"
              ? m.content
              : m.content
                  ?.filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join(" ");
          const clean = text?.replace(/^\[context\][^\n]*\n\n/, "");
          if (clean && !clean.startsWith("(No message from the user."))
            this.line(id, "you", clean, m.timestamp ?? now);
        } else if (m.role === "assistant" && Array.isArray(m.content)) {
          const call = m.content.find((b) => b.type === "toolCall" && b.name === "perform");
          const text = call?.arguments?.beats
            ?.map((b) => b.say ?? "")
            .filter(Boolean)
            .join(" ");
          if (text) this.line(id, "pal", text, m.timestamp ?? now);
        }
      }
    }
    return id;
  }
  hasConversation(palId: string, id: string): boolean {
    return !!this.store.db
      .prepare("SELECT 1 FROM conversations WHERE id = ? AND pal_id = ?")
      .get(id, palId);
  }
  /** Conversations worth browsing: any with messages, plus the current one even if empty. */
  conversations(palId: string, currentId = ""): ConversationInfo[] {
    return this.store.db
      .prepare(
        `SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM chat_lines l WHERE l.conversation_id = c.id) AS messages,
           COALESCE((SELECT substr(text, 1, 90) FROM chat_lines l WHERE l.conversation_id = c.id ORDER BY l.id DESC LIMIT 1), '') AS preview
         FROM conversations c
         WHERE c.pal_id = ? AND (c.id = ? OR EXISTS (SELECT 1 FROM chat_lines l WHERE l.conversation_id = c.id))
         ORDER BY c.updated_at DESC`,
      )
      .all(palId, currentId) as unknown as ConversationInfo[];
  }
  line(
    conversationId: string,
    who: ChatLine["who"],
    text: string,
    now: number,
    requestId: string | null = null,
  ): ChatLine {
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO chat_lines(conversation_id, request_id, who, text, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(conversationId, requestId, who, text, now);
    this.store.db
      .prepare(
        "UPDATE conversations SET updated_at = ?, title = CASE WHEN title = 'New conversation' AND ? = 'you' THEN ? ELSE title END WHERE id = ?",
      )
      .run(now, who, text.slice(0, 60), conversationId);
    const query =
      "SELECT id, conversation_id AS conversationId, request_id AS requestId, who, text, created_at AS createdAt FROM chat_lines";
    return (requestId
      ? this.store.db
          .prepare(query + " WHERE conversation_id = ? AND request_id = ? AND who = ?")
          .get(conversationId, requestId, who)
      : this.store.db
          .prepare(query + " WHERE id = last_insert_rowid()")
          .get()) as unknown as ChatLine;
  }
  history(conversationId: string, before = Number.MAX_SAFE_INTEGER) {
    const rows = this.store.db
      .prepare(
        "SELECT id, conversation_id AS conversationId, request_id AS requestId, who, text, created_at AS createdAt FROM chat_lines WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 51",
      )
      .all(conversationId, before) as unknown as ChatLine[];
    return { lines: rows.slice(0, 50).reverse(), hasOlder: rows.length > 50 };
  }
  request(ownerId: string, id: string): SavedRequest | undefined {
    return this.store.db
      .prepare(
        "SELECT text, pal_id AS palId, conversation_id AS conversationId, result FROM chat_requests WHERE owner_id = ? AND id = ?",
      )
      .get(ownerId, id) as unknown as SavedRequest | undefined;
  }
  startRequest(
    ownerId: string,
    id: string,
    palId: string,
    conversationId: string,
    text: string,
  ): void {
    this.store.db
      .prepare("INSERT OR IGNORE INTO chat_requests VALUES (?, ?, ?, ?, ?, NULL)")
      .run(ownerId, id, palId, conversationId, text);
  }
  finishRequest(ownerId: string, id: string, result: unknown): void {
    this.store.db
      .prepare("UPDATE chat_requests SET result = ? WHERE owner_id = ? AND id = ?")
      .run(JSON.stringify(result), ownerId, id);
  }
  personality(dna: DNA): Personality {
    const row = this.store.db
      .prepare("SELECT json FROM personalities WHERE pal_id = ?")
      .get(dna.id) as { json: string } | undefined;
    if (row) return JSON.parse(row.json) as Personality;
    const profile = personalityFor(dna);
    this.savePersonality(dna.id, profile);
    return profile;
  }
  savePersonality(palId: string, profile: Personality): void {
    this.store.db
      .prepare(
        "INSERT INTO personalities VALUES (?, ?) ON CONFLICT(pal_id) DO UPDATE SET json = excluded.json",
      )
      .run(palId, JSON.stringify(profile));
  }
  updateMemory(palId: string, id: number, fact: string): boolean {
    return (
      this.store.db
        .prepare("UPDATE memories SET fact = ? WHERE pal_id = ? AND id = ?")
        .run(fact, palId, id).changes > 0
    );
  }
}
