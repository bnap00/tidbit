// DNA sharing (M6): a compact, URL-safe code. Enums and digits are bit-packed;
// decoding never throws and always yields a strictly valid DNA (or null).
import {
  ACCESSORIES,
  BODIES,
  BROWS,
  EARS,
  EYES,
  LIMBS,
  MARKINGS,
  MOODS,
  MOUTHS,
  SCHEMES,
  TAILS,
  TIMBRES,
} from "./enums.js";
import { NAME_MAX, PERSONA_MAX } from "./limits.js";
import { idFromSeed, normalizeDna } from "./normalize.js";
import type { DNA } from "./schema.js";

/** v2 added `voice.timbre`; v1 codes still decode and get a timbre from the temperament. */
const VERSION = 2;

/** Field order is the format: only ever append. [enum values, or null for a 0–9 digit]. */
const FIELDS_V1: [string, readonly string[] | null][] = [
  ["look.body", BODIES],
  ["look.eyes", EYES],
  ["look.brows", BROWS],
  ["look.mouth", MOUTHS],
  ["look.ears", EARS],
  ["look.limbs", LIMBS],
  ["look.tail", TAILS],
  ["look.marking", MARKINGS],
  ["look.accessory", ACCESSORIES],
  ["look.scheme", SCHEMES],
  ["baseMood", MOODS],
  ["look.size", null],
  ["look.plump", null],
  ["look.eyeSize", null],
  ["look.eyeGap", null],
  ["temper.energy", null],
  ["temper.playful", null],
  ["temper.shy", null],
  ["temper.grumpy", null],
  ["temper.curious", null],
  ["voice.pitch", null],
  ["voice.speed", null],
];
const FIELDS_V2 = [...FIELDS_V1, ["voice.timbre", TIMBRES] as [string, readonly string[]]];
const FIELDS: Record<number, [string, readonly string[] | null][]> = { 1: FIELDS_V1, 2: FIELDS_V2 };

const bitsFor = (n: number) => Math.max(1, Math.ceil(Math.log2(n)));

class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  flush(): number[] {
    if (this.n) this.bytes.push(this.acc << (8 - this.n));
    this.acc = 0;
    this.n = 0;
    return this.bytes;
  }
}

class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new Error("truncated");
      v = (v * 2) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v >>> 0;
  }
  get byteOffset(): number {
    return Math.ceil(this.pos / 8);
  }
}

function get(dna: DNA, path: string): unknown {
  const [a, b] = path.split(".") as [string, string | undefined];
  const top = (dna as unknown as Record<string, unknown>)[a];
  return b ? (top as Record<string, unknown>)[b] : top;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code: string): Uint8Array {
  const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Encode a DNA. The persona is optional because it dominates the length. */
export function encodeDnaCode(dna: DNA, opts: { persona?: boolean } = {}): string {
  const w = new BitWriter();
  w.write(VERSION, 4);
  w.write(opts.persona && dna.persona ? 1 : 0, 1);
  for (const [path, values] of FIELDS_V2) {
    if (values)
      w.write(Math.max(0, values.indexOf(get(dna, path) as string)), bitsFor(values.length));
    else w.write(Number(get(dna, path)), 4);
  }
  w.write(dna.look.hue, 9);
  w.write(dna.seed >>> 16, 16);
  w.write(dna.seed & 0xffff, 16);
  const enc = new TextEncoder();
  const bytes = w.flush();
  const name = enc.encode(dna.name).slice(0, 255);
  bytes.push(name.length, ...name);
  if (opts.persona && dna.persona) bytes.push(...enc.encode(dna.persona));
  return toBase64Url(Uint8Array.from(bytes));
}

/** Decode a code produced by encodeDnaCode. Returns null for anything invalid; never throws. */
export function decodeDnaCode(code: string): DNA | null {
  try {
    if (typeof code !== "string" || code.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(code))
      return null;
    const bytes = fromBase64Url(code);
    const r = new BitReader(bytes);
    const fields = FIELDS[r.read(4)];
    if (!fields) return null;
    const hasPersona = r.read(1) === 1;
    const raw: Record<string, Record<string, unknown> | unknown> = {
      look: {},
      temper: {},
      voice: {},
    };
    for (const [path, values] of fields) {
      const v = values ? values[r.read(bitsFor(values.length))] : r.read(4);
      if (v === undefined) return null;
      const [a, b] = path.split(".") as [string, string | undefined];
      if (b) (raw[a] as Record<string, unknown>)[b] = v;
      else raw[a] = v;
    }
    (raw.look as Record<string, unknown>).hue = r.read(9);
    const seed = ((r.read(16) << 16) | r.read(16)) >>> 0;
    let off = r.byteOffset;
    const nameLen = bytes[off++];
    if (nameLen === undefined || off + nameLen > bytes.length) return null;
    const dec = new TextDecoder("utf-8", { fatal: false });
    raw.name = dec.decode(bytes.subarray(off, off + nameLen)).slice(0, NAME_MAX * 2);
    off += nameLen;
    if (hasPersona) raw.persona = dec.decode(bytes.subarray(off)).slice(0, PERSONA_MAX * 2);
    else if (off !== bytes.length) return null;
    return normalizeDna(raw, { seed, id: idFromSeed(seed) });
  } catch {
    return null;
  }
}
