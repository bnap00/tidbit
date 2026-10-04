// Optional voice (PLAN 6): text-to-speech and speech-to-text. Off by default; nothing
// here is required for the pal to work. Two speech engines:
//   - "browser": the Web Speech API. No download, quality depends on the device's voices.
//   - "kokoro":  Kokoro-82M running locally in a Web Worker. Sounds far more natural,
//                but costs a one-time download (KOKORO_DOWNLOAD_MB).
// The user picks one the first time they open the pal page.
import { KOKORO_VOICES, type Beat, type DNA, type Mood, type Timbre } from "@tidbit/protocol";
import { audioContext } from "./audio.js";
import type { KokoroReply, KokoroRequest } from "./kokoro.worker.js";

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => RecognitionLike;

export type VoiceEngine = "browser" | "kokoro";

/** One beat of Kokoro speech: `ready` once its first sentence exists, `play` to hear it. */
export interface SpokenLine {
  ready: Promise<void>;
  play: () => Promise<void>;
}
export type KokoroState = "idle" | "loading" | "ready" | "error";

// Storage keys keep the pre-Tidbit "a-pal" prefix so existing browsers keep their settings.
const KEY = "a-pal:voice";
const ENGINE_KEY = "a-pal:voice-engine";

/**
 * One-time Kokoro download, measured from the published files: the fp16 model
 * (model_fp16.onnx, 163.2 MB) + the ONNX Runtime wasm (21.6 MB) + the worker bundle
 * with its phonemizer (2.2 MB) + one 0.5 MB voice per pal voice used + tokenizer (KBs).
 * fp16 over the 92 MB q8 build: on the wasm backend it generates ~1.6x faster
 * (q8 ran slower than real time), at near-fp32 quality.
 */
export const KOKORO_DOWNLOAD_MB = 188;

/** Per-mood [rate, pitch] offsets at full intensity; scaled down for calmer beats. */
const PROSODY: Record<Mood, readonly [number, number]> = {
  neutral: [0, 0],
  happy: [0.06, 0.06],
  excited: [0.14, 0.12],
  sad: [-0.14, -0.08],
  angry: [0.06, -0.05],
  scared: [0.1, 0.08],
  surprised: [0.05, 0.12],
  sleepy: [-0.2, -0.1],
  curious: [0, 0.05],
  love: [-0.05, 0.04],
  confused: [-0.06, 0.03],
  proud: [-0.02, -0.02],
};

function prosody(beat: Beat): { rate: number; pitch: number } {
  const [rate, pitch] = PROSODY[beat.mood] ?? PROSODY.neutral;
  const k = beat.intensity / 3;
  return { rate: 1 + rate * k, pitch: 1 + pitch * k };
}

/** Emoji and markdown symbols get read out literally by TTS engines; drop them. */
function speakable(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/[*_~`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a beat into sentences so the first one plays while the rest are generated.
 * Very short fragments ("Oh!") join the next sentence to keep the phrasing natural.
 */
function sentences(text: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const part of text.split(/(?<=[.!?…])\s+/)) {
    carry = carry ? `${carry} ${part}` : part;
    if (carry.length >= 12) {
      out.push(carry);
      carry = "";
    }
  }
  if (carry) out.push(carry);
  // The reply waits for its first chunk, so cut a long opening sentence at a comma.
  const first = out[0];
  const comma = first && first.length > 50 ? first.indexOf(", ", 12) : -1;
  if (first && comma > 0 && comma < first.length - 12)
    out.splice(0, 1, first.slice(0, comma + 1), first.slice(comma + 2));
  return out;
}

const BRITISH: ReadonlySet<Timbre> = new Set(["posh", "gent", "storyteller"]);

/** Rank device voices: neural/online voices beat the robotic local ones (e.g. eSpeak). */
function voiceScore(v: SpeechSynthesisVoice): number {
  let s = 0;
  if (/natural|neural|online/i.test(v.name)) s += 3;
  if (/google/i.test(v.name)) s += 2;
  if (!v.localService) s += 1;
  if (/espeak/i.test(v.name)) s -= 5;
  return s;
}

export class Voice {
  enabled = localStorage.getItem(KEY) === "on";
  engine: VoiceEngine | null = (localStorage.getItem(ENGINE_KEY) as VoiceEngine | null) ?? null;
  kokoroState: KokoroState = "idle";
  /** MB downloaded / expected while Kokoro loads (both 0 once cached or before start). */
  kokoroProgress = { loaded: 0, total: 0 };
  onKokoroChange: (() => void) | null = null;

  readonly canSpeak = "speechSynthesis" in window;
  readonly canKokoro =
    typeof Worker !== "undefined" &&
    typeof WebAssembly === "object" &&
    typeof AudioContext !== "undefined";
  private readonly Recognition: RecognitionCtor | undefined =
    (window as unknown as { SpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;
  private rec: RecognitionLike | null = null;

  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, (audio: AudioBuffer | null) => void>();
  private playing: AudioBufferSourceNode | null = null;
  private playChain: Promise<void> = Promise.resolve();
  /** Bumped by stop() so queued Kokoro audio from an old turn is dropped. */
  private generation = 0;

  constructor() {
    if (this.engine === "kokoro" && !this.canKokoro) this.engine = "browser";
    if (this.enabled && this.engine === "kokoro") this.loadKokoro();
  }

  /** The first-run question has not been answered yet. */
  get needsChoice(): boolean {
    return this.engine === null && (this.canSpeak || this.canKokoro);
  }

  /** Speech recognition needs a secure context (https or localhost). */
  get canListen(): boolean {
    return !!this.Recognition && window.isSecureContext;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    localStorage.setItem(KEY, on ? "on" : "off");
    if (on && this.engine === "kokoro") this.loadKokoro();
    if (!on) this.stopSpeaking();
  }

  setEngine(engine: VoiceEngine): void {
    this.engine = engine;
    localStorage.setItem(ENGINE_KEY, engine);
    this.stopSpeaking();
    if (engine === "kokoro") this.loadKokoro();
  }

  /** Speak one beat in the pal's voice; `onSpeaking` drives the mouth flap. */
  speak(beat: Beat, dna: DNA, onSpeaking: (on: boolean) => void): void {
    const text = speakable(beat.say);
    if (!this.enabled || !text) return;
    // Kokoro still downloading or broken: use the browser voice so the pal isn't mute.
    if (this.engine === "kokoro" && this.kokoroState === "ready")
      this.speakKokoro(text, beat, dna, onSpeaking);
    else if (this.canSpeak) this.speakBrowser(text, beat, dna, onSpeaking);
  }

  private speakBrowser(text: string, beat: Beat, dna: DNA, onSpeaking: (on: boolean) => void) {
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const lang = (navigator.language || "en").slice(0, 2);
    const all = voices.filter((v) => v.lang.startsWith(lang));
    // British timbres use a British device voice when there is one.
    const gb =
      lang === "en" && BRITISH.has(dna.voice.timbre) ? all.filter((v) => v.lang === "en-GB") : [];
    const fit = gb.length ? gb : all;
    if (fit.length) {
      const best = Math.max(...fit.map(voiceScore));
      const top = fit.filter((v) => voiceScore(v) === best);
      u.voice = top[dna.seed % top.length]!;
    }
    const p = prosody(beat);
    // DNA voice digits 0–9 → pitch 0.8–1.48, rate 0.75–1.3, then the beat's mood on top.
    u.pitch = Math.min(2, (0.8 + dna.voice.pitch * 0.075) * p.pitch);
    u.rate = (0.75 + dna.voice.speed * 0.061) * p.rate;
    u.onstart = () => onSpeaking(true);
    u.onend = u.onerror = () => onSpeaking(false);
    speechSynthesis.speak(u);
  }

  private speakKokoro(text: string, beat: Beat, dna: DNA, onSpeaking: (on: boolean) => void) {
    const line = this.synthBeat({ ...beat, say: text }, dna, onSpeaking);
    // Generation runs ahead in the worker; playback stays in order.
    if (line) this.playChain = this.playChain.then(line.play);
  }

  /** Kokoro is loaded and on: replies can be spoken with pre-generated audio. */
  get natural(): boolean {
    return this.enabled && this.engine === "kokoro" && this.kokoroState === "ready";
  }

  /**
   * Start generating a whole turn at once, so later beats are ready by the time they
   * play. Returns one line per beat, or null when Kokoro isn't the active voice.
   */
  prepareTurn(
    beats: readonly Beat[],
    dna: DNA,
    onSpeaking: (on: boolean) => void,
  ): SpokenLine[] | null {
    if (!this.natural) return null;
    const lines = beats.map((beat) => this.synthBeat(beat, dna, onSpeaking));
    return lines.every((l) => l) ? (lines as SpokenLine[]) : null;
  }

  private synthBeat(beat: Beat, dna: DNA, onSpeaking: (on: boolean) => void): SpokenLine | null {
    const ctx = audioContext();
    if (!ctx || !this.worker) return null;
    const p = prosody(beat);
    // Kokoro has no pitch control, so shift pitch with the playback rate and generate at
    // a compensating speed; the tempo still ends up at `speed`.
    const shift = (0.93 + dna.voice.pitch * 0.016) * (1 + (p.pitch - 1) * 0.6);
    const speed = (0.85 + dna.voice.speed * 0.04) * p.rate;
    const gen = this.generation;
    const text = speakable(beat.say);
    const parts = (text ? sentences(text) : []).map((part) => {
      const id = this.nextId++;
      const audio = new Promise<AudioBuffer | null>((resolve) => this.waiting.set(id, resolve));
      this.post({
        type: "say",
        id,
        text: part,
        voice: KOKORO_VOICES[dna.voice.timbre],
        speed: speed / shift,
      });
      return audio;
    });
    return {
      ready: (parts[0] ?? Promise.resolve(null)).then(() => {}),
      play: async () => {
        for (const audio of parts) {
          const buf = await audio;
          if (gen !== this.generation) return;
          if (buf) await this.playBuffer(ctx, buf, shift, onSpeaking);
        }
      },
    };
  }

  private playBuffer(
    ctx: AudioContext,
    buf: AudioBuffer,
    rate: number,
    onSpeaking: (on: boolean) => void,
  ): Promise<void> {
    return new Promise<void>((done) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      src.onended = () => {
        if (this.playing === src) this.playing = null;
        onSpeaking(false);
        done();
      };
      this.playing = src;
      onSpeaking(true);
      src.start();
    });
  }

  private loadKokoro(): void {
    if (!this.canKokoro || this.kokoroState === "loading" || this.kokoroState === "ready") return;
    this.worker ??= this.createWorker();
    this.kokoroState = "loading";
    this.onKokoroChange?.();
    this.post({ type: "load" });
  }

  private createWorker(): Worker {
    const w = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<KokoroReply>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        this.kokoroProgress = { loaded: msg.loaded / 1e6, total: msg.total / 1e6 };
        this.onKokoroChange?.();
      } else if (msg.type === "ready" || msg.type === "error") {
        this.kokoroState = msg.type;
        if (msg.type === "error") console.warn("Kokoro voice failed to load:", msg.message);
        this.onKokoroChange?.();
      } else {
        const resolve = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        const ctx = audioContext();
        if (!resolve) return;
        if (msg.type === "failed" || !ctx) return resolve(null);
        const buf = ctx.createBuffer(1, msg.samples.length, msg.rate);
        buf.copyToChannel(msg.samples as Float32Array<ArrayBuffer>, 0);
        resolve(buf);
      }
    };
    return w;
  }

  private post(msg: KokoroRequest): void {
    this.worker?.postMessage(msg);
  }

  /** Listen for one utterance; resolves with the transcript (or "" on silence). */
  listen(): Promise<string> {
    if (!this.canListen) return Promise.resolve("");
    this.rec?.stop();
    const rec = new this.Recognition!();
    this.rec = rec;
    rec.lang = navigator.language || "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    return new Promise((resolve) => {
      let text = "";
      rec.onresult = (e) => {
        text = Array.from(e.results)
          .map((r) => r[0]?.transcript ?? "")
          .join(" ")
          .trim();
      };
      rec.onerror = () => resolve("");
      rec.onend = () => {
        this.rec = null;
        resolve(text);
      };
      rec.start();
    });
  }

  /** Stop whatever is playing and drop queued or prepared audio. */
  stopSpeaking(): void {
    if (this.canSpeak) speechSynthesis.cancel();
    this.generation++;
    this.playing?.stop();
    this.playing = null;
  }

  stop(): void {
    this.rec?.stop();
    this.stopSpeaking();
  }

  /** Page teardown: also frees the Kokoro worker and its model memory. */
  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
  }
}
