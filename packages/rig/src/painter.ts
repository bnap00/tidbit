// Local pal space → virtual canvas. Parts draw in local coordinates whose
// origin is the pal's ground point (feet), y up is negative.
import { RIG_CONSTANTS } from "@tidbit/protocol/rig-data";
import { MAX_DRAW_CALLS, OUTLINE, PAL_X, SAFE_X, SAFE_Y, type Cmd, type Pal } from "./types.js";

const TAU = Math.PI * 2;
export const GROUND_Y: number = RIG_CONSTANTS.groundY;
/** Outline thickness in local units. */
export const OW: number = RIG_CONSTANTS.outline;
/** Smallest horizontal scale during a fake spin, so the body never has zero area. */
const MIN_FLIP = 0.12;

/** Part ids for tagging commands (tests and debugging only). */
export const PART = {
  none: 0,
  body: 1,
  eyes: 2,
  mouth: 3,
  brows: 4,
  ears: 5,
  limbs: 6,
  tail: 7,
  marking: 8,
  accessory: 9,
  blush: 10,
  fx: 11,
  /** Idle-activity props (paper plane, bicycle, ...). */
  prop: 12,
} as const;

export class Painter {
  cmds: Cmd[] = [];
  /** Part id of each command, parallel to `cmds`. */
  tags: number[] = [];
  /** Part id applied to subsequent commands. */
  part: number = PART.none;
  /** Commands refused because the frame budget was exhausted or values were not finite. */
  dropped = 0;
  budget = MAX_DRAW_CALLS;

  private cos = 1;
  private sin = 0;
  private flip = 1;
  private aflip = 1;
  private lift = 0;
  private s = 1;
  private shiftX = 0;

  /** Set the frame transform. `tiltDeg` rotates anchors about the ground point. */
  setTransform(scale: number, tiltDeg: number, flip: number, lift: number, shiftX = 0): void {
    const a = (tiltDeg * Math.PI) / 180;
    this.cos = Math.cos(a);
    this.sin = Math.sin(a);
    this.flip = flip;
    this.aflip = Math.max(MIN_FLIP, Math.abs(flip));
    this.lift = lift;
    this.s = scale;
    this.shiftX = shiftX;
  }

  reset(): void {
    this.cmds = [];
    this.tags = [];
    this.part = PART.none;
    this.dropped = 0;
  }

  X(x: number, y: number): number {
    const rx = x * this.cos - y * this.sin;
    const f = this.flip >= 0 ? this.aflip : -this.aflip;
    return PAL_X + this.s * (f * rx + this.shiftX);
  }
  Y(x: number, y: number): number {
    const ry = x * this.sin + y * this.cos;
    return GROUND_Y + this.s * (ry + this.lift);
  }

  private push(cmd: Cmd): void {
    for (let i = 1; i < cmd.length; i++) {
      if (!Number.isFinite(cmd[i] as number)) {
        this.dropped++;
        return;
      }
    }
    if (this.cmds.length >= this.budget) {
      this.dropped++;
      return;
    }
    this.cmds.push(cmd);
    this.tags.push(this.part);
  }

  /** Raw canvas-space command (used for the background and effects). */
  raw(cmd: Cmd): void {
    this.push(cmd);
  }

  ellipse(x: number, y: number, rx: number, ry: number, c: Pal): void {
    if (rx <= 0 || ry <= 0) return;
    this.push(["ellipse", this.X(x, y), this.Y(x, y), rx * this.s * this.aflip, ry * this.s, c]);
  }

  /** Axis-aligned rounded rectangle given by centre and half extents. */
  rrect(x: number, y: number, hw: number, hh: number, r: number, c: Pal): void {
    if (hw <= 0 || hh <= 0) return;
    const cx = this.X(x, y);
    const cy = this.Y(x, y);
    const w = hw * this.s * this.aflip;
    const h = hh * this.s;
    const rr = Math.max(0, Math.min(r * this.s, w, h));
    this.push(["roundRect", cx - w, cy - h, w * 2, h * 2, rr, c]);
  }

  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: Pal): void {
    this.push([
      "tri",
      this.X(x1, y1),
      this.Y(x1, y1),
      this.X(x2, y2),
      this.Y(x2, y2),
      this.X(x3, y3),
      this.Y(x3, y3),
      c,
    ]);
  }

  line(x1: number, y1: number, x2: number, y2: number, w: number, c: Pal): void {
    if (w <= 0) return;
    this.push([
      "line",
      this.X(x1, y1),
      this.Y(x1, y1),
      this.X(x2, y2),
      this.Y(x2, y2),
      w * this.s,
      c,
    ]);
  }

  /** Stroked arc; angles in radians, clockwise from +x, a1 > a0. */
  arc(x: number, y: number, r: number, a0: number, a1: number, w: number, c: Pal): void {
    if (r <= 0 || w <= 0) return;
    const rot = Math.atan2(this.sin, this.cos);
    // Carry the sweep separately so rounding can never shrink a full circle below 2π.
    const sweep = Math.min(TAU, a1 - a0);
    let b0 = this.flip < 0 ? Math.PI - (a1 + rot) : a0 + rot;
    // Keep a0 in [0, 2π) so the numbers are stable.
    b0 -= Math.floor(b0 / TAU) * TAU;
    this.push([
      "arc",
      this.X(x, y),
      this.Y(x, y),
      r * this.s * this.aflip,
      b0,
      b0 + sweep,
      w * this.s,
      c,
    ]);
  }

  // --- outlined helpers (PLAN 4.2: outline = same shape painted larger first) --

  ellipseO(x: number, y: number, rx: number, ry: number, c: Pal, ow = OW): void {
    this.ellipse(x, y, rx + ow, ry + ow, OUTLINE);
    this.ellipse(x, y, rx, ry, c);
  }

  rrectO(x: number, y: number, hw: number, hh: number, r: number, c: Pal, ow = OW): void {
    this.rrect(x, y, hw + ow, hh + ow, r + ow, OUTLINE);
    this.rrect(x, y, hw, hh, r, c);
  }

  /** Triangle outline: vertices pushed away from the centroid. */
  triOutline(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    ow = OW,
  ): void {
    const cx = (x1 + x2 + x3) / 3;
    const cy = (y1 + y2 + y3) / 3;
    const g = (x: number, y: number): [number, number] => {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      return [x + (dx / d) * ow * 1.9, y + (dy / d) * ow * 1.9];
    };
    const [a, b] = g(x1, y1);
    const [c, d] = g(x2, y2);
    const [e, f] = g(x3, y3);
    this.tri(a, b, c, d, e, f, OUTLINE);
  }

  triO(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    c: Pal,
    ow = OW,
  ): void {
    this.triOutline(x1, y1, x2, y2, x3, y3, ow);
    this.tri(x1, y1, x2, y2, x3, y3, c);
  }

  lineO(x1: number, y1: number, x2: number, y2: number, w: number, c: Pal, ow = OW): void {
    this.line(x1, y1, x2, y2, w + ow * 2, OUTLINE);
    this.line(x1, y1, x2, y2, w, c);
  }
}

// ---------------------------------------------------------------------------
// Geometry sampling: used by the static fit, the per-frame safety net, and tests.
// ---------------------------------------------------------------------------

/** Points on the outer boundary of a command (canvas space). `n` controls density. */
export function cmdPoints(cmd: Cmd, n = 12): [number, number][] {
  const out: [number, number][] = [];
  switch (cmd[0]) {
    case "clear":
      break;
    case "ellipse": {
      const [, cx, cy, rx, ry] = cmd;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
      break;
    }
    case "roundRect": {
      const [, x, y, w, h, r0] = cmd;
      const r = Math.max(0, Math.min(r0, w / 2, h / 2));
      const corners: [number, number, number][] = [
        [x + w - r, y + h - r, 0],
        [x + r, y + h - r, Math.PI / 2],
        [x + r, y + r, Math.PI],
        [x + w - r, y + r, (3 * Math.PI) / 2],
      ];
      const m = Math.max(2, Math.ceil(n / 4));
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= m; i++) {
          const a = a0 + (i / m) * (Math.PI / 2);
          out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
      }
      break;
    }
    case "tri":
      out.push([cmd[1], cmd[2]], [cmd[3], cmd[4]], [cmd[5], cmd[6]]);
      break;
    case "line": {
      const [, x1, y1, x2, y2, w] = cmd;
      const hw = w / 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        out.push(
          [x1 + hw * Math.cos(a), y1 + hw * Math.sin(a)],
          [x2 + hw * Math.cos(a), y2 + hw * Math.sin(a)],
        );
      }
      break;
    }
    case "arc": {
      const [, cx, cy, r, a0, a1, w] = cmd;
      const hw = w / 2;
      const sweep = Math.min(TAU, Math.max(0, a1 - a0));
      for (let i = 0; i <= n; i++) {
        const a = a0 + (i / n) * sweep;
        out.push([cx + (r + hw) * Math.cos(a), cy + (r + hw) * Math.sin(a)]);
      }
      for (const a of [a0, a0 + sweep]) {
        const ex = cx + r * Math.cos(a);
        const ey = cy + r * Math.sin(a);
        for (let i = 0; i < 8; i++) {
          const b = (i / 8) * TAU;
          out.push([ex + hw * Math.cos(b), ey + hw * Math.sin(b)]);
        }
      }
      break;
    }
  }
  return out;
}

const SAMPLES = 24;
const COS = Array.from({ length: SAMPLES }, (_, i) => Math.cos((i / SAMPLES) * TAU));
const SIN = Array.from({ length: SAMPLES }, (_, i) => Math.sin((i / SAMPLES) * TAU));
/** Worst-case underestimate of sampling an ellipse of radius ≤ 120 at 24 points is < 1 px. */
export const SAFE_SAMPLING_MARGIN = 1;

/**
 * Farthest reach of one command from (px, py), allocation-free. Matches the
 * outer boundary sampled by cmdPoints() closely enough for the runtime checks.
 */
export function cmdMaxDist(c: Cmd, px: number, py: number, samples = SAMPLES): number {
  const d = (x: number, y: number) => Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
  switch (c[0]) {
    case "clear":
      return 0;
    case "ellipse": {
      let m = 0;
      if (samples === SAMPLES) {
        for (let i = 0; i < SAMPLES; i++)
          m = Math.max(m, d(c[1] + c[3] * COS[i]!, c[2] + c[4] * SIN[i]!));
      } else {
        for (let i = 0; i < samples; i++) {
          const a = (i / samples) * TAU;
          m = Math.max(m, d(c[1] + c[3] * Math.cos(a), c[2] + c[4] * Math.sin(a)));
        }
      }
      return m;
    }
    case "roundRect": {
      const r = Math.max(0, Math.min(c[5], c[3] / 2, c[4] / 2));
      const x0 = c[1] + r;
      const y0 = c[2] + r;
      const x1 = c[1] + c[3] - r;
      const y1 = c[2] + c[4] - r;
      return Math.max(d(x0, y0), d(x1, y0), d(x0, y1), d(x1, y1)) + r;
    }
    case "tri":
      return Math.max(d(c[1], c[2]), d(c[3], c[4]), d(c[5], c[6]));
    case "line":
      return Math.max(d(c[1], c[2]), d(c[3], c[4])) + c[5] / 2;
    case "arc": {
      const sweep = Math.min(TAU, Math.max(0, c[5] - c[4]));
      let m = 0;
      for (let i = 0; i <= samples; i++) {
        const a = c[4] + (i / samples) * sweep;
        m = Math.max(m, d(c[1] + c[3] * Math.cos(a), c[2] + c[3] * Math.sin(a)));
      }
      return m + c[6] / 2;
    }
  }
}

/** Largest distance from the safe-circle centre over commands [from, to). */
export function maxSafeDistance(cmds: readonly Cmd[], from = 0, to = cmds.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, cmdMaxDist(cmds[i]!, SAFE_X, SAFE_Y));
  return m;
}

/** Uniformly scale commands about the safe-circle centre (the per-frame safety net). */
export function scaleAboutSafeCentre(cmds: Cmd[], k: number): void {
  const X = (x: number) => SAFE_X + (x - SAFE_X) * k;
  const Y = (y: number) => SAFE_Y + (y - SAFE_Y) * k;
  for (const c of cmds) {
    switch (c[0]) {
      case "clear":
        break;
      case "ellipse":
        c[1] = X(c[1]);
        c[2] = Y(c[2]);
        c[3] *= k;
        c[4] *= k;
        break;
      case "roundRect":
        c[1] = X(c[1]);
        c[2] = Y(c[2]);
        c[3] *= k;
        c[4] *= k;
        c[5] *= k;
        break;
      case "tri":
        c[1] = X(c[1]);
        c[2] = Y(c[2]);
        c[3] = X(c[3]);
        c[4] = Y(c[4]);
        c[5] = X(c[5]);
        c[6] = Y(c[6]);
        break;
      case "line":
        c[1] = X(c[1]);
        c[2] = Y(c[2]);
        c[3] = X(c[3]);
        c[4] = Y(c[4]);
        c[5] *= k;
        break;
      case "arc":
        c[1] = X(c[1]);
        c[2] = Y(c[2]);
        c[3] *= k;
        c[6] *= k;
        break;
    }
  }
}
