// Rig streaming for screens that cannot run the rig themselves (the ESP32 pal). The brain
// keeps a rig per streaming socket, fed by the same messages a browser gets, and sends
// each frame's draw commands as one small binary message. The device only rasterises
// them, so it shows exactly the pal the browser shows.
import type { WebSocket } from "ws";
import { createRig, type Cmd, type Rig } from "@tidbit/rig";
import { RIG_CONSTANTS } from "@tidbit/protocol/rig-data";
import type { CompanionState, DNA, Mood, ServerMessage, TouchKind, Turn } from "@tidbit/protocol";

export const STREAM_FPS_DEFAULT = 24;
export const STREAM_FPS_MAX = 30;
/** Frames are skipped while this much is still queued on the socket (slow Wi-Fi). */
const BACKLOG_BYTES = 16 * 1024;
/** Captions stay up this long after the last beat that spoke. */
const CAPTION_HOLD_MS = 4000;
/** Frames keep coming this long after the screen says it is resting, while the pal dozes off and the screen fades. */
export const REST_DOZE_MS = 4000;

const DOZE: Turn = {
  v: 1,
  beats: [{ mood: "sleepy", intensity: 2, say: "", action: "sleep", look: "down", fx: "zzz" }],
  bond: "same",
};
const WAKE: Turn = {
  v: 1,
  beats: [
    { mood: "surprised", intensity: 1, say: "", action: "none", look: "user", fx: "none" },
    { mood: "happy", intensity: 2, say: "", action: "wave", look: "user", fx: "sparkles" },
  ],
  bond: "same",
};

/**
 * Binary frame layout (little-endian):
 *
 *   u8  0x46 ('F')   u8 version (1)   u16 command count   u32 frame time (ms)
 *   then per command: u8 (op | palette index << 4) followed by int16 params.
 *
 * Coordinates, radii and widths are in 1/16 of a virtual pixel (the rig's 240×240
 * canvas); angles are milliradians. Ops and their params:
 *
 *   0 clear                1 ellipse cx cy rx ry        2 roundRect x y w h r
 *   3 tri x1 y1 x2 y2 x3 y3   4 line x1 y1 x2 y2 width   5 arc cx cy r a0 a1 width
 */
export const FRAME_MAGIC = 0x46;
export const FRAME_VERSION = 1;
const OPS = { clear: 0, ellipse: 1, roundRect: 2, tri: 3, line: 4, arc: 5 } as const;

const q16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 16)));
const qAngle = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 1000)));

export function encodeFrame(cmds: readonly Cmd[], tMs: number): Buffer {
  let size = 8;
  for (const c of cmds) size += 1 + (c.length - 2) * 2;
  const buf = Buffer.alloc(size);
  buf.writeUInt8(FRAME_MAGIC, 0);
  buf.writeUInt8(FRAME_VERSION, 1);
  buf.writeUInt16LE(cmds.length, 2);
  buf.writeUInt32LE(Math.max(0, Math.floor(tMs)) >>> 0, 4);
  let o = 8;
  for (const c of cmds) {
    const pal = c[c.length - 1] as number;
    buf.writeUInt8(OPS[c[0]] | ((pal & 0x0f) << 4), o++);
    for (let i = 1; i < c.length - 1; i++) {
      const v = c[i] as number;
      // Arc angles are the 4th and 5th params.
      const angle = c[0] === "arc" && (i === 4 || i === 5);
      buf.writeInt16LE(angle ? qAngle(v) : q16(v), o);
      o += 2;
    }
  }
  return buf;
}

/** JSON the device gets instead of the browser messages (each well under 1 KB). */
export type StreamMessage =
  | { type: "stream"; name: string; palette: number[][]; fps: number }
  | { type: "caption"; text: string; charMs: number }
  | { type: "thinking"; on: boolean }
  | { type: "error"; code: string; message: string };

export interface RigStreamOptions {
  fps?: number;
  /** Monotonic clock in ms (tests). */
  now?: () => number;
  /** Fetch the owner's state (rest mood, personality, growth, needs). */
  snapshot: () => Promise<CompanionState>;
}

export class RigStream {
  private rig: Rig | null = null;
  private dnaJson = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fps: number;
  private readonly now: () => number;
  private readonly epoch: number;
  private caption = "";
  private captionUntil = 0;
  private sent = 0;
  private skipped = 0;
  /** Rig time the screen went to rest, or null while it is on. */
  private restingSince: number | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: RigStreamOptions,
  ) {
    this.fps = Math.max(1, Math.min(STREAM_FPS_MAX, Math.round(opts.fps ?? STREAM_FPS_DEFAULT)));
    this.now = opts.now ?? (() => performance.now());
    this.epoch = this.now();
  }

  /** Rig time: ms since the stream started, so it fits the frame header. */
  private t(): number {
    return this.now() - this.epoch;
  }

  get stats() {
    return { sent: this.sent, skipped: this.skipped };
  }

  private json(msg: StreamMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setDna(dna: DNA): void {
    const json = JSON.stringify(dna);
    if (json === this.dnaJson) return;
    this.dnaJson = json;
    const growth = this.rig?.growth ?? 2;
    this.rig = createRig(dna);
    this.rig.setGrowth(growth);
    this.json({
      type: "stream",
      name: dna.name,
      palette: this.rig.palette.map((c) => [...c]),
      fps: this.fps,
    });
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000 / this.fps);
  }

  /** Apply the owner's stored state, as a browser does with its snapshot. */
  async refresh(): Promise<void> {
    const state = await this.opts.snapshot();
    this.setDna(state.dna);
    const rig = this.rig!;
    rig.setGrowth(state.growth);
    rig.setRestMood(state.mood);
    rig.setPersonality(state.personality);
    rig.setNeeds(state.needs);
  }

  /** Every message the brain would have sent this socket comes through here. */
  onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "character":
        this.setDna(msg.dna);
        return;
      case "refresh":
        void this.refresh().catch(() => {});
        return;
      case "thinking":
        this.rig?.setThinking(msg.on);
        this.json({ type: "thinking", on: msg.on });
        return;
      case "turn":
        this.rig?.setThinking(false);
        this.rig?.apply(msg.turn, this.t());
        this.rig?.setNeeds(msg.needs);
        return;
      case "needs": {
        const { type: _, ...needs } = msg;
        this.rig?.setNeeds(needs);
        return;
      }
      case "growth":
        this.rig?.setGrowth(msg.stage);
        return;
      case "mood":
        this.mood(msg.mood);
        return;
      case "error":
        this.rig?.setThinking(false);
        this.json({ type: "error", code: msg.code, message: msg.message.slice(0, 200) });
        return;
    }
  }

  /** Early mood while a reply streams in: the face reacts before the words. */
  private mood(mood: Mood): void {
    if (!this.rig) return;
    this.rig.setThinking(false);
    this.rig.apply(
      {
        v: 1,
        beats: [{ mood, intensity: 2, say: "", action: "none", look: "user", fx: "none" }],
        bond: "same",
      },
      this.t(),
    );
  }

  touch(kind: TouchKind): void {
    this.rig?.touch(kind, this.t());
  }

  /**
   * The screen turns off when nobody is around: the pal dozes off, and frames stop once
   * the screen is dark. Waking, it is surprised, then waves, unless it is already busy
   * with a turn (a reminder can wake the screen).
   */
  rest(on: boolean): void {
    const rig = this.rig;
    if (!rig || on === (this.restingSince !== null)) return;
    const t = this.t();
    this.restingSince = on ? t : null;
    if (on) rig.apply(DOZE, t);
    else if (!rig.status(t).beat?.say) rig.apply(WAKE, t);
  }

  /** Where the finger is on the pal, -1…1 from its centre, or null when lifted. */
  attend(x: number | null, y = 0): void {
    this.rig?.setAttention(x, y);
  }

  private updateCaption(t: number): void {
    const rig = this.rig!;
    const s = rig.status(t);
    if (s.beat && s.beat.say) {
      this.captionUntil = t + CAPTION_HOLD_MS;
      if (s.beat.say !== this.caption) {
        this.caption = s.beat.say;
        this.json({ type: "caption", text: this.caption, charMs: RIG_CONSTANTS.typeCharMs });
      }
    } else if (this.caption && (s.beat || t > this.captionUntil)) {
      this.caption = "";
      this.json({ type: "caption", text: "", charMs: 0 });
    }
  }

  tick(): void {
    const rig = this.rig;
    if (!rig || this.ws.readyState !== this.ws.OPEN) return;
    const t = this.t();
    this.updateCaption(t);
    // A dark screen needs no frames; the caption above is what wakes it.
    if (this.restingSince !== null && t - this.restingSince > REST_DOZE_MS) return;
    // Render even when skipping, so springs and activities keep their time.
    const cmds = rig.commands(t);
    if (this.ws.bufferedAmount > BACKLOG_BYTES) {
      this.skipped++;
      return;
    }
    this.ws.send(encodeFrame(cmds, t), { binary: true });
    this.sent++;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
