// Browser-only depth and lighting. The rig's shapes, expressions and animation
// stay identical: this target only decides how each primitive is painted.
//
// Depth cues, in order of effect: a shape-following light with a terminator and
// a cool rim from the backdrop; parallax (back parts lag the tilt, the face
// leads the gaze); contact and drop shadows that follow the pose; and specular
// glints on the pupils. Every gradient is built once per palette in unit space
// and mapped onto each shape with a transform, so a frame allocates nothing.
import {
  ACCENT,
  BODY,
  DARK,
  EYE_WHITE,
  FX,
  OUTLINE,
  PART,
  SHADE,
  BODY_TILT,
  BODY_Y,
  GAZE_X,
  GAZE_Y,
  cmdMaxDist,
  type Cmd,
  type DrawTarget,
  type Pal,
  type Pose,
  type RGB,
} from "@tidbit/rig";

const TAU = Math.PI * 2;
/** Cool bounce light from the backdrop, used for rims and the floor. */
const RIM: RGB = [196, 224, 240];

function css([r, g, b]: RGB, alpha = 1): string {
  return alpha >= 1
    ? `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
    : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

/** Lighten (amount > 0) or darken (amount < 0) a colour. */
function tint(c: RGB, amount: number): RGB {
  return c.map((v) => (amount > 0 ? v + (255 - v) * amount : v * (1 + amount))) as unknown as RGB;
}

function mix(a: RGB, b: RGB, u: number): RGB {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** How strongly each palette slot is shaded: [highlight, mid, core shadow, rim]. */
const SHADING: Partial<Record<Pal, readonly [number, number, number, number]>> = {
  [BODY]: [0.36, 0.05, -0.3, 0.16],
  [SHADE]: [0.14, 0, -0.22, 0.08],
  [ACCENT]: [0.32, 0.04, -0.28, 0.14],
  [EYE_WHITE]: [0.1, 0.02, -0.16, 0],
  [FX]: [0.28, 0.04, -0.18, 0.1],
};

const BACK_PARTS = new Set<number>([PART.tail, PART.ears]);
const FACE_PARTS = new Set<number>([PART.eyes, PART.brows, PART.mouth, PART.blush]);

export class PetTarget implements DrawTarget {
  private palette: readonly RGB[] = [];
  private colors: string[] = [];
  /** Unit-space light gradients per palette slot (undefined = flat). */
  private lights: (CanvasGradient | undefined)[] = [];
  private backdrop: CanvasGradient | null = null;
  private floor: CanvasGradient | null = null;
  private shadow: CanvasGradient | null = null;
  private readonly camera = { scale: 1, x: 0, y: 0 };
  private lastCameraTime = 0;

  // Per-frame state from beginFrame().
  private tags: readonly number[] = [];
  private index = 0;
  private bodySeen = false;
  private tilt = 0;
  private gazeX = 0;
  private gazeY = 0;
  private lift = 0;
  /** Union bbox of this frame's body primitives (virtual units). */
  private body = { x: 55, y: 60, w: 140, h: 145 };
  private groundX = 120;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly pixels: number,
  ) {}

  setPalette(palette: readonly RGB[]): void {
    this.palette = palette;
    this.colors = palette.map((c) => css(c));
    this.camera.scale = 1;
    this.camera.x = 0;
    this.camera.y = 0;
    this.lastCameraTime = 0;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.backdrop = ctx.createRadialGradient(
      this.pixels * 0.42,
      this.pixels * 0.32,
      0,
      this.pixels * 0.5,
      this.pixels * 0.5,
      this.pixels * 0.74,
    );
    this.backdrop.addColorStop(0, "#34424f");
    this.backdrop.addColorStop(0.6, "#212d38");
    this.backdrop.addColorStop(1, "#121a23");
    // Unit-space gradients: mapped onto each shape's box with ctx.transform().
    this.floor = ctx.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5);
    this.floor.addColorStop(0, css(RIM, 0.11));
    this.floor.addColorStop(0.7, css(RIM, 0.035));
    this.floor.addColorStop(1, css(RIM, 0));
    this.shadow = ctx.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5);
    this.shadow.addColorStop(0, "rgba(6,10,16,.5)");
    this.shadow.addColorStop(0.55, "rgba(6,10,16,.22)");
    this.shadow.addColorStop(1, "rgba(6,10,16,0)");
    this.lights = palette.map((rgb, i) => {
      const s = SHADING[i as Pal];
      if (!s) return undefined;
      const g = ctx.createRadialGradient(0.3, 0.22, 0, 0.38, 0.32, 0.92);
      g.addColorStop(0, css(tint(rgb, s[0])));
      g.addColorStop(0.36, css(tint(rgb, s[1])));
      g.addColorStop(0.72, css(tint(rgb, s[2] * 0.55)));
      g.addColorStop(0.9, css(tint(rgb, s[2])));
      g.addColorStop(1, css(mix(tint(rgb, s[2] * 0.6), RIM, s[3])));
      return g;
    });
  }

  /**
   * Start a frame: part tags and the pose for depth cues, and (when `framed`)
   * a camera that widens for a gesture's headroom and returns gently.
   */
  beginFrame(
    commands: readonly Cmd[],
    tags: readonly number[],
    pose: Pose,
    time: number,
    framed: boolean,
  ): void {
    this.tags = tags;
    this.index = 0;
    this.bodySeen = false;
    this.tilt = pose[BODY_TILT]!;
    this.gazeX = pose[GAZE_X]!;
    this.gazeY = pose[GAZE_Y]!;
    this.lift = pose[BODY_Y]!;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let radius = 1;
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i]!;
      if (framed) radius = Math.max(radius, cmdMaxDist(c, 120, 140));
      if (tags[i] !== PART.body) continue;
      if (c[0] === "ellipse") {
        x0 = Math.min(x0, c[1] - c[3]);
        y0 = Math.min(y0, c[2] - c[4]);
        x1 = Math.max(x1, c[1] + c[3]);
        y1 = Math.max(y1, c[2] + c[4]);
      } else if (c[0] === "roundRect") {
        x0 = Math.min(x0, c[1]);
        y0 = Math.min(y0, c[2]);
        x1 = Math.max(x1, c[1] + c[3]);
        y1 = Math.max(y1, c[2] + c[4]);
      }
    }
    if (x1 > x0 && y1 > y0) {
      this.body = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      this.groundX = (x0 + x1) / 2;
    }
    if (framed) {
      const goal = Math.min(1.45, 110 / (radius + 1));
      const amount = this.lastCameraTime
        ? Math.min(1, Math.max(0, time - this.lastCameraTime) / 300)
        : 1;
      this.camera.scale = Math.min(goal, this.camera.scale + (goal - this.camera.scale) * amount);
      this.camera.x = 120 - 120 * this.camera.scale;
      this.camera.y = 120 - 140 * this.camera.scale;
      this.lastCameraTime = time;
    }
  }

  /** Virtual-canvas transform including the camera. */
  private view(): void {
    const k = this.pixels / 240;
    const s = k * this.camera.scale;
    this.ctx.setTransform(s, 0, 0, s, k * this.camera.x, k * this.camera.y);
  }

  /** Part id of the primitive being drawn, advancing the cursor. */
  private nextPart(): number {
    const part = this.tags[this.index] ?? PART.none;
    this.index++;
    if (part === PART.body) this.bodySeen = true;
    return part;
  }

  /** Parallax offset for a part: back parts lag the tilt, the face leads the gaze. */
  private dx(part: number): number {
    if (BACK_PARTS.has(part) || (part === PART.limbs && !this.bodySeen))
      return -this.tilt * 0.45 - this.gazeX * 1.6;
    if (FACE_PARTS.has(part)) return this.gazeX * 0.9 + this.tilt * 0.2;
    return 0;
  }
  private dy(part: number): number {
    return FACE_PARTS.has(part) ? this.gazeY * 0.6 : 0;
  }

  /** Front limbs and accessories cast a soft shadow onto the body. */
  private casts(part: number, c: Pal): boolean {
    return c === OUTLINE && this.bodySeen && (part === PART.limbs || part === PART.accessory);
  }

  clear(_color: Pal): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.backdrop ?? "#202c36";
    ctx.fillRect(0, 0, this.pixels, this.pixels);
    this.view();
    // A quiet halo, a lit floor and a contact shadow give the pet a place to stand.
    ctx.strokeStyle = "rgba(190,220,231,.07)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(120, 120, 97, 0, TAU);
    ctx.stroke();
    const ground = 194;
    if (this.floor) {
      ctx.save();
      ctx.transform(180, 0, 0, 44, this.groundX - 90, ground - 22);
      ctx.fillStyle = this.floor;
      ctx.fillRect(0, 0, 1, 1);
      ctx.restore();
    }
    if (this.shadow) {
      // Higher off the ground: smaller, fainter, and pulled toward the light's shadow side.
      const up = Math.min(1, Math.max(0, -this.lift) / 60);
      const w = Math.max(20, this.body.w * 0.95) * (1 - up * 0.35);
      const h = w * 0.24;
      ctx.save();
      ctx.globalAlpha = 1 - up * 0.65;
      ctx.transform(w, 0, 0, h, this.groundX - w / 2 + this.tilt * 0.3 + 3, ground - h * 0.5);
      ctx.fillStyle = this.shadow;
      ctx.fillRect(0, 0, 1, 1);
      ctx.restore();
    }
    ctx.fillStyle = "rgba(212,232,239,.25)";
    for (const [x, y, r] of [
      [49, 71, 1],
      [187, 62, 0.8],
      [200, 136, 1],
      [62, 152, 0.6],
    ]) {
      ctx.beginPath();
      ctx.arc(x!, y!, r!, 0, TAU);
      ctx.fill();
    }
    this.index++;
  }

  /**
   * Paint the current path: lit with the slot's gradient mapped over its box, else flat.
   * Pass `strokeWidth` to stroke instead of fill.
   */
  private paint(c: Pal, x: number, y: number, w: number, h: number, strokeWidth = 0): void {
    const ctx = this.ctx;
    const g = this.lights[c];
    if (!g || w < 1.5 || h < 1.5) {
      if (strokeWidth > 0) {
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = this.colors[c] ?? "#f0f";
        ctx.stroke();
      } else {
        ctx.fillStyle = this.colors[c] ?? "#f0f";
        ctx.fill();
      }
      return;
    }
    if (c === BODY) {
      // Body pieces share one light field so overlapping shapes have no seams.
      x = this.body.x;
      y = this.body.y;
      w = this.body.w;
      h = this.body.h;
    }
    // The path is already in device space; only the paint style follows this transform.
    if (strokeWidth > 0) {
      // Strokes need a uniform scale so the line width stays right.
      const s = Math.max(w, h);
      ctx.transform(s, 0, 0, s, x - (s - w) / 2, y - (s - h) / 2);
      ctx.lineWidth = strokeWidth / s;
      ctx.strokeStyle = g;
      ctx.stroke();
    } else {
      ctx.transform(w, 0, 0, h, x, y);
      ctx.fillStyle = g;
      ctx.fill();
    }
    this.view();
  }

  private castShadow(): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(6,10,16,.2)";
    ctx.fill();
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: Pal): void {
    const part = this.nextPart();
    const ctx = this.ctx;
    cx += this.dx(part);
    cy += this.dy(part);
    this.view();
    if (this.casts(part, c)) {
      ctx.beginPath();
      ctx.ellipse(cx + 1.6, cy + 2.6, rx, ry, 0, 0, TAU);
      this.castShadow();
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    this.paint(c, cx - rx, cy - ry, rx * 2, ry * 2);
    if (c === DARK && part === PART.eyes && rx > 1.2) {
      // Specular glint on the pupil, opposite the light's shadow side.
      ctx.beginPath();
      ctx.ellipse(cx - rx * 0.34, cy - ry * 0.38, rx * 0.26, ry * 0.24, 0, 0, TAU);
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fill();
    }
  }

  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, c: Pal): void {
    const part = this.nextPart();
    x += this.dx(part);
    y += this.dy(part);
    r = Math.min(r, w / 2, h / 2);
    this.view();
    if (this.casts(part, c)) {
      this.roundRectPath(x + 1.6, y + 2.6, w, h, r);
      this.castShadow();
    }
    this.roundRectPath(x, y, w, h, r);
    this.paint(c, x, y, w, h);
  }

  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: Pal): void {
    const part = this.nextPart();
    const dx = this.dx(part);
    const dy = this.dy(part);
    const ctx = this.ctx;
    this.view();
    if (this.casts(part, c)) {
      ctx.beginPath();
      ctx.moveTo(x1 + dx + 1.6, y1 + dy + 2.6);
      ctx.lineTo(x2 + dx + 1.6, y2 + dy + 2.6);
      ctx.lineTo(x3 + dx + 1.6, y3 + dy + 2.6);
      ctx.closePath();
      this.castShadow();
    }
    ctx.beginPath();
    ctx.moveTo(x1 + dx, y1 + dy);
    ctx.lineTo(x2 + dx, y2 + dy);
    ctx.lineTo(x3 + dx, y3 + dy);
    ctx.closePath();
    const x = Math.min(x1, x2, x3) + dx;
    const y = Math.min(y1, y2, y3) + dy;
    this.paint(c, x, y, Math.max(x1, x2, x3) + dx - x, Math.max(y1, y2, y3) + dy - y);
  }

  line(x1: number, y1: number, x2: number, y2: number, width: number, c: Pal): void {
    const part = this.nextPart();
    const dx = this.dx(part);
    const dy = this.dy(part);
    const ctx = this.ctx;
    this.view();
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    if (this.casts(part, c)) {
      ctx.beginPath();
      ctx.moveTo(x1 + dx + 1.6, y1 + dy + 2.6);
      ctx.lineTo(x2 + dx + 1.6, y2 + dy + 2.6);
      ctx.strokeStyle = "rgba(6,10,16,.2)";
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x1 + dx, y1 + dy);
    ctx.lineTo(x2 + dx, y2 + dy);
    const hw = width / 2;
    const x = Math.min(x1, x2) + dx - hw;
    const y = Math.min(y1, y2) + dy - hw;
    this.paint(c, x, y, Math.abs(x2 - x1) + width, Math.abs(y2 - y1) + width, width);
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, width: number, c: Pal): void {
    const part = this.nextPart();
    cx += this.dx(part);
    cy += this.dy(part);
    const ctx = this.ctx;
    this.view();
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    // Browsers reduce angles modulo 2π; a sweep a hair under 2π can vanish, so draw full circles explicitly.
    if (a1 - a0 >= TAU - 1e-6) ctx.arc(cx, cy, r, 0, TAU);
    else ctx.arc(cx, cy, r, a0, a1);
    const R = r + width / 2;
    this.paint(c, cx - R, cy - R, R * 2, R * 2, width);
  }
}
