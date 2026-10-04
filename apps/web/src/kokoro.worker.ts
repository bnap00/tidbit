// Kokoro-82M text-to-speech, off the main thread so the stage keeps 60 fps.
// Model files are cached after the first download: in the Cache API when the page is a
// secure context, otherwise in IndexedDB (plain-http Tailscale addresses have no Cache API).
import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";

export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export type KokoroRequest =
  { type: "load" } | { type: "say"; id: number; text: string; voice: string; speed: number };

export type KokoroReply =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "audio"; id: number; samples: Float32Array; rate: number }
  | { type: "failed"; id: number };

// Keeps the pre-Tidbit name so the cached model is not downloaded again.
const DB = "a-pal-kokoro";
const STORE = "files";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Just enough of the Cache API (match/put) for transformers.js, backed by IndexedDB. */
const idbCache = {
  async match(key: string): Promise<Response | undefined> {
    const db = await idb();
    const buf = await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
      req.onerror = () => reject(req.error);
    });
    return buf ? new Response(buf) : undefined;
  },
  async put(key: string, response: Response): Promise<void> {
    const buf = await response.arrayBuffer();
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(buf, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

if (!("caches" in self)) {
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = idbCache;
}

const post = (msg: KokoroReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

let tts: Promise<KokoroTTS> | null = null;
// One job at a time: generation is CPU-bound and beats must come out in order.
let queue: Promise<unknown> = Promise.resolve();

function load(): Promise<KokoroTTS> {
  if (tts) return tts;
  const files = new Map<string, { loaded: number; total: number }>();
  tts = KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: "fp16",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status !== "progress") return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0,
        total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      post({ type: "progress", loaded, total });
    },
  })
    // The first generation compiles kernels; do it now so the pal's first line isn't slow.
    .then(async (model) => (await model.generate("Hi.", { voice: "af_heart" }), model));
  tts.then(
    () => post({ type: "ready" }),
    (e: unknown) => {
      tts = null;
      post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    },
  );
  return tts;
}

self.onmessage = (e: MessageEvent<KokoroRequest>) => {
  const msg = e.data;
  if (msg.type === "load") {
    void load().catch(() => {});
    return;
  }
  queue = queue.then(async () => {
    try {
      const model = await load();
      const out = await model.generate(msg.text, {
        voice: msg.voice as never,
        speed: msg.speed,
      });
      post({ type: "audio", id: msg.id, samples: out.audio, rate: out.sampling_rate }, [
        out.audio.buffer,
      ]);
    } catch {
      post({ type: "failed", id: msg.id });
    }
  });
};
