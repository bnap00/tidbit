// The procedural puppet: DNA + pose → primitives in local pal space.
// Local space: origin at the pal's ground point, y grows downward (so the body
// occupies negative y). Every part is placed relative to the body's current
// half extents, so squash, stretch and fit scale all stay consistent.
import {
  ACCESSORIES,
  BODIES,
  EARS,
  EYES,
  LIMBS,
  MARKINGS,
  MOUTHS,
  TAILS,
  hash2,
  type DNA,
} from "@tidbit/protocol";
import { BODY_PARAMS, EYES_PARAMS, POSE_MAX, type BodyParams } from "@tidbit/protocol/rig-data";
import { OW, PART, type Painter } from "./painter.js";
import {
  ARM_L,
  ARM_R,
  BLUSH,
  BODY_SQUASH,
  BROW_ANGLE,
  BROW_RAISE,
  EAR_ANGLE,
  EYE_OPEN,
  EYE_SQUINT,
  GAZE_X,
  GAZE_Y,
  MOUTH_CURVE,
  MOUTH_OPEN,
  PUPIL_SIZE,
  type Pose,
} from "./pose.js";
import { ACCENT, BG, BODY, DARK, EYE_WHITE, FX, OUTLINE, SHADE } from "./types.js";

const PI = Math.PI;

// Enum indices, resolved once so the C++ port can switch on integers.
const B = Object.fromEntries(BODIES.map((v, i) => [v, i])) as Record<
  (typeof BODIES)[number],
  number
>;
const E = Object.fromEntries(EYES.map((v, i) => [v, i])) as Record<(typeof EYES)[number], number>;
const M = Object.fromEntries(MOUTHS.map((v, i) => [v, i])) as Record<
  (typeof MOUTHS)[number],
  number
>;
const R = Object.fromEntries(EARS.map((v, i) => [v, i])) as Record<(typeof EARS)[number], number>;
const L = Object.fromEntries(LIMBS.map((v, i) => [v, i])) as Record<(typeof LIMBS)[number], number>;
const T = Object.fromEntries(TAILS.map((v, i) => [v, i])) as Record<(typeof TAILS)[number], number>;
const K = Object.fromEntries(MARKINGS.map((v, i) => [v, i])) as Record<
  (typeof MARKINGS)[number],
  number
>;
const A = Object.fromEntries(ACCESSORIES.map((v, i) => [v, i])) as Record<
  (typeof ACCESSORIES)[number],
  number
>;

/** Everything derived from DNA alone. Computed once per rig. */
export interface PalStatic {
  body: number;
  eyes: number;
  brows: number;
  mouth: number;
  ears: number;
  limbs: number;
  tail: number;
  marking: number;
  accessory: number;
  bp: BodyParams;
  /** Overall size factor from `size`. */
  k: number;
  rx0: number;
  ry0: number;
  eyeR: number;
  eyeGap: number;
  /** Seeded micro-variation. */
  earTwistL: number;
  earTwistR: number;
  spotSlots: number[];
  spotSize: number[];
  fangSide: number;
  flowerSide: number;
}

export function buildStatic(dna: DNA): PalStatic {
  const look = dna.look;
  const body = Math.max(0, BODIES.indexOf(look.body));
  const bp = BODY_PARAMS[body]!;
  const k = 0.9 + look.size * 0.045;
  const plumpW = 0.84 + look.plump * 0.036;
  const plumpH = 1.08 - look.plump * 0.018;
  const h = (salt: number) => (hash2(dna.seed, salt) % 10000) / 10000;
  // Pick three distinct spot slots out of six.
  const order = [0, 1, 2, 3, 4, 5];
  for (let i = order.length - 1; i > 0; i--) {
    const j = hash2(dna.seed, 40 + i) % (i + 1);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  return {
    body,
    eyes: Math.max(0, EYES.indexOf(look.eyes)),
    brows: look.brows === "thick" ? 2 : look.brows === "thin" ? 1 : 0,
    mouth: Math.max(0, MOUTHS.indexOf(look.mouth)),
    ears: Math.max(0, EARS.indexOf(look.ears)),
    limbs: Math.max(0, LIMBS.indexOf(look.limbs)),
    tail: Math.max(0, TAILS.indexOf(look.tail)),
    marking: Math.max(0, MARKINGS.indexOf(look.marking)),
    accessory: Math.max(0, ACCESSORIES.indexOf(look.accessory)),
    bp,
    k,
    rx0: bp.rx * k * plumpW,
    ry0: bp.ry * k * plumpH,
    eyeR: (5.5 + look.eyeSize * 0.85) * k,
    eyeGap: (2 + look.eyeGap * 1.6) * k * (0.94 + h(1) * 0.12),
    earTwistL: (h(2) - 0.5) * 0.25,
    earTwistR: (h(3) - 0.5) * 0.25,
    spotSlots: order.slice(0, 3),
    spotSize: [0.8 + h(4) * 0.5, 0.8 + h(5) * 0.5, 0.8 + h(6) * 0.5],
    fangSide: h(7) < 0.5 ? -1 : 1,
    flowerSide: h(8) < 0.5 ? -1 : 1,
  };
}

// ---------------------------------------------------------------------------
// Body primitives
// ---------------------------------------------------------------------------

/** A body primitive: ellipse (e = 1) or rounded rect (e = 0), centre + half extents. */
interface Prim {
  e: number;
  x: number;
  y: number;
  a: number;
  b: number;
  r: number;
}

const P = (e: number, x: number, y: number, a: number, b: number, r = 0): Prim => ({
  e,
  x,
  y,
  a,
  b,
  r,
});

/** Body shape in local space for half extents bx, by (body spans y ∈ [-2by, 0]). */
export function bodyPrims(body: number, bx: number, by: number): Prim[] {
  const V = (v: number) => by * (v - 1); // v ∈ [-1, 1] → local y
  switch (body) {
    case B.blob:
      return [
        P(1, 0, V(0.08), bx, by * 0.92),
        P(1, -bx * 0.38, V(-0.42), bx * 0.55, by * 0.55),
        P(1, bx * 0.36, V(-0.38), bx * 0.58, by * 0.6),
      ];
    case B.tall:
      return [P(0, 0, V(0), bx, by, Math.min(bx, by) * 0.95)];
    case B.squat:
      return [P(1, 0, V(-0.12), bx, by * 0.88), P(0, 0, V(0.45), bx, by * 0.55, by * 0.5)];
    case B.bean:
      return [
        P(1, -bx * 0.1, V(-0.38), bx * 0.8, by * 0.62),
        P(1, bx * 0.06, V(0.3), bx * 0.94, by * 0.7),
      ];
    case B.ghost:
      return [
        P(1, 0, V(-0.25), bx, by * 0.75),
        P(0, 0, V(0.28), bx, by * 0.57, 2),
        P(1, -bx * 0.66, V(0.86), bx * 0.34, by * 0.14),
        P(1, 0, V(0.86), bx * 0.34, by * 0.14),
        P(1, bx * 0.66, V(0.86), bx * 0.34, by * 0.14),
      ];
    case B.egg:
      return [P(1, 0, V(-0.28), bx * 0.8, by * 0.72), P(1, 0, V(0.2), bx, by * 0.8)];
    case B.square:
      return [P(0, 0, V(0), bx, by, Math.min(bx, by) * 0.38)];
    case B.round:
    default:
      return [P(1, 0, V(0), bx, by)];
  }
}

/**
 * Half width of the body at local height y: the smaller of its left and right
 * extents, so symmetric parts placed at ±halfWidth stay on the body.
 */
export function halfWidthAt(prims: Prim[], y: number): number {
  let left = 0;
  let right = 0;
  for (const p of prims) {
    const dy = Math.abs(y - p.y);
    if (dy > p.b) continue;
    let hw: number;
    if (p.e) hw = p.a * Math.sqrt(Math.max(0, 1 - (dy / p.b) ** 2));
    else {
      const r = Math.min(p.r, p.a, p.b);
      const over = dy - (p.b - r);
      hw = over > 0 ? p.a - r + Math.sqrt(Math.max(0, r * r - over * over)) : p.a;
    }
    right = Math.max(right, p.x + hw);
    left = Math.max(left, hw - p.x);
  }
  return Math.min(left, right);
}

/** Topmost local y of the body at local x (the body's upper surface). */
export function topAt(prims: Prim[], x: number): number {
  let top = 0;
  for (const p of prims) {
    const dx = Math.abs(x - p.x);
    if (dx > p.a) continue;
    let hh: number;
    if (p.e) hh = p.b * Math.sqrt(Math.max(0, 1 - (dx / p.a) ** 2));
    else {
      const r = Math.min(p.r, p.a, p.b);
      const over = dx - (p.a - r);
      hh = over > 0 ? p.b - r + Math.sqrt(Math.max(0, r * r - over * over)) : p.b;
    }
    top = Math.min(top, p.y - hh);
  }
  return top;
}

// ---------------------------------------------------------------------------
// Per-frame layout
// ---------------------------------------------------------------------------

/** Positions of face features for one frame (local space). Exposed for tests. */
export interface FaceLayout {
  bx: number;
  by: number;
  prims: Prim[];
  top: number;
  eyeY: number;
  eyeX: number;
  erx: number;
  ery: number;
  mouthY: number;
  mw: number;
  faceX: number;
}

export function faceLayout(st: PalStatic, pose: Pose): FaceLayout {
  const q = pose[BODY_SQUASH]!;
  const bx = st.rx0 * (1 + q);
  const by = st.ry0 * (1 - q);
  const prims = bodyPrims(st.body, bx, by);
  const ep = EYES_PARAMS[st.eyes]!;
  let erx = ep.rx * st.eyeR;
  let ery = ep.ry * st.eyeR;
  const cyclops = st.eyes === E.cyclops;
  let eyeX = cyclops ? 0 : erx + st.eyeGap;
  if (st.eyes === E.visor) eyeX = st.eyeR * 0.9 + st.eyeGap;
  let eyeY = by * (st.bp.faceV - 1);
  const faceX = pose[GAZE_X]! * 2.5 * st.k;

  // Keep the eyes comfortably inside the body silhouette, even wide open.
  const openMax = POSE_MAX[EYE_OPEN]!;
  const avail = halfWidthAt(prims, eyeY) * 0.78 - Math.abs(faceX);
  const need = eyeX + erx * (st.eyes === E.visor ? 2 : 1) + OW;
  const fw = need > 0 ? avail / need : 1;
  const fh = (by * 0.5) / (ery * openMax + OW);
  const f = Math.max(0.3, Math.min(1, fw, fh));
  erx *= f;
  ery *= f;
  eyeX *= f;
  const reach = eyeX + erx + OW;
  const lowestTop = Math.max(topAt(prims, eyeX - erx), topAt(prims, eyeX), topAt(prims, reach));
  const topLimit = lowestTop + ery * openMax + OW + 2 * st.k;
  if (eyeY < topLimit) eyeY = topLimit;

  const mw = (st.mouth === M.o ? 4 : st.mouth === M.beak ? 6 : 6.5) * st.k;
  let mouthY = eyeY + ery + Math.max(5 * st.k, by * 0.14);
  // Leave room for an open mouth above the bottom of the body.
  mouthY = Math.min(mouthY, -by * 0.42);
  mouthY = Math.max(mouthY, eyeY + ery * 0.6 + 3 * st.k);
  return { bx, by, prims, top: topAt(prims, 0), eyeY, eyeX, erx, ery, mouthY, mw, faceX };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export function drawPal(p: Painter, st: PalStatic, pose: Pose): FaceLayout {
  const f = faceLayout(st, pose);
  p.part = PART.tail;
  drawTail(p, st, f);
  p.part = PART.limbs;
  drawBackLimbs(p, st, f, pose);
  p.part = PART.ears;
  drawEars(p, st, f, pose);
  p.part = PART.body;
  drawBody(p, f);
  p.part = PART.marking;
  drawMarking(p, st, f);
  p.part = PART.limbs;
  drawFrontLimbs(p, st, f, pose);
  p.part = PART.eyes;
  drawEyes(p, st, f, pose);
  drawLids(p, st, f, pose);
  p.part = PART.brows;
  drawBrows(p, st, f, pose);
  p.part = PART.blush;
  drawBlush(p, st, f, pose);
  p.part = PART.mouth;
  drawMouth(p, st, f, pose);
  p.part = PART.accessory;
  drawAccessory(p, st, f, pose);
  p.part = PART.none;
  return f;
}

function drawBody(p: Painter, f: FaceLayout): void {
  for (const q of f.prims) {
    if (q.e) p.ellipse(q.x, q.y, q.a + OW, q.b + OW, OUTLINE);
    else p.rrect(q.x, q.y, q.a + OW, q.b + OW, q.r + OW, OUTLINE);
  }
  for (const q of f.prims) {
    if (q.e) p.ellipse(q.x, q.y, q.a, q.b, BODY);
    else p.rrect(q.x, q.y, q.a, q.b, q.r, BODY);
  }
}

function drawEars(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  if (st.ears === R.none) return;
  const k = st.k;
  const e = pose[EAR_ANGLE]!;
  if (st.ears === R.leaf) {
    // A single sprout on top; earAngle bends it.
    const bx0 = 0;
    const by0 = f.top + 3 * k;
    const bend = -e * 0.2 + 0.1;
    const tx = bx0 + Math.sin(bend) * 12 * k;
    const ty = by0 - Math.cos(bend) * 12 * k;
    p.line(bx0, by0, tx, ty, 3 * k, OUTLINE);
    p.ellipseO(tx - 6 * k, ty - 1 * k, 6.5 * k, 3.6 * k, ACCENT, OW * 0.8);
    p.ellipseO(tx + 6 * k, ty - 2 * k, 6.5 * k, 3.6 * k, ACCENT, OW * 0.8);
    return;
  }
  for (const side of [-1, 1]) {
    const twist = side < 0 ? st.earTwistL : st.earTwistR;
    if (st.ears === R.fin) {
      // Side fins at eye height, fanning outward.
      const y = f.eyeY + f.ery * 0.4;
      const x = side * (halfWidthAt(f.prims, y) - 3 * k);
      const lift = (e * 0.5 + twist) * 8 * k;
      const tipX = x + side * 15 * k;
      p.triO(x, y - 9 * k, x, y + 7 * k, tipX, y - 10 * k - lift, ACCENT);
      continue;
    }
    // Ears anchored on the upper surface; direction measured from straight up.
    const ax = side * f.bx * st.bp.earU;
    const ay = topAt(f.prims, ax) + 5 * k;
    const outward = (e >= 0 ? 0.32 - e * 0.24 : 0.32 - e * 1.05) + twist;
    const dx = side * Math.sin(outward);
    const dy = -Math.cos(outward);
    const px = -dy * side; // perpendicular (for triangle bases)
    const py = dx * side;
    if (st.ears === R.cat || st.ears === R.horn) {
      const len = (st.ears === R.cat ? 22 : 16) * k;
      const bw = (st.ears === R.cat ? 11 : 5) * k;
      const tx = ax + dx * len;
      const ty = ay + dy * len;
      const c = st.ears === R.cat ? BODY : ACCENT;
      p.triO(ax - px * bw, ay - py * bw, ax + px * bw, ay + py * bw, tx, ty, c);
      if (st.ears === R.cat) {
        const ib = bw * 0.5;
        const mx = ax + dx * len * 0.22;
        const my = ay + dy * len * 0.22;
        p.tri(
          mx - px * ib,
          my - py * ib,
          mx + px * ib,
          my + py * ib,
          ax + dx * len * 0.75,
          ay + dy * len * 0.75,
          ACCENT,
        );
      }
    } else if (st.ears === R.bunny) {
      // Ellipses cannot rotate, so a droop moves the ear outward and widens it.
      const droop = Math.max(0, Math.min(1, outward / 1.2));
      const len = 26 * k;
      const cx = ax + dx * len * 0.5;
      const cy = ay + dy * len * 0.5;
      const rx = (7 + droop * 7) * k;
      const ry = (14 - droop * 6) * k;
      p.ellipseO(cx, cy, rx, ry, BODY);
      p.ellipse(cx, cy + 1 * k, rx * 0.5, ry * 0.7, ACCENT);
    } else if (st.ears === R.bear) {
      const cx = ax + dx * 4 * k;
      const cy = ay + dy * 4 * k - 2 * k;
      p.ellipseO(cx, cy, 10 * k, 10 * k, BODY);
      p.ellipse(cx, cy + 1 * k, 5.5 * k, 5.5 * k, ACCENT);
    } else if (st.ears === R.antenna) {
      const ax2 = side * f.bx * 0.28;
      const ay2 = topAt(f.prims, ax2) + 3 * k;
      const len = 20 * k;
      const tx = ax2 + dx * len;
      const ty = ay2 + dy * len;
      p.line(ax2, ay2, tx, ty, 2.6 * k, OUTLINE);
      p.ellipseO(tx, ty, 4.5 * k, 4.5 * k, ACCENT);
    }
  }
}

function drawTail(p: Painter, st: PalStatic, f: FaceLayout): void {
  const k = st.k;
  const x0 = f.bx * 0.8;
  const y0 = -f.by * 0.45;
  switch (st.tail) {
    case T.cat: {
      const r = 15 * k;
      const cx = x0 + r * 0.5;
      const cy = y0 - r * 0.35;
      p.arc(cx, cy, r, -PI * 0.55, PI * 0.45, 5 * k + OW * 2, OUTLINE);
      p.arc(cx, cy, r, -PI * 0.55, PI * 0.45, 5 * k, BODY);
      break;
    }
    case T.puff:
      p.ellipseO(x0 + 6 * k, -f.by * 0.3, 10 * k, 9.5 * k, ACCENT);
      break;
    case T.devil: {
      const tx = x0 + 18 * k;
      const ty = y0 - 16 * k;
      p.line(x0, y0 + 4 * k, tx, ty, 3 * k, OUTLINE);
      p.triO(tx - 6 * k, ty + 1 * k, tx + 5 * k, ty + 3 * k, tx + 3 * k, ty - 8 * k, ACCENT);
      break;
    }
    case T.fish:
      p.triO(x0, y0 + 2 * k, x0 + 20 * k, y0 - 12 * k, x0 + 18 * k, y0 + 12 * k, ACCENT);
      break;
    case T.leaf: {
      const tx = x0 + 12 * k;
      const ty = y0 - 8 * k;
      p.line(x0, y0 + 2 * k, tx, ty, 2.6 * k, OUTLINE);
      p.ellipseO(tx + 4 * k, ty - 3 * k, 7 * k, 4.5 * k, ACCENT, OW * 0.8);
      break;
    }
  }
}

/** Shoulder point on the body edge at the limb line. */
export function shoulder(st: PalStatic, f: FaceLayout, side: number): [number, number] {
  const y = f.by * (st.bp.limbV - 1);
  return [side * (halfWidthAt(f.prims, y) - 3 * st.k), y];
}

function drawBackLimbs(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  const k = st.k;
  if (st.limbs === L.wings) {
    for (const side of [-1, 1]) {
      const lift = pose[side < 0 ? ARM_L : ARM_R]!;
      const [sx, sy] = shoulder(st, f, side);
      const cx = sx + side * 8 * k;
      const cy = sy - (6 + lift * 10) * k;
      p.ellipseO(cx, cy, (9 + lift * 3) * k, (14 - lift * 3) * k, ACCENT);
    }
  } else if (st.limbs === L.tentacles) {
    for (const u of [-0.55, 0, 0.55]) {
      const x = u * f.bx;
      p.lineO(x, -6 * k, x + u * 6 * k, 6 * k, 6 * k, BODY);
    }
  }
}

function drawFrontLimbs(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  const k = st.k;
  switch (st.limbs) {
    case L.nubs:
      for (const side of [-1, 1]) {
        const lift = pose[side < 0 ? ARM_L : ARM_R]!;
        const [sx, sy] = shoulder(st, f, side);
        p.ellipseO(sx + side * 1 * k, sy - lift * 10 * k, 6.5 * k, 8 * k, BODY);
      }
      break;
    case L.arms:
      for (const side of [-1, 1]) {
        const lift = pose[side < 0 ? ARM_L : ARM_R]!;
        const [sx, sy] = shoulder(st, f, side);
        // Rest points down-outward (~55° below horizontal); lift raises it overhead.
        const a = (55 - lift * 125) * (PI / 180);
        const len = 16 * k;
        p.lineO(sx, sy, sx + side * Math.cos(a) * len, sy + Math.sin(a) * len, 5 * k, BODY);
      }
      break;
    case L.paws:
      for (const side of [-1, 1]) {
        p.ellipseO(side * f.bx * 0.42, -3 * k, 10 * k, 6 * k, BODY);
      }
      break;
  }
}

function drawMarking(p: Painter, st: PalStatic, f: FaceLayout): void {
  const k = st.k;
  switch (st.marking) {
    case K.belly: {
      const y = -f.by * 0.55;
      const hw = halfWidthAt(f.prims, y);
      p.ellipse(0, y, hw * 0.55, f.by * 0.38, ACCENT);
      break;
    }
    case K.spots: {
      // Six candidate slots around the body edge; three chosen by seed.
      const slots: [number, number][] = [
        [-0.62, -0.55],
        [0.6, -0.62],
        [-0.66, 0.3],
        [0.64, 0.38],
        [0.2, 0.7],
        [-0.28, 0.72],
      ];
      for (let i = 0; i < 3; i++) {
        const [u, v] = slots[st.spotSlots[i]!]!;
        const y = f.by * (v - 1);
        const r = 5.5 * k * st.spotSize[i]!;
        const hw = halfWidthAt(f.prims, y);
        const x = Math.max(-(hw - r - 3 * k), Math.min(hw - r - 3 * k, u * f.bx));
        if (hw > r * 2 + 4 * k) p.ellipse(x, y, r, r * 0.85, SHADE);
      }
      break;
    }
    case K.stripes:
      for (const u of [-0.3, 0, 0.3]) {
        const x = u * f.bx * 0.6;
        const y = topAt(f.prims, x);
        p.line(x, y + 4 * k, x, y + 11 * k, 3.4 * k, SHADE);
      }
      break;
    case K.mask:
      if (st.eyes === E.cyclops || st.eyes === E.visor) {
        p.ellipse(f.faceX, f.eyeY, f.eyeX + f.erx * 1.3 + 4 * k, f.ery + 5 * k, SHADE);
      } else {
        for (const side of [-1, 1])
          p.ellipse(f.faceX + side * f.eyeX, f.eyeY, f.erx + 5 * k, f.ery + 4.5 * k, SHADE);
      }
      break;
    case K.freckles:
      for (const side of [-1, 1]) {
        const cx = f.faceX + side * Math.max(f.eyeX, f.erx + 4 * k);
        const cy = f.eyeY + f.ery + 4 * k;
        for (const d of [-3.5, 0, 3.5])
          p.ellipse(cx + d * k, cy + Math.abs(d) * 0.3 * k, 1.3 * k, 1.3 * k, SHADE);
      }
      break;
  }
}

function drawEyes(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  const k = st.k;
  const open = pose[EYE_OPEN]!;
  const squint = pose[EYE_SQUINT]!;
  const pupil = pose[PUPIL_SIZE]!;
  const gx = pose[GAZE_X]!;
  const gy = pose[GAZE_Y]!;

  if (st.eyes === E.visor) {
    const hw = f.eyeX + f.erx * 2;
    p.rrect(f.faceX, f.eyeY, hw + 2 * k, f.ery * 1.9 + 2 * k, f.ery * 1.9, OUTLINE);
    p.rrect(f.faceX, f.eyeY, hw, f.ery * 1.9, f.ery * 1.7, DARK);
    for (const side of [-1, 1]) {
      const cx = f.faceX + side * f.eyeX + gx * f.erx * 0.5;
      const cy = f.eyeY + gy * f.ery * 0.4;
      eyeShape(p, st, cx, cy, f.erx, f.ery, open, squint, ACCENT, true);
    }
    return;
  }
  const n = st.eyes === E.cyclops ? 1 : 2;
  for (let i = 0; i < n; i++) {
    const side = n === 1 ? 0 : i === 0 ? -1 : 1;
    const cx = f.faceX + side * f.eyeX;
    const cy = f.eyeY;
    const rx = f.erx;
    const ry = f.ery;
    let effRy = ry * open * (1 - 0.45 * squint);
    if (st.eyes === E.sleepy) effRy *= 0.6;
    if (squint >= 0.55 || effRy < ry * 0.2) {
      eyeShape(p, st, cx, cy, rx, ry, open, squint, OUTLINE, false);
      continue;
    }
    // Sleepy eyes sit lower under a heavy lid.
    const ey = st.eyes === E.sleepy ? cy + ry * 0.35 : cy;
    const pr = Math.min(rx * 0.85, rx * 0.55 * pupil);
    const pry = Math.min(pr * (ry / rx), effRy * 0.85);
    const px = cx + gx * (rx - pr) * 0.75;
    const py = ey + gy * Math.max(0, effRy - pry) * 0.75;
    switch (st.eyes) {
      case E.dot:
        p.ellipse(
          cx + gx * 1.5 * k,
          ey + gy * 1.5 * k,
          rx * Math.min(1.25, pupil),
          effRy * Math.min(1.25, pupil),
          DARK,
        );
        p.ellipse(cx + gx * 1.5 * k - rx * 0.3, ey - effRy * 0.35, rx * 0.3, rx * 0.3, EYE_WHITE);
        break;
      case E.oval:
      case E.sparkle: {
        p.ellipse(cx, ey, rx, effRy, DARK);
        if (st.eyes === E.sparkle) p.ellipse(cx, ey + effRy * 0.35, rx * 0.7, effRy * 0.45, ACCENT);
        const hr = rx * (st.eyes === E.sparkle ? 0.42 : 0.36);
        p.ellipse(
          cx - rx * 0.3 - gx * rx * 0.15,
          ey - effRy * 0.4,
          hr,
          Math.min(hr, effRy * 0.4),
          EYE_WHITE,
        );
        p.ellipse(
          cx + rx * 0.35,
          ey + effRy * 0.3,
          hr * 0.45,
          Math.min(hr * 0.45, effRy * 0.2),
          EYE_WHITE,
        );
        break;
      }
      default: {
        // round, tall, sleepy, cyclops: white with pupil and highlight.
        p.ellipse(cx, ey, rx + OW * 0.8, effRy + OW * 0.8, OUTLINE);
        p.ellipse(cx, ey, rx, effRy, EYE_WHITE);
        p.ellipse(px, py, pr, pry, DARK);
        p.ellipse(px - pr * 0.35, py - pry * 0.4, pr * 0.34, Math.min(pr, pry) * 0.34, EYE_WHITE);
        if (st.eyes === E.sleepy)
          p.line(cx - rx * 1.05, ey - effRy, cx + rx * 1.05, ey - effRy, 2.6 * k, OUTLINE);
      }
    }
  }
}

/**
 * Slanted eyelids: angry pulls the inner corners down, sad the outer corners.
 * This reads even on pals without brows.
 */
function drawLids(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  const a = pose[BROW_ANGLE]!;
  if (Math.abs(a) < 0.25 || st.eyes === E.visor || st.eyes === E.dot) return;
  const open = pose[EYE_OPEN]!;
  const squint = pose[EYE_SQUINT]!;
  let effRy = f.ery * open * (1 - 0.45 * squint);
  if (st.eyes === E.sleepy) effRy *= 0.6;
  if (squint >= 0.55 || effRy < f.ery * 0.2) return;
  const lidColor = st.marking === K.mask ? SHADE : BODY;
  const depth = Math.min(1, (Math.abs(a) - 0.25) / 0.75) * 0.9;
  const cyclops = st.eyes === E.cyclops;
  for (const side of [-1, 1]) {
    const cx = cyclops ? f.faceX : f.faceX + side * f.eyeX;
    const cy = st.eyes === E.sleepy ? f.eyeY + f.ery * 0.35 : f.eyeY;
    const w = f.erx + OW * 1.5;
    // For a cyclops each half of the single eye gets its own lid.
    const inner = cyclops ? cx : cx - side * w;
    const outer = cyclops ? cx + side * w : cx + side * w;
    const top = cy - effRy - OW * 1.5;
    const low = cy - effRy * (1 - depth * 1.2);
    const [xl, xh] = a > 0 ? [inner, outer] : [outer, inner];
    p.tri(xl, low, xh, top, xl, top, lidColor);
    p.line(xl, low, xh, top + OW * 0.5, 2.4 * st.k, OUTLINE);
  }
}

/** Closed or squinting eye: ^ when happy, ‿ when closed. */
function eyeShape(
  p: Painter,
  st: PalStatic,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  open: number,
  squint: number,
  c: number,
  visor: boolean,
): void {
  const w = 2.8 * st.k;
  const r = Math.max(rx, 3 * st.k) * 0.95;
  if (squint >= 0.55) {
    p.arc(cx, cy + r * 0.45, r, PI + 0.45, 2 * PI - 0.45, w, c);
  } else if (open * (1 - 0.45 * squint) < 0.2) {
    p.arc(cx, cy - r * 0.55, r, 0.5, PI - 0.5, w, c);
  } else if (visor) {
    p.ellipse(cx, cy, rx, ry * open * (1 - 0.45 * squint), c);
  }
}

function drawBrows(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  if (st.brows === 0) return;
  const k = st.k;
  const w = (st.brows === 2 ? 4.4 : 2.4) * k;
  const angle = pose[BROW_ANGLE]!;
  const raise = pose[BROW_RAISE]!;
  const y = f.eyeY - f.ery - (4.5 + raise * 4) * k - w * 0.5;
  const tilt = angle * 3.5 * k;
  if (st.eyes === E.cyclops) {
    const hw = f.erx * 0.9;
    p.line(f.faceX - hw, y - tilt * 0.5, f.faceX, y + tilt, w, OUTLINE);
    p.line(f.faceX, y + tilt, f.faceX + hw, y - tilt * 0.5, w, OUTLINE);
    return;
  }
  const len = Math.max(f.erx, 4 * k) * 1.05;
  for (const side of [-1, 1]) {
    const cx = f.faceX + side * f.eyeX;
    const inner = cx - side * len * 0.5;
    const outer = cx + side * len * 0.5;
    // Positive angle (angry) pulls the inner end down.
    p.line(inner, y + tilt, outer, y - tilt, w, OUTLINE);
  }
}

function drawBlush(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  const b = pose[BLUSH]!;
  if (b < 0.08) return;
  const k = st.k;
  const y = f.eyeY + f.ery + 3.5 * k;
  const hw = halfWidthAt(f.prims, y);
  const rx = (3.5 + b * 3) * k;
  const x = Math.min(Math.max(f.eyeX, f.erx) + f.erx * 0.4, hw - rx - 3 * k);
  if (x <= 0) return;
  for (const side of [-1, 1]) p.ellipse(f.faceX + side * x, y, rx, rx * 0.55, FX);
}

function drawMouth(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  const k = st.k;
  const curve = pose[MOUTH_CURVE]!;
  const open = pose[MOUTH_OPEN]!;
  const x = f.faceX;
  const y = f.mouthY;
  const mw = f.mw;
  const lw = 2.6 * k;

  if (st.mouth === M.o) {
    const r = mw * (0.7 + open * 0.6);
    p.ellipse(x, y + r * 0.2, r, r * (1.1 + open * 0.3), DARK);
    return;
  }
  if (st.mouth === M.beak) {
    const gap = open * 5 * k;
    p.triO(x - mw, y - 3 * k, x + mw, y - 3 * k, x, y + 4 * k - gap * 0.2, ACCENT, OW * 0.8);
    if (open > 0.2) {
      // The lower mandible is a rounded lip under the dark gap, so an open beak
      // reads as one beak opening rather than two stacked triangles.
      p.ellipseO(x, y + 5 * k + gap * 0.6, mw * 0.72, 2 * k + gap * 0.3, ACCENT, OW * 0.8);
      p.ellipse(x, y + 3 * k, mw * 0.55, gap * 0.6 + 1, DARK);
    }
    return;
  }
  if (open > 0.25) {
    const h = (2.5 + open * 6.5) * k;
    const w = mw * (0.75 + Math.max(0, curve) * 0.35);
    if (st.mouth === M.line) {
      p.rrect(x, y + h * 0.3, w, h * 0.6, h * 0.4, DARK);
    } else {
      p.ellipse(x, y + h * 0.35, w, h * 0.75, DARK);
      p.ellipse(x, y + h * 0.75, w * 0.5, h * 0.3, FX);
    }
    if (st.mouth === M.fang) {
      for (const side of [-1, 1]) {
        const fx = x + side * w * 0.45;
        const ty = y + h * 0.35 - h * 0.62;
        p.tri(fx - 2 * k, ty, fx + 2 * k, ty, fx, ty + 4 * k, EYE_WHITE);
      }
    }
    return;
  }
  if (st.mouth === M.cat) {
    const r = mw * 0.5;
    const down = curve >= 0;
    for (const side of [-1, 1]) {
      const cx = x + side * r;
      if (down) p.arc(cx, y - r * 0.4, r, 0.2, PI - 0.2, lw, OUTLINE);
      else p.arc(cx, y + r * 0.6, r, PI + 0.2, 2 * PI - 0.2, lw, OUTLINE);
    }
    return;
  }
  // smile, fang, line: a single arc whose curvature follows mouthCurve.
  const flat = st.mouth === M.line ? 0.45 : 1;
  const c = curve * flat;
  if (Math.abs(c) < 0.08) {
    p.line(x - mw, y, x + mw, y, lw, OUTLINE);
  } else {
    const phi = 0.3 + Math.abs(c) * 0.95;
    const r = mw / Math.sin(phi);
    const cy = c > 0 ? y - r * Math.cos(phi) : y + r * Math.cos(phi) + 2 * k;
    const mid = c > 0 ? PI / 2 : -PI / 2;
    p.arc(x, cy, r, mid - phi, mid + phi, lw, OUTLINE);
  }
  if (st.mouth === M.fang) {
    const fx = x + st.fangSide * mw * 0.45;
    const dx = fx - x;
    let fy = y;
    if (Math.abs(c) >= 0.08) {
      const phi = 0.3 + Math.abs(c) * 0.95;
      const r = mw / Math.sin(phi);
      const cy = c > 0 ? y - r * Math.cos(phi) : y + r * Math.cos(phi) + 2 * k;
      const s = Math.sqrt(Math.max(0, r * r - dx * dx));
      fy = c > 0 ? cy + s : cy - s;
    }
    p.tri(fx - 2.2 * k, fy, fx + 2.2 * k, fy, fx, fy + 4.5 * k, EYE_WHITE);
  }
}

function drawAccessory(p: Painter, st: PalStatic, f: FaceLayout, pose: Pose): void {
  const k = st.k;
  switch (st.accessory) {
    case A.bow: {
      const x = -f.bx * 0.42;
      const y = topAt(f.prims, x) + 4 * k;
      p.triO(x, y, x - 10 * k, y - 7 * k, x - 10 * k, y + 7 * k, FX);
      p.triO(x, y, x + 10 * k, y - 7 * k, x + 10 * k, y + 7 * k, FX);
      p.ellipseO(x, y, 3.4 * k, 3.4 * k, FX);
      break;
    }
    case A.hat: {
      const y = f.top + 2 * k;
      const hw = Math.min(21 * k, f.bx * 0.85);
      p.rrectO(0, y, hw, 2.6 * k, 2 * k, DARK);
      p.rrectO(0, y - 11 * k, hw * 0.62, 10 * k, 2.5 * k, DARK);
      p.rrect(0, y - 4.5 * k, hw * 0.62, 2.4 * k, 0, ACCENT);
      break;
    }
    case A.glasses: {
      // Lenses follow the eye when it widens, so they never merge with its edge.
      const r = Math.max(f.erx, f.ery * Math.max(1, pose[EYE_OPEN]!)) + 3 * k;
      if (st.eyes === E.cyclops) {
        p.arc(f.faceX, f.eyeY, r, 0, 2 * PI, 2.4 * k, OUTLINE);
      } else {
        for (const side of [-1, 1])
          p.arc(f.faceX + side * f.eyeX, f.eyeY, r, 0, 2 * PI, 2.4 * k, OUTLINE);
        if (f.eyeX > r)
          p.line(f.faceX - f.eyeX + r, f.eyeY, f.faceX + f.eyeX - r, f.eyeY, 2.4 * k, OUTLINE);
      }
      break;
    }
    case A.scarf: {
      const y = Math.min(f.mouthY + 12 * k, -8 * k);
      const hw = halfWidthAt(f.prims, y);
      if (hw <= 4 * k) break;
      p.rrectO(0, y, hw + 1.5 * k, 4.2 * k, 3.5 * k, FX);
      p.rrectO(hw * 0.4, y + 8 * k, 4 * k, 7 * k, 2.5 * k, FX);
      break;
    }
    case A.halo: {
      const y = f.top - 12 * k;
      p.ellipse(0, y, 16 * k, 4.6 * k, ACCENT);
      p.ellipse(0, y, 11.5 * k, 2.2 * k, BG);
      break;
    }
    case A.flower: {
      const x = st.flowerSide * f.bx * 0.5;
      const y = topAt(f.prims, x) + 5 * k;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * 2 * PI - PI / 2;
        p.ellipse(x + Math.cos(a) * 5 * k, y + Math.sin(a) * 5 * k, 3.8 * k, 3.8 * k, FX);
      }
      p.ellipse(x, y, 3 * k, 3 * k, ACCENT);
      break;
    }
    case A.crown: {
      const y = f.top + 1 * k;
      const hw = Math.min(13 * k, f.bx * 0.7);
      const h = 9 * k;
      for (const u of [-1, 0, 1])
        p.triOutline(
          u * hw * 0.7 - 4.5 * k,
          y - 2 * k,
          u * hw * 0.7 + 4.5 * k,
          y - 2 * k,
          u * hw * 0.7,
          y - h - 3 * k,
        );
      p.rrectO(0, y, hw, 3.6 * k, 1.5 * k, ACCENT);
      for (const u of [-1, 0, 1])
        p.tri(
          u * hw * 0.7 - 4.5 * k,
          y - 2 * k,
          u * hw * 0.7 + 4.5 * k,
          y - 2 * k,
          u * hw * 0.7,
          y - h - 3 * k,
          ACCENT,
        );
      p.ellipse(0, y, 2 * k, 2 * k, FX);
      break;
    }
  }
}
