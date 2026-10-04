import type { DrawTarget, Pal, RGB } from "../types.js";

/** The subset of CanvasRenderingContext2D this target uses; keeps the rig free of DOM types. */
export interface Ctx2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  beginPath(): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  roundRect?(x: number, y: number, w: number, h: number, r: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/** Draws into a 2D canvas context, scaling the 240×240 virtual canvas to `size` pixels. */
export class Canvas2DTarget implements DrawTarget {
  private colors: string[] = [];
  constructor(
    private ctx: Ctx2D,
    private size = 240,
  ) {}

  setPalette(palette: readonly RGB[]): void {
    this.colors = palette.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }
  private col(c: Pal): string {
    return this.colors[c] ?? "#f0f";
  }
  private begin(): void {
    const k = this.size / 240;
    this.ctx.setTransform(k, 0, 0, k, 0, 0);
    this.ctx.beginPath();
  }
  clear(c: Pal): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = this.col(c);
    this.ctx.fillRect(0, 0, this.size, this.size);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Pal): void {
    this.begin();
    this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    this.ctx.fillStyle = this.col(c);
    this.ctx.fill();
  }
  roundRect(x: number, y: number, w: number, h: number, r: number, c: Pal): void {
    this.begin();
    r = Math.min(r, w / 2, h / 2);
    const ctx = this.ctx;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = this.col(c);
    ctx.fill();
  }
  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: Pal): void {
    this.begin();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.lineTo(x3, y3);
    this.ctx.closePath();
    this.ctx.fillStyle = this.col(c);
    this.ctx.fill();
  }
  line(x1: number, y1: number, x2: number, y2: number, width: number, c: Pal): void {
    this.begin();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.lineWidth = width;
    this.ctx.lineCap = "round";
    this.ctx.strokeStyle = this.col(c);
    this.ctx.stroke();
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, width: number, c: Pal): void {
    this.begin();
    // Browsers reduce angles modulo 2π; a sweep a hair under 2π can vanish, so draw full circles explicitly.
    if (a1 - a0 >= Math.PI * 2 - 1e-6) this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    else this.ctx.arc(cx, cy, r, a0, a1);
    this.ctx.lineWidth = width;
    this.ctx.lineCap = "round";
    this.ctx.strokeStyle = this.col(c);
    this.ctx.stroke();
  }
}
