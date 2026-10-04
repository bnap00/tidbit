/** Palette index 0–7 (PLAN 4.2). */
export type Pal = number;

export const BG = 0;
export const OUTLINE = 1;
export const BODY = 2;
export const SHADE = 3;
export const ACCENT = 4;
export const EYE_WHITE = 5;
export const DARK = 6;
export const FX = 7;

/** The only thing a platform must implement. Angles are radians, clockwise from +x (screen space). */
export interface DrawTarget {
  clear(c: Pal): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Pal): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, c: Pal): void;
  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: Pal): void;
  line(x1: number, y1: number, x2: number, y2: number, width: number, c: Pal): void;
  arc(cx: number, cy: number, r: number, a0: number, a1: number, width: number, c: Pal): void;
}

/** A recorded draw call. The palette index is always the last element. */
export type Cmd =
  | ["clear", Pal]
  | ["ellipse", number, number, number, number, Pal]
  | ["roundRect", number, number, number, number, number, Pal]
  | ["tri", number, number, number, number, number, number, Pal]
  | ["line", number, number, number, number, number, Pal]
  | ["arc", number, number, number, number, number, number, Pal];

export function replay(cmds: readonly Cmd[], target: DrawTarget): void {
  for (const c of cmds) {
    switch (c[0]) {
      case "clear":
        target.clear(c[1]);
        break;
      case "ellipse":
        target.ellipse(c[1], c[2], c[3], c[4], c[5]);
        break;
      case "roundRect":
        target.roundRect(c[1], c[2], c[3], c[4], c[5], c[6]);
        break;
      case "tri":
        target.tri(c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
        break;
      case "line":
        target.line(c[1], c[2], c[3], c[4], c[5], c[6]);
        break;
      case "arc":
        target.arc(c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
        break;
    }
  }
}

export type RGB = readonly [number, number, number];

/** Virtual canvas (PLAN 4.1). */
export const CANVAS = 240;
export const PAL_X = 120;
export const PAL_Y = 132;
export const SAFE_X = 120;
export const SAFE_Y = 120;
export const SAFE_R = 108;
export const MAX_DRAW_CALLS = 96;
export const MAX_PARTICLES = 12;
