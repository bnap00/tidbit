import type { DrawTarget, Pal } from "../types.js";

const TAU = Math.PI * 2;

/**
 * Software rasteriser into an 8-bit indexed buffer (no anti-aliasing). Used by
 * the device simulator and for PNG snapshots in Node. Pixel (px, py) samples
 * the virtual canvas at its centre.
 */
export class IndexedBufferTarget implements DrawTarget {
  readonly pixels: Uint8Array;
  private readonly k: number;

  constructor(
    readonly width = 240,
    readonly height = 240,
  ) {
    this.pixels = new Uint8Array(width * height);
    this.k = width / 240;
  }

  private span(py: number, x0: number, x1: number, c: Pal): void {
    // x0/x1 are virtual coordinates; fill pixels whose centres lie inside.
    const k = this.k;
    const a = Math.max(0, Math.ceil(x0 * k - 0.5));
    const b = Math.min(this.width - 1, Math.floor(x1 * k - 0.5));
    const row = py * this.width;
    for (let px = a; px <= b; px++) this.pixels[row + px] = c;
  }

  /** Iterate pixel rows whose centres fall in [y0, y1] (virtual). */
  private rows(y0: number, y1: number, fn: (py: number, vy: number) => void): void {
    const k = this.k;
    const a = Math.max(0, Math.ceil(y0 * k - 0.5));
    const b = Math.min(this.height - 1, Math.floor(y1 * k - 0.5));
    for (let py = a; py <= b; py++) fn(py, (py + 0.5) / k);
  }

  /** Iterate pixels whose centres lie in the virtual box. */
  private box(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    fn: (i: number, vx: number, vy: number) => void,
  ): void {
    const k = this.k;
    const ax = Math.max(0, Math.ceil(x0 * k - 0.5));
    const bx = Math.min(this.width - 1, Math.floor(x1 * k - 0.5));
    this.rows(y0, y1, (py, vy) => {
      const row = py * this.width;
      for (let px = ax; px <= bx; px++) fn(row + px, (px + 0.5) / k, vy);
    });
  }

  clear(c: Pal): void {
    this.pixels.fill(c);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: Pal): void {
    if (!(rx > 0 && ry > 0)) return;
    this.rows(cy - ry, cy + ry, (py, vy) => {
      const t = (vy - cy) / ry;
      const hw = rx * Math.sqrt(Math.max(0, 1 - t * t));
      this.span(py, cx - hw, cx + hw, c);
    });
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, c: Pal): void {
    if (!(w > 0 && h > 0)) return;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    this.rows(y, y + h, (py, vy) => {
      let inset = 0;
      const dy = vy < y + r ? y + r - vy : vy > y + h - r ? vy - (y + h - r) : 0;
      if (dy > 0) inset = r - Math.sqrt(Math.max(0, r * r - dy * dy));
      this.span(py, x + inset, x + w - inset, c);
    });
  }

  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: Pal): void {
    const area = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
    if (area === 0) return;
    const s = area > 0 ? 1 : -1;
    this.box(
      Math.min(x1, x2, x3),
      Math.min(y1, y2, y3),
      Math.max(x1, x2, x3),
      Math.max(y1, y2, y3),
      (i, x, y) => {
        const e1 = ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) * s;
        const e2 = ((x3 - x2) * (y - y2) - (y3 - y2) * (x - x2)) * s;
        const e3 = ((x1 - x3) * (y - y3) - (y1 - y3) * (x - x3)) * s;
        if (e1 >= 0 && e2 >= 0 && e3 >= 0) this.pixels[i] = c;
      },
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, width: number, c: Pal): void {
    const hw = width / 2;
    if (!(hw > 0)) return;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const hw2 = hw * hw;
    this.box(
      Math.min(x1, x2) - hw,
      Math.min(y1, y2) - hw,
      Math.max(x1, x2) + hw,
      Math.max(y1, y2) + hw,
      (i, x, y) => {
        let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = x1 + t * dx - x;
        const ey = y1 + t * dy - y;
        if (ex * ex + ey * ey <= hw2) this.pixels[i] = c;
      },
    );
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, width: number, c: Pal): void {
    const hw = width / 2;
    if (!(hw > 0) || !(r > 0)) return;
    let sweep = a1 - a0;
    if (sweep < 0) sweep = 0;
    if (sweep > TAU) sweep = TAU;
    const ex0 = cx + r * Math.cos(a0);
    const ey0 = cy + r * Math.sin(a0);
    const ex1 = cx + r * Math.cos(a0 + sweep);
    const ey1 = cy + r * Math.sin(a0 + sweep);
    const hw2 = hw * hw;
    const R = r + hw;
    this.box(cx - R, cy - R, cx + R, cy + R, (i, x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(d - r) <= hw) {
        let a = Math.atan2(dy, dx) - a0;
        a = ((a % TAU) + TAU) % TAU;
        if (a <= sweep) {
          this.pixels[i] = c;
          return;
        }
      }
      // Round caps.
      const c0 = (x - ex0) ** 2 + (y - ey0) ** 2;
      const c1 = (x - ex1) ** 2 + (y - ey1) ** 2;
      if (c0 <= hw2 || c1 <= hw2) this.pixels[i] = c;
    });
  }
}
