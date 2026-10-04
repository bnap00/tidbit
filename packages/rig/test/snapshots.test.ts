// PNG regression snapshots (PLAN 9): 12 fixtures × 12 moods at t = 2000 ms.
// Update with UPDATE_SNAPSHOTS=1; mismatches are written to .snapshots-actual/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MOODS } from "@tidbit/protocol";
import { loadDnaFixtures } from "@tidbit/protocol/fixtures";
import { IndexedBufferTarget, createRig } from "../src/index.js";
import { decodeIndexedPng, encodeIndexedPng } from "../src/png-node.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "__snapshots__", "png");
const ACTUAL = join(here, "..", "..", "..", ".snapshots-actual");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
/** Pixels allowed to differ: absorbs last-ulp float differences between platforms. */
const TOLERANCE = 24;

describe("PNG snapshots", () => {
  for (const { name, value: dna } of loadDnaFixtures()) {
    it(`${name} × 12 moods`, () => {
      const failures: string[] = [];
      for (const mood of MOODS) {
        const rig = createRig(dna);
        rig.apply(
          {
            v: 1,
            beats: [{ mood, intensity: 2, say: "", action: "none", look: "user", fx: "none" }],
            bond: "same",
          },
          0,
        );
        const target = new IndexedBufferTarget();
        rig.frame(2000, target);
        const png = encodeIndexedPng(target.pixels, 240, 240, rig.palette);
        const file = join(DIR, name, `${mood}.png`);
        if (UPDATE || !existsSync(file)) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, png);
          continue;
        }
        const want = decodeIndexedPng(readFileSync(file));
        let diff = 0;
        for (let i = 0; i < want.pixels.length; i++)
          if (want.pixels[i] !== target.pixels[i]) diff++;
        const paletteSame = JSON.stringify(want.palette) === JSON.stringify(rig.palette);
        if (diff > TOLERANCE || !paletteSame) {
          const out = join(ACTUAL, name, `${mood}.png`);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, png);
          failures.push(
            `${mood}: ${diff} pixels differ${paletteSame ? "" : ", palette changed"} (actual: ${out})`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
