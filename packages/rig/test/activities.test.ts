import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { loadDnaFixtures } from "@tidbit/protocol/fixtures";
import {
  ACTIVITIES,
  ACTIVITY_SLOT_MS,
  PART,
  activityDuration,
  buildStatic,
  createRig,
  scheduledActivity,
} from "../src/index.js";
import { FC_SEED, arbDna } from "./arb.js";
import { checkFrame } from "./check-frame.js";

const FRACTIONS = [0.02, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.97];

describe("idle activities", () => {
  it("600 DNAs × every activity stay valid and inside the budget", () => {
    let frames = 0;
    fc.assert(
      fc.property(arbDna, (dna) => {
        const rig = createRig(dna);
        let t0 = 100_000;
        for (const name of ACTIVITIES) {
          rig.setActivity(name, t0);
          const dur = activityDuration(name);
          for (const f of FRACTIONS) {
            const t = t0 + dur * f;
            const bad = checkFrame(rig.commands(t), rig.tags);
            frames++;
            if (bad.length)
              throw new Error(`${name} @${Math.round(dur * f)}ms: ${bad.slice(0, 3).join("; ")}`);
            if (rig.stats.dropped) throw new Error(`${name}: dropped ${rig.stats.dropped}`);
          }
          t0 += dur + 500;
        }
      }),
      { numRuns: 600, seed: FC_SEED },
    );
    expect(frames).toBe(600 * ACTIVITIES.length * FRACTIONS.length);
  }, 180_000);

  it("every prop activity draws props for every fixture", () => {
    const withProps = ACTIVITIES.filter((a) => !["stretch", "chaseTail"].includes(a));
    for (const { name, value: dna } of loadDnaFixtures()) {
      const rig = createRig(dna);
      let t0 = 50_000;
      for (const a of withProps) {
        rig.setActivity(a, t0);
        let props = 0;
        const dur = activityDuration(a);
        for (const f of FRACTIONS) {
          rig.commands(t0 + dur * f);
          props += rig.tags.filter((tag) => tag === PART.prop).length;
        }
        expect(props, `${name}/${a}`).toBeGreaterThan(0);
        t0 += dur + 500;
      }
    }
  });

  it("reports the activity in status and clears it when it ends", () => {
    const rig = createRig(loadDnaFixtures()[0]!.value);
    rig.setActivity("paperPlane", 1000);
    rig.commands(1500);
    expect(rig.status(1500).activity).toBe("paperPlane");
    const end = 1000 + activityDuration("paperPlane");
    rig.commands(end + 10);
    expect(rig.status(end + 10).activity).toBeNull();
  });

  it("a turn, a touch, typing or thinking cut the activity and it fades within 300 ms", () => {
    const dna = loadDnaFixtures()[2]!.value;
    const cuts: ((rig: ReturnType<typeof createRig>) => void)[] = [
      (rig) =>
        rig.apply(
          {
            v: 1,
            beats: [
              { mood: "happy", intensity: 2, say: "hi", action: "nod", look: "user", fx: "none" },
            ],
            bond: "same",
          },
          2000,
        ),
      (rig) => rig.touch("poke", 2000),
      (rig) => rig.setTyping(true),
      (rig) => rig.setThinking(true),
    ];
    for (const cut of cuts) {
      const rig = createRig(dna);
      rig.setActivity("bicycle", 0);
      rig.commands(2000);
      expect(rig.status(2000).activity).toBe("bicycle");
      cut(rig);
      rig.commands(2001);
      // Props vanish at once; the pose fades.
      expect(rig.tags.filter((t) => t === PART.prop)).toHaveLength(0);
      rig.commands(2400);
      expect(rig.status(2400).activity).toBeNull();
    }
  });

  it("starts scheduled activities on its own only when idle, and everyone sees the same one", () => {
    const { value: dna } = loadDnaFixtures()[3]!;
    const st = buildStatic(dna);
    // Find a slot with an activity.
    let slot = 0;
    let sched = scheduledActivity(dna.seed, dna.temper, st, slot);
    while (!sched && slot < 20) sched = scheduledActivity(dna.seed, dna.temper, st, ++slot);
    expect(sched).not.toBeNull();
    const { activity, start } = sched!;
    expect(start).toBeGreaterThanOrEqual(slot * ACTIVITY_SLOT_MS);
    expect(start + activityDuration(activity)).toBeLessThan((slot + 1) * ACTIVITY_SLOT_MS);

    const a = createRig(dna);
    const b = createRig(dna);
    for (const t of [start - 10, start + 50]) {
      expect(a.commands(t)).toEqual(b.commands(t));
    }
    expect(a.status(start + 50).activity).toBe(activity);
    expect(b.status(start + 50).activity).toBe(activity);

    // Busy pals skip the slot rather than playing it late.
    const busy = createRig(dna);
    busy.setThinking(true);
    busy.commands(start + 50);
    expect(busy.status(start + 50).activity).toBeNull();
    busy.setThinking(false);
    busy.commands(start + 1000);
    expect(busy.status(start + 1000).activity).toBeNull();

    // Tired pals rest instead.
    const tired = createRig(dna);
    tired.setNeeds({ energy: 10, hunger: 10, bond: 50 });
    tired.commands(start + 50);
    expect(tired.status(start + 50).activity).toBeNull();
  });

  it("every activity is chosen for some pal", () => {
    const seen = new Set<string>();
    for (const { value: dna } of loadDnaFixtures()) {
      const st = buildStatic(dna);
      for (let slot = 0; slot < 60; slot++) {
        const s = scheduledActivity(dna.seed, dna.temper, st, slot);
        if (s) seen.add(s.activity);
      }
    }
    for (const a of ACTIVITIES) expect(seen.has(a), a).toBe(true);
  });
});
