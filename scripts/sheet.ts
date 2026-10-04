// Dev helper: render contact sheets to /tmp for eyeballing the rig.
// Usage: tsx scripts/sheet.ts [fixtures|random|moods] [out.png] [seed]
import { writeFileSync } from "node:fs";
import { ACTIONS, FXS, MOODS, randomDna, type DNA } from "@tidbit/protocol";
import { loadDnaFixtures } from "@tidbit/protocol/fixtures";
import { IndexedBufferTarget, actionDuration, createRig } from "@tidbit/rig";
import { ContactSheet } from "@tidbit/rig/png";

const mode = process.argv[2] ?? "fixtures";
const out = process.argv[3] ?? `/tmp/sheet-${mode}.png`;
const seed = Number(process.argv[4] ?? 1);
const round = (x: number, y: number) => (x - 119.5) ** 2 + (y - 119.5) ** 2 <= 120 * 120;

let dnas: DNA[] = [];
let cols = 4;
const moods: (typeof MOODS)[number][] = [];
if (mode === "fixtures") dnas = loadDnaFixtures().map((f) => f.value);
else if (mode === "random") {
  cols = 6;
  for (let i = 0; i < 24; i++) dnas.push(randomDna(seed * 1000 + i));
} else if (mode === "moods") {
  cols = 6;
  const base = loadDnaFixtures().map((f) => f.value);
  for (const d of base.slice(0, 2)) {
    for (const m of MOODS) {
      dnas.push(d);
      moods.push(m);
    }
  }
}
if (mode === "actions" || mode === "fx") {
  // Filmstrips: one row per action (or fx), six frames across its duration.
  const dna = loadDnaFixtures()[seed % 12]!.value;
  const rows = mode === "actions" ? ACTIONS : FXS;
  const strip = new ContactSheet(6, rows.length, 120);
  rows.forEach((name, r) => {
    const rig = createRig(dna);
    const action = mode === "actions" ? (name as (typeof ACTIONS)[number]) : "none";
    const fx = mode === "fx" ? (name as (typeof FXS)[number]) : "none";
    rig.apply(
      {
        v: 1,
        beats: [{ mood: "happy", intensity: 2, say: "", action, look: "user", fx }],
        bond: "same",
      },
      0,
    );
    const dur = Math.max(1200, actionDuration(action));
    for (let c = 0; c < 6; c++) {
      const t = new IndexedBufferTarget(120, 120);
      rig.frame(((c + 0.5) / 6) * dur, t);
      strip.put(r * 6 + c, t.pixels, rig.palette);
    }
  });
  writeFileSync(out, strip.png());
  console.log("wrote", out);
  process.exit(0);
}
const sheet = new ContactSheet(cols, Math.ceil(dnas.length / cols), 240);
dnas.forEach((dna, i) => {
  const rig = createRig(dna);
  if (moods[i])
    rig.apply(
      {
        v: 1,
        beats: [
          { mood: moods[i]!, intensity: 2, say: "", action: "none", look: "user", fx: "none" },
        ],
        bond: "same",
      },
      0,
    );
  const t = new IndexedBufferTarget();
  rig.frame(2000, t);
  sheet.put(i, t.pixels, rig.palette, round);
  if (rig.stats.dropped || rig.fit < 1)
    console.log(dna.name, "fit", rig.fit.toFixed(2), "dropped", rig.stats.dropped);
});
writeFileSync(out, sheet.png());
console.log("wrote", out);
