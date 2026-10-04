// Effects (PLAN 4.5): small seeded particles built from the same primitives.
// Particles are a pure function of (fx, emitter start, duration, seed, t).
import { FXS, hash2, type Fx } from "@tidbit/protocol";
import type { FaceLayout, PalStatic } from "./pal.js";
import { OW, PART, SAFE_SAMPLING_MARGIN, maxSafeDistance, type Painter } from "./painter.js";
import { ACCENT, EYE_WHITE, FX, MAX_PARTICLES, OUTLINE, SAFE_R } from "./types.js";

const PI = Math.PI;

export interface Emitter {
  fx: Fx;
  start: number;
  duration: number;
}

interface Spec {
  /** ms between spawns; 0 = a single particle that lives for the whole emitter. */
  interval: number;
  max: number;
  life: number;
}

const SPECS: Record<Fx, Spec> = {
  none: { interval: 0, max: 0, life: 0 },
  hearts: { interval: 380, max: 6, life: 1600 },
  sparkles: { interval: 200, max: 8, life: 700 },
  zzz: { interval: 700, max: 4, life: 2000 },
  sweat: { interval: 900, max: 2, life: 900 },
  question: { interval: 0, max: 1, life: 0 },
  exclaim: { interval: 0, max: 1, life: 0 },
  notes: { interval: 420, max: 5, life: 1500 },
  anger: { interval: 0, max: 1, life: 0 },
  tears: { interval: 380, max: 6, life: 800 },
};

interface Particle {
  kind: number;
  /** 0..1 through its life. */
  u: number;
  age: number;
  i: number;
  salt: number;
}

/** Live particles at time t across emitters, newest first, capped at MAX_PARTICLES. */
export function liveParticles(emitters: Emitter[], seed: number, t: number): Particle[] {
  const out: Particle[] = [];
  for (const em of emitters) {
    const spec = SPECS[em.fx];
    if (!spec || spec.max === 0) continue;
    const kind = FXS.indexOf(em.fx);
    const salt = hash2(seed, Math.floor(em.start));
    if (spec.interval === 0) {
      const age = t - em.start;
      const life = Math.max(600, em.duration);
      if (age >= 0 && age < life) out.push({ kind, u: age / life, age, i: 0, salt });
      continue;
    }
    for (let i = 0; i < spec.max; i++) {
      const born = em.start + i * spec.interval;
      if (born >= em.start + Math.max(em.duration, spec.interval)) break;
      const age = t - born;
      if (age >= 0 && age < spec.life) out.push({ kind, u: age / spec.life, age, i, salt });
    }
  }
  out.sort((a, b) => a.age - b.age);
  return out.slice(0, MAX_PARTICLES);
}

function rnd(p: Particle, k: number): number {
  return (hash2(p.salt, p.i * 16 + k) % 10000) / 10000;
}

/** Grow in quickly, shrink out at the end of life. */
function pop(u: number): number {
  return Math.min(1, u * 6) * Math.min(1, (1 - u) * 5);
}

/**
 * Draw live particles. Each particle is committed only if all of it lies inside
 * the safe circle and within the draw budget; otherwise it is rolled back.
 */
export function drawParticles(
  p: Painter,
  st: PalStatic,
  f: FaceLayout,
  parts: Particle[],
  ink: number,
): void {
  p.part = PART.fx;
  const k = st.k * 1.35;
  const headY = f.top;
  for (const q of parts) {
    const mark = p.cmds.length;
    const dropped = p.dropped;
    const s = pop(q.u);
    if (s <= 0.05) continue;
    switch (FXS[q.kind]) {
      case "hearts": {
        const x = (rnd(q, 1) - 0.5) * f.bx * 1.6 + Math.sin(q.age / 180 + q.i) * 5 * k;
        const y = headY - 4 * k - q.u * 42 * k;
        heart(p, x, y, 5.5 * k * s);
        break;
      }
      case "sparkles": {
        const a = rnd(q, 1) * 2 * PI;
        const r = f.bx * (0.9 + rnd(q, 2) * 0.5);
        const x = Math.cos(a) * r;
        const y = -f.by + Math.sin(a) * f.by * 1.1;
        const len = 6 * k * Math.sin(PI * q.u);
        if (len > 0.5) {
          p.line(x - len, y, x + len, y, 2 * k, ACCENT);
          p.line(x, y - len, x, y + len, 2 * k, ACCENT);
        }
        break;
      }
      case "zzz": {
        const x = f.bx * 0.55 + q.u * 22 * k + q.i * 2 * k;
        const y = headY - q.u * 36 * k;
        const z = (3 + q.u * 4) * k * Math.min(1, (1 - q.u) * 4);
        zee(p, x, y, z, ink);
        break;
      }
      case "sweat": {
        const x = f.bx * 0.72;
        const y = -f.by * 1.45 + q.u * 12 * k;
        drop(p, x, y, 3.6 * k * s, ACCENT);
        break;
      }
      case "question": {
        const bob = Math.sin(q.age / 250) * 2 * k;
        glyphQuestion(p, f.bx * 0.7, headY - 6 * k + bob, 6 * k * Math.min(1, q.age / 150), ink);
        break;
      }
      case "exclaim": {
        const g = Math.min(1, q.age / 120);
        glyphExclaim(p, f.bx * 0.72, headY - 6 * k, 7 * k * g);
        break;
      }
      case "notes": {
        const side = q.i % 2 === 0 ? 1 : -1;
        const x = side * (f.bx * 0.7 + q.u * 12 * k) + Math.sin(q.age / 150) * 3 * k;
        const y = headY + 4 * k - q.u * 34 * k;
        note(p, x, y, 5 * k * s, ink);
        break;
      }
      case "anger": {
        const pulse = 1 + 0.15 * Math.sin(q.age / 90);
        vein(p, f.bx * 0.62, -f.by * 1.55, 5.5 * k * pulse * Math.min(1, q.age / 120));
        break;
      }
      case "tears": {
        const side = q.i % 2 === 0 ? -1 : 1;
        const x = f.faceX + side * (f.eyeX + f.erx * 0.7);
        const y = f.eyeY + f.ery * 0.6 + q.u * 20 * k;
        drop(p, x, y, 2.8 * k * Math.min(1, (1 - q.u) * 4), EYE_WHITE);
        break;
      }
    }
    // Roll back particles that would leave the safe circle or overflow the budget.
    let ok = p.dropped === dropped;
    if (ok && maxSafeDistance(p.cmds, mark) > SAFE_R - SAFE_SAMPLING_MARGIN) ok = false;
    if (!ok) {
      p.cmds.length = mark;
      p.tags.length = mark;
      p.dropped = dropped;
    }
  }
  p.part = PART.none;
}

function heart(p: Painter, x: number, y: number, r: number): void {
  if (r < 0.6) return;
  p.ellipse(x - r * 0.5, y, r * 0.62, r * 0.62, FX);
  p.ellipse(x + r * 0.5, y, r * 0.62, r * 0.62, FX);
  p.tri(x - r * 1.08, y + r * 0.18, x + r * 1.08, y + r * 0.18, x, y + r * 1.25, FX);
}

function drop(p: Painter, x: number, y: number, r: number, c: number): void {
  if (r < 0.6) return;
  p.tri(
    x - r * 0.95 - OW * 0.6,
    y + OW * 0.2,
    x + r * 0.95 + OW * 0.6,
    y + OW * 0.2,
    x,
    y - r * 2.2 - OW,
    OUTLINE,
  );
  p.ellipse(x, y + r * 0.25, r + OW * 0.6, r + OW * 0.6, OUTLINE);
  p.tri(x - r * 0.9, y, x + r * 0.9, y, x, y - r * 2, c);
  p.ellipse(x, y + r * 0.25, r, r, c);
}

function zee(p: Painter, x: number, y: number, s: number, ink: number): void {
  if (s < 0.8) return;
  const w = Math.max(1.2, s * 0.35);
  p.line(x - s, y - s, x + s, y - s, w, ink);
  p.line(x + s, y - s, x - s, y + s, w, ink);
  p.line(x - s, y + s, x + s, y + s, w, ink);
}

function glyphQuestion(p: Painter, x: number, y: number, s: number, ink: number): void {
  if (s < 0.8) return;
  const w = Math.max(1.5, s * 0.42);
  p.arc(x, y - s * 0.9, s * 0.75, PI * 1.05, PI * 2.35, w, ink);
  p.line(x + s * 0.2, y - s * 0.3, x, y + s * 0.35, w, ink);
  p.ellipse(x, y + s * 1.05, w * 0.6, w * 0.6, ink);
}

function glyphExclaim(p: Painter, x: number, y: number, s: number): void {
  if (s < 0.8) return;
  const w = Math.max(1.8, s * 0.45);
  p.line(x, y - s * 1.3, x, y + s * 0.3, w, FX);
  p.ellipse(x, y + s * 1.05, w * 0.6, w * 0.6, FX);
}

function note(p: Painter, x: number, y: number, s: number, ink: number): void {
  if (s < 0.8) return;
  const w = Math.max(1.2, s * 0.3);
  p.ellipse(x, y, s * 0.7, s * 0.55, ink);
  p.line(x + s * 0.6, y, x + s * 0.6, y - s * 2.2, w, ink);
  p.line(x + s * 0.6, y - s * 2.2, x + s * 1.4, y - s * 1.6, w, ink);
}

/** The manga "anger vein": four bent strokes around a centre. */
function vein(p: Painter, x: number, y: number, s: number): void {
  if (s < 0.8) return;
  const w = Math.max(1.5, s * 0.35);
  const r = s * 0.55;
  const d = s * 0.75;
  p.arc(x - d, y - d, r, 0, PI / 2, w, FX);
  p.arc(x + d, y - d, r, PI / 2, PI, w, FX);
  p.arc(x + d, y + d, r, PI, PI * 1.5, w, FX);
  p.arc(x - d, y + d, r, PI * 1.5, PI * 2, w, FX);
}
