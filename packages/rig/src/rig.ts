import {
  ACTIONS,
  FXS,
  LOOKS,
  MOODS,
  TOUCH_KINDS,
  DEFAULT_NEEDS,
  normalizeNeeds,
  normalizeTurn,
  type Beat,
  type DNA,
  type Needs,
  type TouchKind,
  type Turn,
} from "@tidbit/protocol";
import { RIG_CONSTANTS, TOUCH_REACTIONS } from "@tidbit/protocol/rig-data";
import {
  SpringPose,
  actionDuration,
  addAction,
  addTracks,
  addIdle,
  addLook,
  addNeeds,
  addSpeech,
  addThinking,
  smoothstep,
} from "./animate.js";
import {
  ACTIVITY_DEFS,
  CUT_MS,
  GRACE_MS,
  SLOT_MS,
  scheduledActivity,
  type Activity,
  type ActivityDef,
  type PropScene,
} from "./activities.js";
import { drawParticles, liveParticles, type Emitter } from "./fx.js";
import {
  GROUND_Y,
  PART,
  Painter,
  SAFE_SAMPLING_MARGIN,
  cmdPoints,
  maxSafeDistance,
  scaleAboutSafeCentre,
} from "./painter.js";
import { buildStatic, drawPal, faceLayout, type PalStatic } from "./pal.js";
import { contrast, derivePalette } from "./palette.js";
import {
  ARM_L,
  ARM_R,
  BODY_SQUASH,
  BODY_TILT,
  BODY_Y,
  EAR_ANGLE,
  GAZE_X,
  GAZE_Y,
  EYE_OPEN,
  MOUTH_OPEN,
  MOUTH_CURVE,
  FLIP_X,
  N_CH,
  clampPose,
  moodPose,
  neutralPose,
  type Pose,
} from "./pose.js";
import {
  BG,
  EYE_WHITE,
  OUTLINE,
  SAFE_R,
  SAFE_X,
  SAFE_Y,
  replay,
  type Cmd,
  type DrawTarget,
  type RGB,
} from "./types.js";

const K = RIG_CONSTANTS;

export interface RigStatus {
  /** The conversational beat currently playing (touch reactions are not reported). */
  beat: Beat | null;
  index: number;
  count: number;
  elapsedMs: number;
  durationMs: number;
  /** Characters of `beat.say` revealed so far (typewriter sync). */
  typed: number;
  /** True until the last beat of the current turn has finished. */
  busy: boolean;
  /** Idle activity in progress (paper plane, bicycle, ...), if any. */
  activity: Activity | null;
}

export interface Rig {
  readonly dna: DNA;
  readonly palette: readonly RGB[];
  /** Fit scale chosen for this DNA (≤ 1). */
  readonly fit: number;
  /** Queue a turn's beats starting at `atMs` (default: the last frame time). Replaces any turn in progress. */
  apply(turn: Turn, atMs?: number): void;
  /** Instant local reaction, no LLM (PLAN 5.8). */
  touch(kind: TouchKind, atMs?: number): void;
  setNeeds(needs: Needs): void;
  /** Normalized pointer or input focus. Smoothed with the expression, not a pose override. */
  setAttention(x: number | null, y?: number): void;
  setTyping(on: boolean): void;
  setPersonality(profile: import("@tidbit/protocol").Personality): void;
  setRestMood(mood: import("@tidbit/protocol").Mood | null): void;
  /** Host is waiting for the brain. */
  setThinking(on: boolean): void;
  /** Host reports speech in progress (e.g. TTS); beats with text also flap automatically. */
  setSpeaking(on: boolean): void;
  status(tMs?: number): RigStatus;
  frame(tMs: number, target: DrawTarget): void;
  /** Render one frame into a command list (tests, conformance, simulator). */
  commands(tMs: number): Cmd[];
  /** Part ids (see PART) for the commands of the last frame. */
  readonly tags: readonly number[];
  /** Diagnostics for the last frame. */
  readonly stats: { dropped: number; netScale: number; particles: number };
  /** Bypass animation and draw exactly this pose (tests, static thumbnails). */
  setPose(pose: Pose | null): void;
  /** Growth stage (M6): 0 baby, 1 kid, 2 grown (default). Re-proportions the pal. */
  setGrowth(stage: number): void;
  readonly growth: number;
  /** Start an idle activity now (playground, tests), or `null` to stop the current one. */
  setActivity(activity: Activity | null, atMs?: number): void;
  /** The pose drawn by the last frame (hosts use it for depth cues). */
  readonly pose: Pose;
}

/** Overall scale per growth stage (baby, kid, grown). */
export const GROWTH_SCALE: readonly number[] = [0.8, 0.9, 1];

/** Baby pals are smaller, rounder, with bigger eyes; all within the normal DNA ranges. */
export function grownLook(dna: DNA, stage: number): DNA {
  const d = 2 - Math.max(0, Math.min(2, Math.round(stage)));
  if (d === 0) return dna;
  const clamp = (v: number) => Math.max(0, Math.min(9, v));
  return {
    ...dna,
    look: {
      ...dna.look,
      size: clamp(dna.look.size - 2 * d),
      eyeSize: clamp(dna.look.eyeSize + 2 * d),
      plump: clamp(dna.look.plump + d),
      eyeGap: clamp(dna.look.eyeGap - d),
    },
  };
}

interface Scheduled {
  beat: Beat;
  start: number;
  dur: number;
}

export function beatDuration(beat: Beat): number {
  return Math.max(
    actionDuration(beat.action),
    K.beatBaseMs + K.beatPerCharMs * Array.from(beat.say).length,
  );
}

/** Largest scale ≤ 1 at which the pal plus motion headroom fits the safe circle. */
function computeFit(st: PalStatic): number {
  const probe = new Painter();
  probe.budget = 10_000;
  // Extremes of every channel that moves parts outward: squash, arms, ears, tilt.
  for (const q of [-0.25, 0.25]) {
    for (const ear of [-1, 1]) {
      for (const tilt of [-15, 0, 15]) {
        const pose = neutralPose();
        pose[BODY_SQUASH] = q;
        pose[EAR_ANGLE] = ear;
        pose[ARM_L] = 1;
        pose[ARM_R] = 1;
        probe.setTransform(1, tilt, 1, 0);
        drawPal(probe, st, pose);
      }
    }
  }
  const offsets: [number, number][] = [
    [0, 0],
    [0, -K.jumpHeadroom],
    [K.sideHeadroom, 0],
    [-K.sideHeadroom, 0],
  ];
  // For each sampled point v (relative to the ground point), the largest s with
  // |c + s·v| ≤ R, where c is the ground point relative to the safe centre.
  const R = SAFE_R - K.fitMargin;
  const cx = 120 - SAFE_X;
  const cy = GROUND_Y - SAFE_Y;
  const cc = cx * cx + cy * cy - R * R;
  let fit = 1;
  for (const cmd of probe.cmds) {
    for (const [x, y] of cmdPoints(cmd, 16)) {
      for (const [ox, oy] of offsets) {
        const vx = x - 120 + ox;
        const vy = y - GROUND_Y + oy;
        const vv = vx * vx + vy * vy;
        if (vv === 0) continue;
        const cv = cx * vx + cy * vy;
        const s = (-cv + Math.sqrt(cv * cv - vv * cc)) / vv;
        if (s < fit) fit = s;
      }
    }
  }
  return Math.max(0.3, fit);
}

export function createRig(dna: DNA): Rig {
  let growth = 2;
  let st = buildStatic(dna);
  const palette = derivePalette(dna.look.hue, dna.look.scheme, dna.seed);
  let fit = computeFit(st);
  // Glyph colour for effects: the outline if it reads on the background, else eye white.
  const ink = contrast(palette[OUTLINE]!, palette[BG]!) >= 3 ? OUTLINE : EYE_WHITE;
  const painter = new Painter();
  const stats = { dropped: 0, netScale: 1, particles: 0 };

  let now = 0;
  let beats: Scheduled[] = [];
  let touchBeat: Scheduled | null = null;
  let needs: Needs = { ...DEFAULT_NEEDS };
  let thinking = false;
  let speakingHost = false;
  let override: Pose | null = null;

  let temper = { ...dna.temper };
  let motionTemper = temper;
  interface Live {
    name: Activity;
    def: ActivityDef;
    start: number;
    /** Set when interrupted; the pose fades out over CUT_MS. */
    cut: number | null;
  }
  let activity: Live | null = null;
  /** Last slot whose activity started or was skipped. */
  let doneSlot = -1;
  let lastT = -Infinity;
  const lastPose = new Float64Array(N_CH);
  const updateComfort = () => {
    motionTemper = { ...temper, shy: temper.shy * (1 - Math.max(0, needs.bond - 60) / 160) };
  };
  let attention: { x: number; y: number } | null = null;
  let typingHost = false;
  let touchKind: TouchKind | null = null;
  const basePose = moodPose(dna.baseMood, 1);
  const spring = new SpringPose(basePose, K.springOmega);
  const target = new Float64Array(N_CH);
  const from = new Float64Array(N_CH);

  const lastEnd = () =>
    beats.length ? beats[beats.length - 1]!.start + beats[beats.length - 1]!.dur : -Infinity;

  function beatAt(t: number): { s: Scheduled; index: number } | null {
    for (let i = 0; i < beats.length; i++) {
      const s = beats[i]!;
      if (t >= s.start && t < s.start + s.dur) return { s, index: i };
    }
    return null;
  }

  function activeAt(t: number): Scheduled | null {
    if (touchBeat && t >= touchBeat.start && t < touchBeat.start + touchBeat.dur) return touchBeat;
    return beatAt(t)?.s ?? null;
  }

  /** Contribution of the activity at t: 1 while playing, fading after a cut, 0 when none. */
  function activityWeight(t: number): number {
    if (!activity) return 0;
    const e = t - activity.start;
    if (e < 0 || e > activity.def.ms) return 0;
    if (activity.cut === null) return 1;
    return 1 - smoothstep((t - activity.cut) / CUT_MS);
  }

  function cutActivity(t: number): void {
    if (activity && activity.cut === null) activity.cut = t;
  }

  function startActivity(name: Activity, at: number): void {
    activity = { name, def: ACTIVITY_DEFS[name], start: at, cut: null };
  }

  /** Advance the activity state machine to t: end finished ones, start the slot's when idle. */
  function updateActivity(t: number): void {
    if (t < lastT - 2000) {
      // Time went backwards (tests, a re-seated clock): forget the schedule.
      activity = null;
      doneSlot = -1;
    }
    lastT = t;
    if (activity) {
      const e = t - activity.start;
      const cutDone = activity.cut !== null && t - activity.cut >= CUT_MS;
      if (e < 0 || e > activity.def.ms || cutDone) activity = null;
      else return;
    }
    const slot = Math.floor(t / SLOT_MS);
    if (slot <= doneSlot) return;
    const next = scheduledActivity(dna.seed, temper, st, slot);
    if (!next) {
      doneSlot = slot;
      return;
    }
    if (t < next.start) return;
    if (t - next.start > GRACE_MS) {
      doneSlot = slot;
      return;
    }
    const idle =
      !override &&
      !thinking &&
      !typingHost &&
      !activeAt(t) &&
      t >= lastEnd() + K.decayMs &&
      needs.energy >= 30;
    if (!idle) return;
    doneSlot = slot;
    startActivity(next.activity, next.start);
  }

  function beatPose(b: Beat, out: Pose): Pose {
    moodPose(b.mood, b.intensity, out);
    addLook(b.look, dna.seed, out);
    return out;
  }

  /** The smoothed layers: mood (with look), decay to base, needs, thinking. */
  function targetAt(t: number): Pose {
    const a = activeAt(t);
    if (a) beatPose(a.beat, target);
    else if (beats.length && t >= lastEnd()) {
      const u = smoothstep((t - lastEnd()) / K.decayMs);
      beatPose(beats[beats.length - 1]!.beat, from);
      for (let i = 0; i < N_CH; i++) target[i] = from[i]! + (basePose[i]! - from[i]!) * u;
    } else target.set(basePose);
    addNeeds(needs, target);
    if (thinking && !a) addThinking(t, target);
    if (!thinking && !activity && (!a || a.beat.look === "user")) {
      if (typingHost) {
        target[GAZE_X] = 0.35;
        target[GAZE_Y] = 0.7;
      } else if (attention) {
        target[GAZE_X] = attention.x * (1 - motionTemper.shy * 0.025);
        target[GAZE_Y] = attention.y * 0.75;
      }
    }
    if (a && a === touchBeat && touchKind === "pet") {
      target[BODY_TILT] = (attention?.x ?? 0.3) * 9;
      target[EYE_OPEN] = 0.35;
      target[MOUTH_CURVE] = 0.7;
    }
    if (a && a === touchBeat && touchKind === "poke") target[BODY_SQUASH] = 0.18;
    if (!a && needs.energy < 25) {
      target[BODY_Y] = target[BODY_Y]! + 3;
      target[BODY_TILT] = target[BODY_TILT]! - 3;
    }
    if (!a && !typingHost && !attention && temper.curious >= 7 && needs.energy > 35)
      target[EAR_ANGLE] = target[EAR_ANGLE]! + 0.12;
    return target;
  }

  function currentPose(t: number): Pose {
    if (override) return override;
    spring.advance(t, targetAt);
    const pose = Float64Array.from(spring.x);
    const a = activeAt(t);
    addIdle(
      t,
      {
        seed: dna.seed,
        temper: motionTemper,
        energy: needs.energy,
        focused: typingHost || !!attention || (!!a && a.beat.look !== "user"),
      },
      pose,
    );
    if (a) addAction(a.beat.action, t - a.start, pose);
    const aw = activityWeight(t);
    if (activity && aw > 0) {
      const e = t - activity.start;
      addTracks(activity.def.tracks, e, pose, aw);
      activity.def.pose?.(e, pose, faceLayout(st, pose), st.k, aw);
    }
    const typing =
      a &&
      a !== touchBeat &&
      a.beat.say.length > 0 &&
      t - a.start < Array.from(a.beat.say).length * K.typeCharMs;
    if (a && a === touchBeat && touchKind === "feed")
      pose[MOUTH_OPEN] = pose[MOUTH_OPEN]! + 0.3 * Math.abs(Math.sin((t - a.start) / 90));
    if (speakingHost || typing) addSpeech(t, pose);
    return clampPose(pose);
  }

  /** Draw one prop group; roll it back if any of it leaves the safe circle or the budget. */
  function drawProps(scene: PropScene, draw: ((s: PropScene) => void) | undefined): void {
    if (!draw) return;
    const cmds = painter.cmds;
    const mark = cmds.length;
    const dropped = painter.dropped;
    painter.part = PART.prop;
    draw(scene);
    painter.part = PART.none;
    let ok = painter.dropped === dropped;
    if (ok && maxSafeDistance(cmds, mark) > SAFE_R - SAFE_SAMPLING_MARGIN) ok = false;
    if (!ok) {
      cmds.length = mark;
      painter.tags.length = mark;
      painter.dropped = dropped;
    }
  }

  function render(t: number): Cmd[] {
    now = t;
    updateActivity(t);
    const pose = currentPose(t);
    lastPose.set(pose);
    painter.reset();
    painter.raw(["clear", BG]);
    const live = activity && activityWeight(t) >= 1 ? activity : null;
    const elapsed = live ? t - live.start : 0;
    const shift = live?.def.shift ? live.def.shift(elapsed) : 0;
    const bodySpace = () =>
      painter.setTransform(fit, pose[BODY_TILT]!, pose[FLIP_X]!, pose[BODY_Y]!, shift);
    const groundSpace = () => painter.setTransform(fit, 0, pose[FLIP_X]!, 0, shift);
    bodySpace();
    const scene: PropScene | null = live
      ? {
          p: painter,
          st,
          f: faceLayout(st, pose),
          pose,
          elapsed,
          k: st.k,
          body: bodySpace,
          ground: groundSpace,
        }
      : null;
    if (scene && live) drawProps(scene, live.def.back);
    bodySpace();
    const face = drawPal(painter, st, pose);
    if (scene && live) drawProps(scene, live.def.front);
    bodySpace();

    const emitters: Emitter[] = [];
    for (const s of beats)
      if (s.beat.fx !== "none") emitters.push({ fx: s.beat.fx, start: s.start, duration: s.dur });
    if (touchBeat && touchBeat.beat.fx !== "none")
      emitters.push({ fx: touchBeat.beat.fx, start: touchBeat.start, duration: touchBeat.dur });
    const parts = liveParticles(emitters, dna.seed, t);
    const before = painter.cmds.length;
    drawParticles(painter, st, face, parts, ink);
    stats.particles = parts.length;

    // Safety net: nothing may leave the safe circle, whatever the pose.
    const cmds = painter.cmds;
    const limit = SAFE_R - SAFE_SAMPLING_MARGIN;
    const d = maxSafeDistance(cmds, 0, before);
    stats.netScale = 1;
    if (d > limit) {
      stats.netScale = limit / d;
      scaleAboutSafeCentre(cmds, stats.netScale);
    }
    stats.dropped = painter.dropped;
    return cmds;
  }

  return {
    dna,
    palette,
    get fit() {
      return fit;
    },
    stats,
    get tags() {
      return painter.tags;
    },
    apply(turn, atMs = now) {
      cutActivity(atMs);
      const clean = normalizeTurn(turn, dna.baseMood);
      let t = atMs;
      beats = clean.beats.map((beat) => {
        const s = { beat, start: t, dur: beatDuration(beat) };
        t += s.dur;
        return s;
      });
    },
    touch(kind, atMs = now) {
      cutActivity(atMs);
      touchKind = kind;
      const row = TOUCH_REACTIONS[Math.max(0, TOUCH_KINDS.indexOf(kind))]!;
      const grumpy = temper.grumpy >= K.grumpyThreshold;
      const beat: Beat = {
        mood: MOODS[row[grumpy ? 5 : 0]!]!,
        intensity: row[1]!,
        say: "",
        action: kind === "feed" ? "eat" : ACTIONS[row[grumpy ? 6 : 2]!]!,
        look: LOOKS[row[4]!]!,
        fx: FXS[row[grumpy ? 7 : 3]!]!,
      };
      touchBeat = { beat, start: atMs, dur: Math.max(actionDuration(beat.action), K.touchMs) };
    },
    setAttention(x, y = 0) {
      attention =
        x === null || !Number.isFinite(x) || !Number.isFinite(y)
          ? null
          : { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    },
    setTyping(on) {
      typingHost = on;
      if (on) cutActivity(now);
    },
    setPersonality(profile) {
      temper = { ...dna.temper };
      if (profile.speech === "quiet") {
        temper.shy = Math.max(7, temper.shy);
        temper.energy = Math.min(4, temper.energy);
      }
      if (profile.speech === "animated") {
        temper.energy = Math.max(7, temper.energy);
        temper.playful = Math.max(6, temper.playful);
      }
      if (profile.humor === "silly") temper.playful = Math.max(7, temper.playful);
      if (profile.humor === "dry") temper.grumpy = Math.max(7, temper.grumpy);
      updateComfort();
    },
    setRestMood(mood) {
      moodPose(mood ?? dna.baseMood, 1, basePose);
    },
    setNeeds(n) {
      needs = normalizeNeeds(n);
      updateComfort();
    },
    setThinking(on) {
      thinking = on;
      if (on) cutActivity(now);
    },
    setActivity(name, atMs = now) {
      if (name === null) cutActivity(atMs);
      else startActivity(name, atMs);
    },
    get pose() {
      return lastPose;
    },
    setSpeaking(on) {
      speakingHost = on;
    },
    status(tMs = now) {
      const cur = beatAt(tMs);
      if (!cur)
        return {
          beat: null,
          index: -1,
          count: beats.length,
          elapsedMs: 0,
          durationMs: 0,
          typed: 0,
          busy: tMs < lastEnd(),
          activity: activity && activityWeight(tMs) > 0 ? activity.name : null,
        };
      const elapsed = tMs - cur.s.start;
      const len = Array.from(cur.s.beat.say).length;
      return {
        beat: cur.s.beat,
        index: cur.index,
        count: beats.length,
        elapsedMs: elapsed,
        durationMs: cur.s.dur,
        typed: Math.min(len, Math.floor(elapsed / K.typeCharMs) + 1),
        busy: true,
        activity: null,
      };
    },
    commands: (t) => render(t).slice(),
    frame(t, drawTarget) {
      replay(render(t), drawTarget);
    },
    setPose(pose) {
      override = pose;
    },
    get growth() {
      return growth;
    },
    setGrowth(stage) {
      const next = Math.max(0, Math.min(2, Math.round(stage)));
      if (next === growth) return;
      growth = next;
      st = buildStatic(grownLook(dna, growth));
      // Size alone can be cancelled by the fit, so younger stages also scale down.
      // Shrinking about the ground point only moves shapes further inside the safe circle.
      fit = computeFit(st) * GROWTH_SCALE[growth]!;
    },
  };
}
