import {
  parseServerMessage,
  parseClientMessage,
  type BriefScope,
  type ChatLine,
  type ClientMessage,
  type CompanionState,
  type ServerMessage,
} from "@tidbit/protocol";

export type ConnState = "connecting" | "open" | "closed";
interface PendingSay {
  type: "say";
  requestId: string;
  text: string;
  palId: string;
  conversationId: string;
}
/** A quick note waiting to be filed. It belongs to a pal, not to a conversation. */
export interface PendingCapture {
  type: "capture";
  requestId: string;
  text: string;
  palId: string;
  recordedAt: number;
  file: boolean;
}
export type Pending = PendingSay | PendingCapture;
const get = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const put = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private storage may be unavailable; the live connection still works. */
  }
};
const identifier = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Durable client outbox plus a bearer identity that can be paired across origins. */
export class BrainClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  // "apal." keys predate the Tidbit name; renaming them would orphan existing owners.
  private ownerToken = get("apal.owner") ?? "";
  private pending: Pending[] = [];
  private submitted = new Set<string>();
  private readonly clientId = get("apal.device") ?? identifier();
  session: CompanionState | null = null;
  state: ConnState = "connecting";
  onMessage: (msg: ServerMessage) => void = () => {};
  onState: (s: ConnState) => void = () => {};
  onSnapshot: (state: CompanionState) => void = () => {};
  onPending: (messages: readonly Pending[]) => void = () => {};
  onError: (text: string) => void = () => {};

  constructor(private readonly url: string) {
    put("apal.device", this.clientId);
    this.loadOutbox();
  }
  private get outboxKey() {
    return `apal.outbox:${this.ownerToken.slice(-16)}`;
  }
  private loadOutbox() {
    try {
      const raw: unknown = JSON.parse(get(this.outboxKey) ?? "[]");
      this.pending = Array.isArray(raw)
        ? raw
            .filter((value): value is Pending => {
              const parsed = parseClientMessage(JSON.stringify(value));
              if (!parsed.ok) return false;
              const m = parsed.msg;
              if (m.type === "capture") return !!m.palId && m.recordedAt !== undefined;
              return m.type === "say" && !!m.requestId && !!m.palId && !!m.conversationId;
            })
            .slice(0, 20)
        : [];
    } catch {
      this.pending = [];
    }
  }
  private persist() {
    put(this.outboxKey, JSON.stringify(this.pending));
    this.onPending(this.pending);
  }
  start(): this {
    this.stopped = false;
    const generation = ++this.generation;
    try {
      const cached = JSON.parse(
        get(`apal.state:${this.ownerToken.slice(-16)}`) ?? "null",
      ) as CompanionState | null;
      if (cached && this.ownerToken) this.acceptState(cached);
    } catch {
      /* Ignore an incomplete cached snapshot. */
    }
    this.onPending(this.pending);
    void this.bootstrap(generation);
    return this;
  }
  private setState(state: ConnState) {
    this.state = state;
    this.onState(state);
  }
  private acceptState(state: CompanionState) {
    if (this.session && this.session.revision > state.revision) return;
    this.session = state;
    put(`apal.state:${this.ownerToken.slice(-16)}`, JSON.stringify(state));
    this.onSnapshot(state);
  }
  async api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(this.ownerToken ? { Authorization: `Bearer ${this.ownerToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: T & { error?: string };
    try {
      data = (await response.json()) as T & { error?: string };
    } catch {
      throw new Error("Your pal is offline. Messages will wait for reconnect.");
    }
    if (!response.ok) throw new Error(data.error ?? "Could not reach your pal.");
    return data;
  }
  private async bootstrap(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    this.setState("connecting");
    try {
      const result = await this.api<{ identity?: { token: string }; state: CompanionState }>(
        "bootstrap",
        {},
      );
      if (this.stopped || generation !== this.generation) return;
      if (result.identity) {
        this.ownerToken = result.identity.token;
        put("apal.owner", this.ownerToken);
        this.loadOutbox();
        this.persist();
      }
      this.acceptState(result.state);
      this.connect(generation);
    } catch (e) {
      if (this.stopped || generation !== this.generation) return;
      this.setState("closed");
      this.onError((e as Error).message);
      this.schedule(() => void this.bootstrap(generation));
    }
  }
  private schedule(callback: () => void) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      callback,
      Math.min(8000, 500 * 2 ** this.retry++) + Math.random() * 200,
    );
  }
  private connect(generation: number) {
    if (this.stopped || generation !== this.generation) return;
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.submitted.clear();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.send({
        type: "hello",
        clientId: this.clientId,
        ownerToken: this.ownerToken,
        caps: { w: 240, h: 240, colors: 65536, input: ["text", "touch"] },
      });
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || this.stopped) return;
      const parsed = parseServerMessage(String(event.data));
      if (!parsed.ok) return;
      const msg = parsed.msg;
      if (msg.type === "character" && this.state !== "open") {
        this.retry = 0;
        this.setState("open");
        this.flush();
      }
      if (msg.type === "ack" && msg.status !== "accepted") {
        const found = this.pending.find((p) => p.requestId === msg.requestId);
        this.pending = this.pending.filter((p) => p.requestId !== msg.requestId);
        this.submitted.delete(msg.requestId);
        this.persist();
        if (msg.status === "rejected" && found)
          this.onError(
            found.type === "capture"
              ? `Not filed: “${found.text.slice(0, 80)}”. You can try again.`
              : `Not sent: “${found.text}”. You can try again.`,
          );
      }
      if (msg.type === "refresh" || msg.type === "turn") void this.refresh();
      this.onMessage(msg);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.submitted.clear();
      if (this.stopped) return;
      this.setState("closed");
      if (event.code === 4003) {
        this.onError("This device needs to be paired again.");
        return;
      }
      this.schedule(() => void this.bootstrap(generation));
    };
  }
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const generation = this.generation;
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          const state = await this.api<CompanionState>("state");
          if (generation !== this.generation || this.stopped) return;
          this.acceptState(state);
          this.flush();
        } catch (e) {
          if (!this.stopped) this.onError((e as Error).message);
        }
      } while (this.refreshAgain && !this.stopped && generation === this.generation);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
      if (this.refreshAgain && !this.stopped) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }
  async manage(body: Record<string, unknown>): Promise<void> {
    if (!this.session) throw new Error("Reconnect to your pal first.");
    if (
      this.pending.some((p) => p.type === "say") &&
      !["switch_pal", "resume"].includes(String(body.action))
    )
      throw new Error(
        "Wait for your queued messages to finish before changing conversations or settings.",
      );
    const state = await this.api<CompanionState>("manage", { palId: this.session.dna.id, ...body });
    if (!this.stopped) {
      this.acceptState(state);
      this.flush();
    }
  }
  async pair(code: string): Promise<void> {
    const result = await this.api<{ identity: { token: string }; state: CompanionState }>(
      "pair/redeem",
      { code },
    );
    this.stop();
    this.ownerToken = result.identity.token;
    put("apal.owner", this.ownerToken);
    this.loadOutbox();
    this.session = null;
    this.acceptState(result.state);
    this.start();
  }
  draft(): string {
    return this.session
      ? (get(`apal.draft:${this.ownerToken.slice(-16)}:${this.session.conversationId}`) ?? "")
      : "";
  }
  saveDraft(text: string): void {
    if (this.session)
      put(
        `apal.draft:${this.ownerToken.slice(-16)}:${this.session.conversationId}`,
        text.slice(0, 1000),
      );
  }
  say(text: string): boolean {
    if (!this.session) return false;
    if (this.pending.length >= 20) {
      this.onError("Your queue is full. Reconnect before sending more.");
      return false;
    }
    this.pending.push({
      type: "say",
      requestId: identifier(),
      text,
      palId: this.session.dna.id,
      conversationId: this.session.conversationId,
    });
    this.persist();
    this.flush();
    return true;
  }
  /**
   * Capture a thought to be filed (a task, an appointment, a memory or a note). Queued
   * durably like messages, so notes taken offline are filed when the pal is back.
   */
  capture(text: string, file = true): boolean {
    if (!this.session) return false;
    if (this.pending.length >= 20) {
      this.onError("Your queue is full. Reconnect before adding more.");
      return false;
    }
    this.pending.push({
      type: "capture",
      requestId: identifier(),
      text,
      palId: this.session.dna.id,
      recordedAt: Date.now(),
      file,
    });
    this.persist();
    this.flush();
    return true;
  }
  /** Ask for a spoken briefing of today or the week; it arrives as a turn in the chat. */
  brief(scope: BriefScope): boolean {
    return this.send({ type: "brief", scope });
  }
  private flush() {
    if (this.state !== "open") return;
    for (const msg of this.pending) {
      if (
        this.submitted.has(msg.requestId) ||
        msg.palId !== this.session?.dna.id ||
        (msg.type === "say" && msg.conversationId !== this.session.conversationId)
      )
        continue;
      if (this.send(msg)) this.submitted.add(msg.requestId);
    }
  }
  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
  async older(before: number) {
    if (!this.session) return { lines: [] as ChatLine[], hasOlder: false };
    return this.api<{ lines: ChatLine[]; hasOlder: boolean }>(
      `history?conversation=${encodeURIComponent(this.session.conversationId)}&before=${before}`,
    );
  }
  stop() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
export function defaultBrainUrl(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}
