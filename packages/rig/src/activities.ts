// Idle activities: things the pal does on its own between conversations
// (throwing a paper plane, riding a bike, ...). Each one is a pose track plus a
// prop script, both pure functions of elapsed time, so two browsers showing
// the same pal at the same moment agree. The brain never picks these: they are
// rig-internal and gated by the rig on the pal being idle (PLAN 4.4 layer 2.5).
import { hash2, type Temper } from "@tidbit/protocol";
import { type Track } from "./animate.js";
import { OW, type Painter } from "./painter.js";
import { shoulder, type FaceLayout, type PalStatic } from "./pal.js";
import {
  ARM_L,
  ARM_R,
  BODY_SQUASH,
  BODY_Y,
  BROW_RAISE,
  EAR_ANGLE,
  EYE_OPEN,
  EYE_SQUINT,
  FLIP_X,
  GAZE_X,
  GAZE_Y,
  MOUTH_CURVE,
  MOUTH_OPEN,
  BODY_TILT,
  type Pose,
} from "./pose.js";
import { ACCENT, DARK, EYE_WHITE, FX, OUTLINE, SHADE } from "./types.js";

const PI = Math.PI;
const TAU = PI * 2;

export const ACTIVITIES = [
  "stretch",
  "paperPlane",
  "bicycle",
  "ball",
  "bubble",
  "book",
  "juggle",
  "chaseTail",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** Activities are scheduled in fixed slots; at most one per slot. */
export const SLOT_MS = 26_000;
/** Earliest start inside a slot: the pal settles first. */
const LEAD_MS = 6000;
/** Longest activity; every activity ends inside its slot. */
const MAX_MS = 6400;
/** A slot whose start passed while the pal was busy is skipped after this long. */
export const GRACE_MS = 400;
/** An interrupted activity fades its pose out over this long. */
export const CUT_MS = 300;

/** Where a prop script draws. Coordinates are local pal units (ground origin, y up negative). */
export interface PropScene {
  p: Painter;
  st: PalStatic;
  f: FaceLayout;
  pose: Pose;
  elapsed: number;
  /** Size factor (`st.k`). */
  k: number;
  /** Subsequent primitives follow the pal's tilt, lift and flip (held props). */
  body(): void;
  /** Subsequent primitives sit on the ground: no tilt or lift, but they follow the flip and shift. */
  ground(): void;
}

export interface ActivityDef {
  ms: number;
  tracks: readonly Track[];
  /** Procedural pose additions (weight already applied by the caller via `w`). */
  pose?(elapsed: number, out: Pose, f: FaceLayout, k: number, w: number): void;
  /** Horizontal shift of the pal in local units. */
  shift?(elapsed: number): number;
  /** Props drawn behind the pal. */
  back?(s: PropScene): void;
  /** Props drawn in front of the pal. */
  front?(s: PropScene): void;
  /** Selection weight for this pal; 0 means never. */
  weight(temper: Temper, st: PalStatic): number;
}

function tr(channel: number, ...keys: (readonly [number, number])[]): Track {
  return { channel, keys };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function ease(u: number): number {
  const t = clamp(u, 0, 1);
  return t * t * (3 - 2 * t);
}

/** 0 → 1 over [a, b], then 1 → 0 over [c, d]. */
function popIn(t: number, a: number, b: number, c: number, d: number): number {
  return ease((t - a) / (b - a)) * (1 - ease((t - c) / (d - c)));
}

const hasArms = (st: PalStatic) => st.limbs === 1 || st.limbs === 2;

/** Hand position in local units for the pal's right (viewer's right) limb at `lift`. */
function hand(st: PalStatic, f: FaceLayout, lift: number): [number, number] {
  const [sx, sy] = shoulder(st, f, 1);
  const k = st.k;
  if (st.limbs === 2) {
    const a = (55 - lift * 125) * (PI / 180);
    return [sx + Math.cos(a) * 16 * k, sy + Math.sin(a) * 16 * k];
  }
  if (st.limbs === 1) return [sx + 4 * k, sy - lift * 10 * k];
  return [f.bx * 0.85, -f.by * 0.9 - lift * 12 * k];
}

// ---------------------------------------------------------------------------
// Stretch: a big two-armed stretch, a yawn, then a little shake.
// ---------------------------------------------------------------------------

const stretch: ActivityDef = {
  ms: 3400,
  tracks: [
    tr(ARM_L, [0, 0], [600, 1], [2200, 1], [2800, 0]),
    tr(ARM_R, [0, 0], [600, 1], [2200, 1], [2800, 0]),
    tr(BODY_SQUASH, [0, 0], [600, -0.16], [2200, -0.16], [2700, 0.08], [3100, 0]),
    tr(EYE_OPEN, [0, 0], [500, -1], [2300, -1], [2800, 0.15], [3200, 0]),
    tr(MOUTH_OPEN, [0, 0], [700, 0.55], [2100, 0.55], [2600, 0]),
    tr(EAR_ANGLE, [0, 0], [700, 0.6], [2300, 0.6], [2900, 0]),
    tr(
      BODY_TILT,
      [0, 0],
      [800, -4],
      [2200, -4],
      [2800, 0],
      [2900, 3],
      [3000, -3],
      [3100, 2],
      [3200, -1],
      [3300, 0],
    ),
  ],
  weight: () => 1.2,
};

// ---------------------------------------------------------------------------
// Paper plane: wind up, throw, and watch it loop around and glide away.
// ---------------------------------------------------------------------------

const THROW = 1450;
const FLIGHT_MS = 3750;
/** Flight path relative to the hand, in local units; the plane loops up and glides off left. */
const FLIGHT: readonly (readonly [number, number])[] = [
  [0, 0],
  [26, -22],
  [38, -48],
  [22, -66],
  [-6, -58],
  [-40, -36],
  [-72, -12],
  [-96, 6],
];

function flightPoint(u: number): [number, number, number] {
  const n = FLIGHT.length - 1;
  const s = clamp(u, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(s));
  const v = 0.5 - 0.5 * Math.cos(PI * (s - i));
  const [x0, y0] = FLIGHT[i]!;
  const [x1, y1] = FLIGHT[i + 1]!;
  // Heading from the segment direction, blended across the corner.
  const dx = x1 - x0;
  const dy = y1 - y0;
  return [x0 + dx * v, y0 + dy * v, Math.atan2(dy, dx)];
}

function drawPlane(p: Painter, x: number, y: number, a: number, s: number): void {
  if (s <= 0.05) return;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const R = (px: number, py: number): [number, number] => [
    x + (px * c - py * sn) * s,
    y + (px * sn + py * c) * s,
  ];
  const [nx, ny] = R(9, 0);
  const [t1x, t1y] = R(-7, -4.5);
  const [t2x, t2y] = R(-6, 3.5);
  p.triO(nx, ny, t1x, t1y, t2x, t2y, EYE_WHITE, OW * 0.8);
  const [bx, by] = R(-5, 1.5);
  p.tri(nx, ny, bx, by, t2x, t2y, SHADE);
}

const paperPlane: ActivityDef = {
  ms: 5600,
  tracks: [
    tr(ARM_R, [0, 0], [900, 1], [1300, 1], [THROW, 0.25], [1900, 0.35], [3000, 0.1], [3400, 0]),
    tr(BODY_TILT, [0, 0], [900, -7], [1300, -7], [THROW, 9], [1900, 5], [3000, 0]),
    tr(BODY_SQUASH, [1300, 0], [THROW, 0.12], [1700, 0]),
    tr(
      GAZE_X,
      [0, 0],
      [900, 0.6],
      [THROW, 0.9],
      [2600, 0.9],
      [3400, -0.3],
      [4400, -0.9],
      [5200, 0],
    ),
    tr(
      GAZE_Y,
      [0, 0],
      [900, -0.5],
      [THROW, -0.7],
      [2600, -0.9],
      [3600, -0.9],
      [4600, 0.3],
      [5200, 0],
    ),
    tr(EYE_OPEN, [1300, 0], [THROW, 0.25], [3500, 0.25], [4000, 0]),
    tr(MOUTH_CURVE, [1400, 0], [2000, 0.5], [5000, 0.5], [5600, 0]),
    tr(BROW_RAISE, [1300, 0], [1600, 0.4], [3800, 0.4], [4400, 0]),
  ],
  front(s) {
    const { p, st, f, elapsed: t, k } = s;
    if (t < THROW) {
      // Held in the hand while winding up.
      s.body();
      const lift = t < 900 ? ease(t / 900) : 1;
      const [hx, hy] = hand(st, f, lift);
      const pop = ease(t / 250);
      drawPlane(p, hx, hy - 2 * k, -0.9 + lift * 0.5, k * 1.2 * pop);
      return;
    }
    s.ground();
    const u = (t - THROW) / FLIGHT_MS;
    if (u > 1) return;
    const [hx, hy] = hand(st, f, 0.25);
    const [fx, fy, a] = flightPoint(u);
    const fade = 1 - ease((u - 0.86) / 0.14);
    drawPlane(p, hx + fx * k, hy + fy * k, a, k * 1.2 * fade);
  },
  weight: (temper, st) => 0.7 + temper.playful * 0.12 + (hasArms(st) ? 0.6 : 0),
};

// ---------------------------------------------------------------------------
// Bicycle: hop on, pedal one way, turn round, pedal back, hop off.
// ---------------------------------------------------------------------------

const BIKE_ON = 450;
const BIKE_OFF = 5800;
const BIKE_TURN = 3050;
/** Wheel radius in size units. */
const BIKE_R = 11;

function bikeLift(k: number): number {
  return 2.05 * BIKE_R * k;
}

const bicycle: ActivityDef = {
  ms: 6400,
  tracks: [
    tr(BODY_TILT, [0, 0], [BIKE_ON, 6], [BIKE_OFF, 6], [6200, 0]),
    tr(ARM_L, [0, 0], [BIKE_ON, 0.45], [BIKE_OFF, 0.45], [6200, 0]),
    tr(ARM_R, [0, 0], [BIKE_ON, 0.45], [BIKE_OFF, 0.45], [6200, 0]),
    tr(GAZE_X, [0, 0], [BIKE_ON, 0.5], [BIKE_OFF, 0.5], [6200, 0]),
    tr(MOUTH_CURVE, [0, 0], [BIKE_ON, 0.5], [BIKE_OFF, 0.5], [6300, 0]),
    tr(EYE_SQUINT, [0, 0], [BIKE_ON, 0.25], [BIKE_OFF, 0.25], [6300, 0]),
    tr(FLIP_X, [0, 0], [BIKE_TURN - 100, 0], [BIKE_TURN + 100, -2], [5500, -2], [5750, 0]),
    tr(BODY_SQUASH, [0, 0], [200, 0.1], [BIKE_ON, 0], [BIKE_OFF, 0], [6000, 0.12], [6300, 0]),
  ],
  pose(t, out, _f, k, w) {
    const on = popIn(t, 200, BIKE_ON, BIKE_OFF, 6150);
    const pedal = Math.max(0, Math.min(1, (t - BIKE_ON) / 200)) * (1 - ease((t - BIKE_OFF) / 300));
    const bob = Math.abs(Math.sin(t * 0.011)) * 1.6 * pedal;
    out[BODY_Y] = out[BODY_Y]! - (bikeLift(k) * on + bob) * w;
  },
  shift: (t) => {
    const ride = popIn(t, BIKE_ON, BIKE_ON + 400, BIKE_OFF - 400, BIKE_OFF);
    return Math.sin(t / 700) * 3.5 * ride;
  },
  back(s) {
    const { p, elapsed: t, k } = s;
    const sc = popIn(t, 200, BIKE_ON, BIKE_OFF, 6150);
    if (sc <= 0.05) return;
    s.ground();
    const r = BIKE_R * k * sc;
    const ax = 16 * k * sc;
    const ay = -r;
    const theta = t * 0.011;
    // Wheels: a ring and two spokes each.
    for (const x of [-ax, ax]) {
      p.arc(x, ay, r, 0, TAU, 2.4 * k * sc, OUTLINE);
      for (const a of [theta, theta + PI / 2]) {
        const dx = Math.cos(a) * r * 0.85;
        const dy = Math.sin(a) * r * 0.85;
        p.line(x - dx, ay - dy, x + dx, ay + dy, 1.4 * k * sc, DARK);
      }
    }
    // Frame: rear axle → crank → head tube, saddle post, and the top tube.
    const crank: [number, number] = [-1 * k * sc, -r * 1.05];
    const saddle: [number, number] = [-7 * k * sc, -r * 2.35];
    const head: [number, number] = [9 * k * sc, -r * 2.2];
    const w = 2.2 * k * sc;
    p.lineO(-ax, ay, crank[0], crank[1], w, ACCENT);
    p.lineO(crank[0], crank[1], head[0], head[1], w, ACCENT);
    p.lineO(crank[0], crank[1], saddle[0], saddle[1], w, ACCENT);
    p.lineO(head[0], head[1], ax, ay, w, ACCENT);
    p.line(
      saddle[0] - 4 * k * sc,
      saddle[1],
      saddle[0] + 4 * k * sc,
      saddle[1],
      2.6 * k * sc,
      DARK,
    );
    p.line(
      head[0] - 1 * k * sc,
      head[1] - 3 * k * sc,
      head[0] + 5 * k * sc,
      head[1] - 4 * k * sc,
      2 * k * sc,
      OUTLINE,
    );
    // Road dashes stream backwards while riding.
    const ride = popIn(t, BIKE_ON, BIKE_ON + 300, BIKE_OFF - 300, BIKE_OFF);
    if (ride > 0.05) {
      const speed = 0.06 * k;
      const span = 84 * k;
      for (let i = 0; i < 3; i++) {
        let x = (((-t * speed + i * 28 * k) % span) + span) % span;
        x -= span / 2;
        const len = 5 * k * ride * (1 - Math.min(1, Math.abs(x) / (40 * k)));
        if (len > 0.5) p.line(x - len, 2.5 * k, x + len, 2.5 * k, 1.6 * k, SHADE);
      }
    }
  },
  front(s) {
    const { p, elapsed: t, k } = s;
    const sc = popIn(t, 200, BIKE_ON, BIKE_OFF, 6150);
    if (sc <= 0.05) return;
    s.ground();
    const r = BIKE_R * k * sc;
    const theta = t * 0.011 + 0.6;
    const cx = -1 * k * sc;
    const cy = -r * 1.05;
    const px = cx + Math.cos(theta) * 4.5 * k * sc;
    const py = cy + Math.sin(theta) * 4.5 * k * sc;
    p.line(cx, cy, px, py, 1.6 * k * sc, DARK);
    p.line(px - 2 * k * sc, py, px + 2 * k * sc, py, 2.2 * k * sc, DARK);
  },
  weight: (temper) => 0.5 + temper.energy * 0.12,
};

// ---------------------------------------------------------------------------
// Ball: it rolls in, gets a headbutt, sails off in an arc and bounces away.
// ---------------------------------------------------------------------------

const KICK = 1350;

function ballAt(t: number, k: number): [number, number, number] {
  const rb = 8.5 * k;
  let x: number;
  let y = -rb;
  let sc = 1;
  if (t < 1100) {
    const u = ease(t / 1100);
    x = 78 - 52 * u;
  } else if (t < KICK) x = 26;
  else if (t < 3100) {
    const u = (t - KICK) / (3100 - KICK);
    x = 26 - 74 * u;
    y = -rb - 62 * 4 * u * (1 - u);
  } else if (t < 3900) {
    const u = (t - 3100) / 800;
    x = -48 - 22 * u;
    y = -rb - 18 * 4 * u * (1 - u);
  } else {
    const u = (t - 3900) / 1000;
    x = -70 - 30 * u;
    sc = 1 - ease((u - 0.5) / 0.5);
  }
  return [x * k, y, sc];
}

const ball: ActivityDef = {
  ms: 5200,
  tracks: [
    tr(BODY_TILT, [1000, 0], [1200, -7], [KICK, 10], [1600, 0]),
    tr(BODY_Y, [1200, 0], [KICK, -9], [1550, 0]),
    tr(BODY_SQUASH, [1300, 0], [1380, 0.12], [1600, 0]),
    tr(MOUTH_CURVE, [KICK, 0], [1700, 0.6], [4500, 0.6], [5000, 0]),
    tr(EYE_OPEN, [1400, 0], [1600, 0.2], [4000, 0.2], [4500, 0]),
    tr(EAR_ANGLE, [0, 0], [400, 0.4], [4600, 0.4], [5000, 0]),
  ],
  pose(t, out, f, k, w) {
    const [x, y] = ballAt(t, k);
    const eyeY = -f.by * 1.1;
    out[GAZE_X] = out[GAZE_X]! + clamp(x / 60, -0.9, 0.9) * w;
    out[GAZE_Y] = out[GAZE_Y]! + clamp((y - eyeY) / 60, -0.9, 0.9) * w;
  },
  front(s) {
    const { p, elapsed: t, k } = s;
    const [x, y, sc] = ballAt(t, k);
    const rb = 8.5 * k * sc;
    if (rb < 0.5) return;
    s.ground();
    p.ellipseO(x, y, rb, rb, ACCENT);
    const a = -x / (8.5 * k);
    p.arc(x, y, rb * 0.55, a, a + PI * 0.9, 1.6 * k * sc, DARK);
  },
  weight: (temper) => 0.6 + temper.playful * 0.15,
};

// ---------------------------------------------------------------------------
// Bubbles: puff one up at the mouth, let it float off and pop.
// ---------------------------------------------------------------------------

const BUBBLE_CYCLE = 2500;

function bubbleAt(
  c: number,
  f: FaceLayout,
  k: number,
): { x: number; y: number; r: number; free: boolean; pop: number } {
  const mx = f.faceX + f.mw + 9 * k;
  const my = f.mouthY;
  if (c < 700) {
    const r = 7.5 * k * ease(c / 700);
    return { x: mx + r * 0.6, y: my, r, free: false, pop: 0 };
  }
  if (c < 2200) {
    const u = (c - 700) / 1500;
    return {
      x: mx + 4 * k + Math.sin(u * 7) * 6 * k,
      y: my - u * 58 * k,
      r: 7.5 * k * (1 + 0.08 * Math.sin(u * 20)),
      free: true,
      pop: 0,
    };
  }
  const v = (c - 2200) / 300;
  return { x: mx + 4 * k + Math.sin(7) * 6 * k, y: my - 58 * k, r: 7.5 * k, free: true, pop: v };
}

const bubble: ActivityDef = {
  ms: BUBBLE_CYCLE * 2 + 200,
  tracks: [tr(ARM_L, [0, 0], [300, 0.2], [4900, 0.2], [5200, 0])],
  pose(t, out, f, k, w) {
    const c = t % BUBBLE_CYCLE;
    if (t < BUBBLE_CYCLE * 2) {
      const puff = c < 700 ? Math.sin((PI * c) / 700) : 0;
      out[MOUTH_OPEN] = out[MOUTH_OPEN]! + 0.45 * puff * w;
      out[EYE_SQUINT] = out[EYE_SQUINT]! + 0.35 * puff * w;
      out[BODY_SQUASH] = out[BODY_SQUASH]! + 0.05 * puff * w;
      const b = bubbleAt(c, f, k);
      const eyeY = -f.by * 1.1;
      out[GAZE_X] = out[GAZE_X]! + clamp(b.x / 40, -0.9, 0.9) * w;
      out[GAZE_Y] = out[GAZE_Y]! + clamp((b.y - eyeY) / 50, -0.9, 0.9) * w;
    }
  },
  front(s) {
    const { p, f, elapsed: t, k } = s;
    if (t >= BUBBLE_CYCLE * 2) return;
    const c = t % BUBBLE_CYCLE;
    const b = bubbleAt(c, f, k);
    if (b.r < 0.8) return;
    if (b.free) s.ground();
    else s.body();
    if (b.pop > 0) {
      const v = b.pop;
      const len = 5 * k * (1 - v);
      if (len < 0.5) return;
      for (let i = 0; i < 4; i++) {
        const a = i * (PI / 2) + PI / 4;
        const d = b.r * (0.6 + v * 0.9);
        p.line(
          b.x + Math.cos(a) * d,
          b.y + Math.sin(a) * d,
          b.x + Math.cos(a) * (d + len),
          b.y + Math.sin(a) * (d + len),
          1.4 * k,
          EYE_WHITE,
        );
      }
      return;
    }
    p.arc(b.x, b.y, b.r, 0, TAU, 1.3 * k, EYE_WHITE);
    p.arc(b.x, b.y, b.r * 0.62, PI * 1.15, PI * 1.55, 1.7 * k, EYE_WHITE);
  },
  weight: (temper) => 0.8 + temper.shy * 0.1 + temper.curious * 0.05,
};

// ---------------------------------------------------------------------------
// Book: settle down with a book, flip pages, chuckle, gasp.
// ---------------------------------------------------------------------------

const PAGE_FLIPS = [1900, 3900];

const book: ActivityDef = {
  ms: 6400,
  tracks: [
    tr(ARM_L, [0, 0], [300, 0.3], [6100, 0.3], [6400, 0]),
    tr(ARM_R, [0, 0], [300, 0.3], [6100, 0.3], [6400, 0]),
    tr(GAZE_Y, [0, 0], [300, 0.85], [6000, 0.85], [6400, 0]),
    tr(BODY_TILT, [0, 0], [400, 3], [6000, 3], [6400, 0]),
    tr(MOUTH_CURVE, [2900, 0], [3200, 0.6], [4300, 0.6], [4700, 0]),
    tr(EYE_SQUINT, [2900, 0], [3200, 0.5], [4300, 0.5], [4700, 0]),
    tr(BROW_RAISE, [5000, 0], [5200, 0.7], [5800, 0.7], [6000, 0]),
    tr(EYE_OPEN, [5000, 0], [5200, 0.25], [5800, 0.25], [6000, 0]),
    tr(MOUTH_OPEN, [5000, 0], [5200, 0.3], [5800, 0.3], [6000, 0]),
  ],
  pose(t, out, _f, _k, w) {
    if (t < 300 || t > 6000) return;
    // Reading: the eyes sweep left to right and snap back.
    const u = (t % 900) / 900;
    out[GAZE_X] = out[GAZE_X]! + (-0.35 + 0.7 * Math.min(1, u / 0.85)) * w;
  },
  front(s) {
    const { p, f, elapsed: t, k } = s;
    const sc = popIn(t, 0, 300, 6100, 6400);
    if (sc <= 0.05) return;
    s.body();
    const pw = f.bx * 0.42 * sc;
    const ph = Math.max(2, f.by * 0.2) * sc;
    const y = -f.by * 0.6;
    const x = f.faceX * 0.3;
    p.rrect(x, y + 1 * k, pw * 2.08 + OW, ph + OW + 1 * k, 2 * k, OUTLINE);
    p.rrect(x, y + 1 * k, pw * 2.08, ph + 1 * k, 1.5 * k, ACCENT);
    for (const side of [-1, 1]) p.rrect(x + side * pw * 1.02, y, pw, ph, 1 * k, EYE_WHITE);
    p.line(x, y - ph, x, y + ph, 1.2 * k, OUTLINE);
    // Text lines.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const ly = y - ph * 0.55 + i * ph * 0.5;
        const lw = pw * (0.62 - (i === 2 ? 0.18 : 0));
        if (lw > 1)
          p.line(x + side * pw * 1.02 - lw, ly, x + side * pw * 1.02 + lw, ly, 1.1 * k * sc, SHADE);
      }
    }
    // A page mid-flip.
    for (const at of PAGE_FLIPS) {
      const v = (t - at) / 300;
      if (v < 0 || v > 1) continue;
      const hw = pw * Math.abs(1 - 2 * v);
      const sign = v < 0.5 ? 1 : -1;
      if (hw > 0.8)
        p.rrectO(
          x + sign * hw,
          y - ph * 0.15 * Math.sin(PI * v),
          hw,
          ph,
          1 * k,
          EYE_WHITE,
          OW * 0.7,
        );
    }
  },
  weight: (temper) => 0.6 + temper.curious * 0.15 + temper.shy * 0.08,
};

// ---------------------------------------------------------------------------
// Juggle: a three-ball cascade.
// ---------------------------------------------------------------------------

const JT = 310;
const JUGGLE_FROM = 500;
const JUGGLE_TO = 4900;
const BALL_COLOURS = [ACCENT, EYE_WHITE, FX] as const;

function juggleBall(t: number, i: number, f: FaceLayout, k: number): [number, number] {
  const hx = f.bx * 0.55;
  const hy = -f.by * 0.75;
  const H = f.by * 1.5 + 24 * k;
  if (t < JUGGLE_FROM || t > JUGGLE_TO) {
    // Resting in the hands: two on the left, one on the right.
    return [i === 1 ? hx : -hx + (i === 2 ? 3 * k : -3 * k), hy];
  }
  const phase = (t - JUGGLE_FROM + i * JT) % (6 * JT);
  let from = -1;
  let u = 0;
  let flying = true;
  if (phase < 2 * JT) u = phase / (2 * JT);
  else if (phase < 3 * JT) {
    flying = false;
    from = 1;
  } else if (phase < 5 * JT) {
    from = 1;
    u = (phase - 3 * JT) / (2 * JT);
  } else flying = false;
  if (!flying) return [from * hx, hy];
  const x = from * hx * (1 - 2 * u);
  const y = hy - H * 4 * u * (1 - u);
  return [x, y];
}

const juggle: ActivityDef = {
  ms: 5600,
  tracks: [
    tr(GAZE_Y, [0, 0], [JUGGLE_FROM, -0.7], [JUGGLE_TO, -0.7], [5300, 0]),
    tr(MOUTH_CURVE, [0, 0], [JUGGLE_FROM, 0.4], [JUGGLE_TO, 0.4], [5400, 0]),
    tr(BROW_RAISE, [0, 0], [JUGGLE_FROM, 0.3], [JUGGLE_TO, 0.3], [5400, 0]),
    tr(EAR_ANGLE, [0, 0], [JUGGLE_FROM, 0.5], [JUGGLE_TO, 0.5], [5400, 0]),
    tr(ARM_L, [0, 0], [300, 0.35], [5300, 0.35], [5600, 0]),
    tr(ARM_R, [0, 0], [300, 0.35], [5300, 0.35], [5600, 0]),
  ],
  pose(t, out, f, k, w) {
    if (t < JUGGLE_FROM || t > JUGGLE_TO) return;
    const ph = ((t - JUGGLE_FROM) / (2 * JT)) * TAU;
    out[ARM_L] = out[ARM_L]! + 0.18 * Math.max(0, Math.sin(ph)) * w;
    out[ARM_R] = out[ARM_R]! + 0.18 * Math.max(0, Math.sin(ph + PI)) * w;
    // Follow the highest ball.
    let top = 0;
    let topY = Infinity;
    for (let i = 0; i < 3; i++) {
      const [x, y] = juggleBall(t, i, f, k);
      if (y < topY) {
        topY = y;
        top = x;
      }
    }
    out[GAZE_X] = out[GAZE_X]! + clamp(top / (f.bx * 1.2), -0.6, 0.6) * w;
  },
  front(s) {
    const { p, f, elapsed: t, k } = s;
    const sc = popIn(t, 0, 400, 5200, 5600);
    if (sc <= 0.05) return;
    s.ground();
    const r = 5 * k * sc;
    for (let i = 0; i < 3; i++) {
      const [x, y] = juggleBall(t, i, f, k);
      p.ellipseO(x, y, r, r, BALL_COLOURS[i]!, OW * 0.8);
    }
  },
  weight: (temper, st) => 0.3 + temper.playful * 0.12 + (hasArms(st) ? 0.7 : 0),
};

// ---------------------------------------------------------------------------
// Chase tail: three quick turns with hops.
// ---------------------------------------------------------------------------

const chaseTail: ActivityDef = {
  ms: 3600,
  tracks: [
    tr(
      FLIP_X,
      [0, 0],
      [300, -1],
      [600, -2],
      [900, -1],
      [1200, 0],
      [1500, -1],
      [1800, -2],
      [2100, -1],
      [2400, 0],
      [2700, -1],
      [3000, -2],
      [3300, -1],
      [3600, 0],
    ),
    tr(GAZE_X, [0, 0], [200, 0.7], [3200, 0.7], [3600, 0]),
    tr(GAZE_Y, [0, 0], [200, 0.5], [3200, 0.5], [3600, 0]),
    tr(BODY_TILT, [0, 0], [300, 5], [900, -5], [1500, 5], [2100, -5], [2700, 5], [3300, 0]),
    tr(
      BODY_Y,
      [0, 0],
      [300, -4],
      [600, 0],
      [900, -4],
      [1200, 0],
      [1500, -4],
      [1800, 0],
      [2100, -4],
      [2400, 0],
      [2700, -4],
      [3000, 0],
      [3300, 0],
    ),
    tr(EAR_ANGLE, [0, 0], [200, 0.5], [3200, 0.5], [3600, 0]),
    tr(MOUTH_OPEN, [0, 0], [200, 0.3], [3200, 0.3], [3600, 0]),
    tr(EYE_OPEN, [0, 0], [200, 0.1], [3200, 0.1], [3600, 0]),
  ],
  weight: (temper, st) => (st.tail === 0 ? 0 : 0.5 + temper.playful * 0.15),
};

export const ACTIVITY_DEFS: Record<Activity, ActivityDef> = {
  stretch,
  paperPlane,
  bicycle,
  ball,
  bubble,
  book,
  juggle,
  chaseTail,
};

export function activityDuration(a: Activity): number {
  return ACTIVITY_DEFS[a].ms;
}

/** Fraction 0..1 from a hash. */
function frac(seed: number, salt: number): number {
  return (hash2(seed, salt) % 10000) / 10000;
}

export interface ScheduledActivity {
  activity: Activity;
  start: number;
}

/**
 * The activity seeded for a slot, if any: a pure function of (seed, temper, DNA, slot),
 * so every viewer of the pal agrees. Playful and energetic pals do more.
 */
export function scheduledActivity(
  seed: number,
  temper: Temper,
  st: PalStatic,
  slot: number,
): ScheduledActivity | null {
  if (slot < 0) return null;
  const chance = Math.min(0.95, 0.55 + temper.playful * 0.03 + temper.energy * 0.02);
  if (frac(seed, 12_000 + slot) >= chance) return null;
  let total = 0;
  const weights = ACTIVITIES.map((a) => {
    const w = Math.max(0, ACTIVITY_DEFS[a].weight(temper, st));
    total += w;
    return w;
  });
  if (total <= 0) return null;
  let pick = frac(seed, 13_000 + slot) * total;
  let activity: Activity = ACTIVITIES[0];
  for (let i = 0; i < ACTIVITIES.length; i++) {
    pick -= weights[i]!;
    if (pick < 0) {
      activity = ACTIVITIES[i]!;
      break;
    }
  }
  const room = SLOT_MS - LEAD_MS - MAX_MS - 500;
  const start = slot * SLOT_MS + LEAD_MS + Math.floor(frac(seed, 14_000 + slot) * room);
  return { activity, start };
}
