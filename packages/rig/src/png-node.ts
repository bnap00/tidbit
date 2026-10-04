// Minimal PNG encoder for snapshots (Node only).
import { deflateSync, inflateSync } from "node:zlib";
import type { RGB } from "./types.js";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode an indexed buffer as a palette PNG (colour type 3). */
export function encodeIndexedPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  palette: readonly RGB[],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // palette
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(([r, g, b], i) => plte.set([r, g, b], i * 3));
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Encode an RGB buffer (3 bytes per pixel) as a truecolour PNG. */
export function encodeRgbPng(rgb: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A grid of indexed frames, each with its own palette, as one RGB image. */
export class ContactSheet {
  readonly rgb: Uint8Array;
  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cell: number,
  ) {
    this.rgb = new Uint8Array(cols * cell * rows * cell * 3);
  }
  put(
    i: number,
    pixels: Uint8Array,
    palette: readonly RGB[],
    mask?: (x: number, y: number) => boolean,
  ): void {
    const cx = (i % this.cols) * this.cell;
    const cy = Math.floor(i / this.cols) * this.cell;
    const W = this.cols * this.cell;
    for (let y = 0; y < this.cell; y++) {
      for (let x = 0; x < this.cell; x++) {
        const o = ((cy + y) * W + cx + x) * 3;
        if (mask && !mask(x, y)) {
          this.rgb.set([20, 20, 24], o);
          continue;
        }
        const c = palette[pixels[y * this.cell + x]!] ?? [255, 0, 255];
        this.rgb.set(c, o);
      }
    }
  }
  png(): Buffer {
    return encodeRgbPng(this.rgb, this.cols * this.cell, this.rows * this.cell);
  }
}

/** Decode a palette PNG written by encodeIndexedPng (filter type 0 only). */
export function decodeIndexedPng(buf: Buffer): {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: RGB[];
} {
  let off = 8;
  let width = 0;
  let height = 0;
  const palette: RGB[] = [];
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 3) throw new Error("not an 8-bit palette PNG");
    } else if (type === "PLTE") {
      for (let i = 0; i < data.length; i += 3) palette.push([data[i]!, data[i + 1]!, data[i + 2]!]);
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width + 1)] !== 0) throw new Error("unsupported PNG filter");
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, pixels, palette };
}
