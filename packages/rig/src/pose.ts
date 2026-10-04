import { MOODS, POSE_CHANNELS, type Mood } from "@tidbit/protocol";
import {
  INTENSITY_SCALE,
  MOOD_POSE,
  POSE_MAX,
  POSE_MIN,
  POSE_NEUTRAL,
} from "@tidbit/protocol/rig-data";

export const N_CH = POSE_CHANNELS.length;
export type Pose = Float64Array;

export const EYE_OPEN = 0;
export const EYE_SQUINT = 1;
export const BROW_ANGLE = 2;
export const BROW_RAISE = 3;
export const PUPIL_SIZE = 4;
export const GAZE_X = 5;
export const GAZE_Y = 6;
export const MOUTH_CURVE = 7;
export const MOUTH_OPEN = 8;
export const BODY_Y = 9;
export const BODY_SQUASH = 10;
export const BODY_TILT = 11;
export const EAR_ANGLE = 12;
export const BLUSH = 13;
export const FLIP_X = 14;
export const ARM_L = 15;
export const ARM_R = 16;

export function neutralPose(): Pose {
  return Float64Array.from(POSE_NEUTRAL);
}

/** Neutral plus the mood's delta scaled by intensity (1–3). */
export function moodPose(mood: Mood, intensity: number, out: Pose = neutralPose()): Pose {
  const row = MOOD_POSE[MOODS.indexOf(mood)] ?? MOOD_POSE[0]!;
  const k = INTENSITY_SCALE[Math.min(2, Math.max(0, Math.round(intensity) - 1))] ?? 1;
  for (let i = 0; i < N_CH; i++) out[i] = POSE_NEUTRAL[i]! + row[i]! * k;
  return clampPose(out);
}

export function clampPose(p: Pose): Pose {
  for (let i = 0; i < N_CH; i++) {
    const v = p[i]!;
    p[i] = Number.isFinite(v)
      ? Math.min(POSE_MAX[i]!, Math.max(POSE_MIN[i]!, v))
      : POSE_NEUTRAL[i]!;
  }
  return p;
}
