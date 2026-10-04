// Pose layers (PLAN 4.4): mood → idle → action → speech → needs.
// Everything here except the spring is a pure function of time.
import {
  ACTIONS,
  LOOKS,
  hash2,
  type Action,
  type LookDir,
  type Needs,
  type Temper,
} from "@tidbit/protocol";
import { ACTION_MS, ACTION_TRACKS } from "@tidbit/protocol/rig-data";
import {
  BLUSH,
  BODY_SQUASH,
  BODY_TILT,
  BODY_Y,
  EAR_ANGLE,
  EYE_OPEN,
  GAZE_X,
  GAZE_Y,
  MOUTH_CURVE,
  MOUTH_OPEN,
  N_CH,
  type Pose,
} from "./pose.js";

const TAU = Math.PI * 2;

export function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** 0..1 fraction from a hash, for seeded choices. */
function frac(seed: number, salt: number): number {
  return (hash2(seed, salt) % 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function actionDuration(action: Action): number {
  return ACTION_MS[ACTIONS.indexOf(action)] ?? 0;
}

export interface Track {
  readonly channel: number;
  readonly keys: readonly (readonly [number, number])[];
}

/** Add keyframe tracks at `elapsed` ms into `out` (cosine-eased between keys), scaled by `weight`. */
export function addTracks(tracks: readonly Track[], elapsed: number, out: Pose, weight = 1): void {
  for (const tr of tracks) {
    const keys = tr.keys;
    if (keys.length === 0) continue;
    let v = keys[keys.length - 1]![1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, v0] = keys[i]!;
      const [t1, v1] = keys[i + 1]!;
      if (elapsed >= t0 && elapsed <= t1) {
        const u = t1 > t0 ? (elapsed - t0) / (t1 - t0) : 1;
        v = v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
        break;
      }
    }
    if (elapsed < keys[0]![0]) v = keys[0]![1];
    out[tr.channel] = out[tr.channel]! + v * weight;
  }
}

/** Add the action's keyframe tracks at `elapsed` ms into `out`. */
export function addAction(action: Action, elapsed: number, out: Pose): void {
  const ai = ACTIONS.indexOf(action);
  const tracks = ACTION_TRACKS[ai];
  if (!tracks || elapsed < 0 || elapsed > (ACTION_MS[ai] ?? 0)) return;
  addTracks(tracks, elapsed, out);
}

// ---------------------------------------------------------------------------
// Look direction (part of the mood target, so it is smoothed)
// ---------------------------------------------------------------------------

export function addLook(look: LookDir, seed: number, out: Pose): void {
  switch (LOOKS.indexOf(look)) {
    case 1: // left (viewer's left)
      out[GAZE_X] = out[GAZE_X]! - 0.8;
      break;
    case 2: // right
      out[GAZE_X] = out[GAZE_X]! + 0.8;
      break;
    case 3: // up
      out[GAZE_Y] = out[GAZE_Y]! - 0.8;
      break;
    case 4: // down
      out[GAZE_Y] = out[GAZE_Y]! + 0.7;
      break;
    case 5: {
      // away: a seeded side, slightly down, body turned a little
      const side = frac(seed, 7) < 0.5 ? -1 : 1;
      out[GAZE_X] = out[GAZE_X]! + side * 0.9;
      out[GAZE_Y] = out[GAZE_Y]! + 0.3;
      out[BODY_TILT] = out[BODY_TILT]! + side * 3;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Idle (PLAN 4.4 layer 2): breathing, blinks, saccades, ear twitches, sway.
// ---------------------------------------------------------------------------

export interface IdleParams {
  seed: number;
  temper: Temper;
  /** Needs energy 0–100; low energy slows everything down. */
  energy: number;
  /** Reduce saccade amplitude while a beat asks the pal to look somewhere. */
  focused: boolean;
}

export function addIdle(t: number, p: IdleParams, out: Pose): void {
  const { seed, temper } = p;
  const speed = (0.75 + temper.energy * 0.05) * (0.6 + (0.4 * p.energy) / 100);
  const tt = t * speed;

  // Breathing.
  const breath = Math.sin((TAU * tt) / 3000);
  out[BODY_SQUASH] = out[BODY_SQUASH]! + 0.018 * breath;
  out[BODY_Y] = out[BODY_Y]! - 0.5 * breath;

  // Low-energy pals settle into their posture and occasionally yawn.
  if (p.energy < 25 && !p.focused) {
    const local = (tt + (hash2(seed, 81) % 15000)) % 15000;
    if (local < 1400) {
      const yawn = Math.sin((Math.PI * local) / 1400);
      out[MOUTH_OPEN] = out[MOUTH_OPEN]! + 0.4 * yawn;
      out[EYE_OPEN] = out[EYE_OPEN]! - 0.25 * yawn;
      out[BODY_TILT] = out[BODY_TILT]! - 2 * yawn;
    }
  }

  // Blinks at seeded points inside fixed slots; occasionally a double blink.
  const L = 3800;
  const k = Math.floor(tt / L);
  for (const kk of [k - 1, k]) {
    const off = 300 + (hash2(seed, 1000 + kk) % (L - 900));
    const double = hash2(seed, 2000 + kk) % 5 === 0;
    for (const o of double ? [off, off + 240] : [off]) {
      const local = tt - kk * L - o;
      if (local >= 0 && local < 160)
        out[EYE_OPEN] = out[EYE_OPEN]! - 1.3 * (1 - Math.abs(local - 80) / 80);
    }
  }

  // Gaze saccades: hold a seeded target per slot, ease into it quickly.
  const G = 1700;
  const g = Math.floor(tt / G);
  const shy = temper.shy / 9;
  const target = (slot: number): [number, number] => {
    const averted = frac(seed, 3000 + slot) < shy * 0.35;
    const amp = (0.25 + shy * 0.2) * (p.focused ? 0.35 : 1);
    if (averted && !p.focused) return [(frac(seed, 4000 + slot) < 0.5 ? -1 : 1) * 0.85, 0.4];
    return [(frac(seed, 5000 + slot) - 0.5) * 2 * amp, (frac(seed, 6000 + slot) - 0.5) * amp];
  };
  const [x1, y1] = target(g);
  const [x0, y0] = target(g - 1);
  const e = smoothstep((tt - g * G) / 120);
  out[GAZE_X] = out[GAZE_X]! + x0 + (x1 - x0) * e;
  out[GAZE_Y] = out[GAZE_Y]! + y0 + (y1 - y0) * e;

  // Occasional ear twitch.
  const W = 6100;
  const w = Math.floor(tt / W);
  if (hash2(seed, 7000 + w) % 3 === 0) {
    const local = tt - w * W - 1000;
    if (local >= 0 && local < 220)
      out[EAR_ANGLE] = out[EAR_ANGLE]! + 0.5 * Math.sin((Math.PI * local) / 220);
  }

  // Gentle sway; playful pals sway more and sometimes hop.
  const phase = frac(seed, 8) * TAU;
  out[BODY_TILT] =
    out[BODY_TILT]! + (0.6 + temper.playful * 0.12) * Math.sin((TAU * tt) / 5200 + phase);
  if (temper.playful >= 6) {
    const H = 9000;
    const hk = Math.floor(tt / H);
    if (hash2(seed, 9000 + hk) % 4 === 0) {
      const local = tt - hk * H - 2000;
      if (local >= 0 && local < 400)
        out[BODY_Y] = out[BODY_Y]! - 6 * Math.sin((Math.PI * local) / 400);
    }
  }
}

// ---------------------------------------------------------------------------
// Speech (layer 4) and needs (layer 5)
// ---------------------------------------------------------------------------

export function addSpeech(t: number, out: Pose): void {
  out[MOUTH_OPEN] = out[MOUTH_OPEN]! + 0.08 + 0.32 * Math.abs(Math.sin((Math.PI * t) / 140));
}

export function addNeeds(needs: Needs, out: Pose): void {
  if (needs.energy < 40) out[EYE_OPEN] = out[EYE_OPEN]! - ((40 - needs.energy) / 40) * 0.35;
  if (needs.hunger > 70) out[MOUTH_CURVE] = out[MOUTH_CURVE]! - ((needs.hunger - 70) / 30) * 0.2;
  if (needs.bond > 70) out[BLUSH] = out[BLUSH]! + ((needs.bond - 70) / 30) * 0.25;
}

/** "Waiting for the brain" layer: a slow look-up-and-around. */
export function addThinking(t: number, out: Pose): void {
  const side = Math.floor(t / 1500) % 2 === 0 ? 1 : -1;
  out[GAZE_X] = out[GAZE_X]! + side * 0.45;
  out[GAZE_Y] = out[GAZE_Y]! - 0.6;
  out[BODY_TILT] = out[BODY_TILT]! + side * 4;
  out[MOUTH_CURVE] = out[MOUTH_CURVE]! - 0.2;
}

// ---------------------------------------------------------------------------
// Spring: critically damped, integrated in fixed steps so the result depends
// only on the time and the target history, never on the frame rate.
// ---------------------------------------------------------------------------

export const SPRING_STEP_MS = 1000 / 120;

export class SpringPose {
  readonly x: Float64Array;
  private readonly v = new Float64Array(N_CH);
  private t: number | null = null;

  constructor(
    initial: Pose,
    private readonly omega: number,
  ) {
    this.x = Float64Array.from(initial);
  }

  /** Advance to time `t` (ms) chasing `targetAt(stepTime)`; large gaps snap. */
  advance(t: number, targetAt: (tMs: number) => Pose): void {
    if (this.t === null || t - this.t > 2000 || t < this.t) {
      // Align the step grid to absolute time so results depend only on t.
      this.t = Math.floor(t / SPRING_STEP_MS) * SPRING_STEP_MS;
      this.x.set(targetAt(this.t));
      this.v.fill(0);
      return;
    }
    const dt = SPRING_STEP_MS / 1000;
    const w = this.omega;
    while (this.t + SPRING_STEP_MS <= t) {
      this.t += SPRING_STEP_MS;
      const target = targetAt(this.t);
      for (let i = 0; i < N_CH; i++) {
        const a = -2 * w * this.v[i]! - w * w * (this.x[i]! - target[i]!);
        this.v[i] = this.v[i]! + a * dt;
        this.x[i] = this.x[i]! + this.v[i]! * dt;
      }
    }
  }
}
