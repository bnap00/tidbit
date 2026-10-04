// hue + scheme + seed → 8 RGB colours (PLAN 4.3).
import { SCHEMES, hash2, type Scheme } from "@tidbit/protocol";
import { RIG_CONSTANTS, SCHEME_HSL } from "@tidbit/protocol/rig-data";
import { BG, DARK, EYE_WHITE, FX, type RGB } from "./types.js";

export function hslToRgb(h: number, s: number, l: number): RGB {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/**
 * Move `mover`'s lightness away from `fixed` until the contrast is met or it
 * hits black/white. Returns whether the target was reached.
 */
function push(mover: Hsl, fixed: Hsl, min: number): boolean {
  const fixedRgb = hslToRgb(fixed.h, fixed.s, fixed.l);
  const dir = luminance(hslToRgb(mover.h, mover.s, mover.l)) >= luminance(fixedRgb) ? 1 : -1;
  for (let i = 0; i < 60; i++) {
    if (contrast(hslToRgb(mover.h, mover.s, mover.l), fixedRgb) >= min) return true;
    const next = mover.l + dir * 0.02;
    if (next < 0 || next > 1) break;
    mover.l = next;
  }
  mover.l = Math.min(1, Math.max(0, mover.l));
  return contrast(hslToRgb(mover.h, mover.s, mover.l), fixedRgb) >= min;
}

export function derivePalette(hue: number, scheme: Scheme, seed: number): RGB[] {
  const rules = SCHEME_HSL[SCHEMES.indexOf(scheme)] ?? SCHEME_HSL[0]!;
  const k = RIG_CONSTANTS;
  // Deterministic per-pal jitter so same-hue pals still differ a little.
  const jh = ((hash2(seed, 11) % 1000) / 1000 - 0.5) * 2 * k.seedHueJitter;
  const jl = ((hash2(seed, 12) % 1000) / 1000 - 0.5) * 2 * k.seedLightJitter;
  const hsl: Hsl[] = rules.map(([dh, s, l], slot) => ({
    h: slot === FX ? k.fxHue : hue + jh + dh,
    s,
    l: slot === BG || slot === EYE_WHITE || slot === DARK ? l : l + jl,
  }));
  const [bg, outline, body, , , eyeWhite, dark] = hsl as [Hsl, Hsl, Hsl, Hsl, Hsl, Hsl, Hsl];

  // Guarantees (PLAN 4.3), with a little headroom for rounding on devices.
  if (!push(bg, body, k.minBgContrast)) push(body, bg, k.minBgContrast);
  if (!push(outline, body, k.minOutlineContrast)) push(body, outline, k.minOutlineContrast);
  if (!push(dark, eyeWhite, k.minDarkContrast)) push(eyeWhite, dark, k.minDarkContrast);
  // Fixing body may have undone the background guarantee; one more pass settles it.
  push(bg, body, k.minBgContrast);

  return hsl.map((c) => hslToRgb(c.h, c.s, c.l));
}
