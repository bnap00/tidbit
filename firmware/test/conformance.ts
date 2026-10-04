// Compare the firmware rasteriser (host build) with the rig's IndexedBufferTarget on
// streamed frames, and write PNG previews of the device screen.
//   g++ -O2 -std=c++17 -o /tmp/palhost firmware/test/host.cpp firmware/main/raster.cpp firmware/main/text.cpp
//   pnpm exec tsx firmware/test/conformance.ts /tmp/palhost /tmp/pal-preview
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomDna } from "@tidbit/protocol";
import { IndexedBufferTarget, createRig, replay } from "@tidbit/rig";
import { encodeFrame } from "../../apps/brain/src/rig-stream.js";

const [host = "/tmp/palhost", out = "/tmp/pal-preview"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const SIZE = 368;
let worst = 0;
for (const seed of [1, 7, 42, 99, 1234, 2026]) {
  const rig = createRig(randomDna(seed));
  rig.apply(
    {
      v: 1,
      beats: [
        {
          mood: "happy",
          intensity: 2,
          say: "Hi! I missed you.",
          action: "wave",
          look: "user",
          fx: "hearts",
        },
      ],
      bond: "same",
    },
    0,
  );
  for (const t of [300, 900, 2500, 7000]) {
    const cmds = rig.commands(t);
    // The device draws what arrives: the quantised frame, decoded back for the reference.
    const frame = encodeFrame(cmds, t);
    const ref = new IndexedBufferTarget(SIZE, SIZE);
    replay(cmds, ref);
    const base = join(out, `pal-${seed}-${t}`);
    writeFileSync(`${base}.bin`, frame);
    writeFileSync(`${base}.pal`, rig.palette.flat().join(" "));
    const pal = `${base}.pal`;
    execFileSync(host, ["ref", `${base}.bin`, pal, "", `${base}-ref.ppm`, `${base}.idx`]);
    // The real screens, for a look.
    const words = "Hi! I missed you. Shall we play?";
    for (const layout of ["ws", "ws-dark"])
      execFileSync(host, [layout, `${base}.bin`, pal, words, `${base}-${layout}.ppm`]);
    const got = readFileSync(`${base}.idx`);
    let diff = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== ref.pixels[i]) diff++;
    const frac = diff / got.length;
    worst = Math.max(worst, frac);
    console.log(
      `seed ${seed} t ${t}: ${cmds.length} cmds, ${frame.length} B, ${(frac * 100).toFixed(3)}% pixels differ`,
    );
  }
}
console.log(`worst ${(worst * 100).toFixed(3)}%`);
if (worst > 0.005) process.exit(1);
