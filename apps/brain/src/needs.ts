// Needs simulation (PLAN 5.6): a pure function, no LLM.
import type { Bond, Needs, TouchKind } from "@tidbit/protocol";

export type NeedsEvent =
  { kind: "touch"; touch: TouchKind } | { kind: "bond"; bond: Bond } | { kind: "talk" };

/** Per-hour drift rates. */
export const DRIFT = {
  hungerPerHour: 4,
  /** Energy falls while the owner is awake… */
  energyDayPerHour: -3,
  /** …and recovers overnight. */
  energyNightPerHour: 8,
  bondPerHour: -0.5,
  nightStartHour: 22,
  nightEndHour: 7,
};

const EFFECTS: Record<string, Partial<Needs>> = {
  feed: { hunger: -30, energy: 5, bond: 1 },
  pet: { bond: 3 },
  poke: { bond: 0.5 },
  shake: { bond: -1, energy: -2 },
  up: { bond: 4 },
  down: { bond: -4 },
  same: {},
  talk: { energy: -0.5, bond: 0.5 },
};

const clamp = (v: number) => Math.min(100, Math.max(0, v));

export function isNight(hour: number): boolean {
  return hour >= DRIFT.nightStartHour || hour < DRIFT.nightEndHour;
}

/**
 * Advance needs from `startMs` by `elapsedMs` of drift, then apply events.
 * `hourAt` maps an epoch time to the local hour (injectable for tests).
 */
export function stepNeeds(
  needs: Needs,
  startMs: number,
  elapsedMs: number,
  events: readonly NeedsEvent[] = [],
  hourAt: (ms: number) => number = (ms) => new Date(ms).getHours(),
): Needs {
  let { energy, hunger, bond } = needs;
  const STEP = 15 * 60_000;
  let t = startMs;
  let left = Math.max(0, elapsedMs);
  // Integrate in 15-minute slices so day/night boundaries are respected.
  while (left > 0) {
    const dt = Math.min(STEP, left);
    const h = dt / 3_600_000;
    hunger += DRIFT.hungerPerHour * h;
    energy += (isNight(hourAt(t)) ? DRIFT.energyNightPerHour : DRIFT.energyDayPerHour) * h;
    bond += DRIFT.bondPerHour * h;
    t += dt;
    left -= dt;
  }
  for (const e of events) {
    const key = e.kind === "touch" ? e.touch : e.kind === "bond" ? e.bond : "talk";
    const fx = EFFECTS[key] ?? {};
    energy += fx.energy ?? 0;
    hunger += fx.hunger ?? 0;
    bond += fx.bond ?? 0;
  }
  return { energy: clamp(energy), hunger: clamp(hunger), bond: clamp(bond) };
}

/** Needs as sent on the wire: integers 0–100. */
export function roundNeeds(n: Needs): Needs {
  return { energy: Math.round(n.energy), hunger: Math.round(n.hunger), bond: Math.round(n.bond) };
}
