import { describe, expect, it } from "vitest";
import { SCHEMES } from "@tidbit/protocol";
import {
  BG,
  BODY,
  DARK,
  EYE_WHITE,
  OUTLINE,
  contrast,
  derivePalette,
  hslToRgb,
} from "../src/index.js";

describe("palette", () => {
  it("hslToRgb matches known values", () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
    expect(hslToRgb(0, 0, 1)).toEqual([255, 255, 255]);
  });

  it("meets the contrast guarantees for every hue, scheme and a spread of seeds", () => {
    const failures: string[] = [];
    for (const scheme of SCHEMES) {
      for (let hue = 0; hue < 360; hue++) {
        for (const seed of [0, 1, 77, 12345, 0xffffffff, hue * 7919]) {
          const p = derivePalette(hue, scheme, seed);
          expect(p).toHaveLength(8);
          const o = contrast(p[OUTLINE]!, p[BODY]!);
          const d = contrast(p[DARK]!, p[EYE_WHITE]!);
          const b = contrast(p[BG]!, p[BODY]!);
          if (o < 3 || d < 7 || b < 1.5)
            failures.push(
              `${scheme} h${hue} s${seed}: outline ${o.toFixed(2)} dark ${d.toFixed(2)} bg ${b.toFixed(2)}`,
            );
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it("is deterministic and depends on the seed", () => {
    expect(derivePalette(200, "pastel", 5)).toEqual(derivePalette(200, "pastel", 5));
    expect(derivePalette(200, "pastel", 5)).not.toEqual(derivePalette(200, "pastel", 6));
  });
});
