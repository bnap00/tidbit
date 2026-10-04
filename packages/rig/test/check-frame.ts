// Frame invariants from PLAN 4.6, shared by the static and animated suites.
// Allocation-free so the 80k-frame property suite stays fast.
import {
  CANVAS,
  MAX_DRAW_CALLS,
  PART,
  SAFE_R,
  SAFE_X,
  SAFE_Y,
  cmdMaxDist,
  type Cmd,
} from "../src/index.js";

const TOL = 0.5;
/** Dense sampling for the test, independent of the runtime's 24 samples. */
const TEST_SAMPLES = 96;

type Box = [number, number, number, number];

/** Exact axis-aligned bounds (arcs are bounded by their full circle). */
function cmdBox(c: Cmd): Box | null {
  switch (c[0]) {
    case "clear":
      return null;
    case "ellipse":
      return [c[1] - c[3], c[2] - c[4], c[1] + c[3], c[2] + c[4]];
    case "roundRect":
      return [c[1], c[2], c[1] + c[3], c[2] + c[4]];
    case "tri":
      return [
        Math.min(c[1], c[3], c[5]),
        Math.min(c[2], c[4], c[6]),
        Math.max(c[1], c[3], c[5]),
        Math.max(c[2], c[4], c[6]),
      ];
    case "line": {
      const h = c[5] / 2;
      return [
        Math.min(c[1], c[3]) - h,
        Math.min(c[2], c[4]) - h,
        Math.max(c[1], c[3]) + h,
        Math.max(c[2], c[4]) + h,
      ];
    }
    case "arc": {
      // Tight bounds: endpoints plus any axis extremes the sweep crosses.
      const [, cx, cy, r, a0, a1, w] = c;
      const R = r + w / 2;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      const add = (a: number) => {
        x0 = Math.min(x0, cx + r * Math.cos(a));
        x1 = Math.max(x1, cx + r * Math.cos(a));
        y0 = Math.min(y0, cy + r * Math.sin(a));
        y1 = Math.max(y1, cy + r * Math.sin(a));
      };
      add(a0);
      add(a1);
      for (let k = Math.ceil(a0 / (Math.PI / 2)); k * (Math.PI / 2) <= a1; k++)
        add(k * (Math.PI / 2));
      const h = w / 2;
      return [
        Math.max(x0 - h, cx - R),
        Math.max(y0 - h, cy - R),
        Math.min(x1 + h, cx + R),
        Math.min(y1 + h, cy + R),
      ];
    }
  }
}

function union(boxes: (Box | null)[]): Box | null {
  let out: Box | null = null;
  for (const b of boxes) {
    if (!b) continue;
    out = out
      ? [
          Math.min(out[0], b[0]),
          Math.min(out[1], b[1]),
          Math.max(out[2], b[2]),
          Math.max(out[3], b[3]),
        ]
      : [...b];
  }
  return out;
}

/** Returns human-readable violations; empty when the frame is valid. */
export function checkFrame(
  cmds: Cmd[],
  tags: readonly number[],
  opts: { faceInBody?: boolean } = {},
): string[] {
  const bad: string[] = [];
  if (cmds.length > MAX_DRAW_CALLS) bad.push(`${cmds.length} draw calls`);
  if (cmds.length < 2) bad.push("empty frame");
  const boxes = cmds.map(cmdBox);
  cmds.forEach((c, i) => {
    for (let j = 1; j < c.length; j++)
      if (!Number.isFinite(c[j] as number)) bad.push(`cmd ${i} has non-finite value`);
    const pal = c[c.length - 1] as number;
    if (!(Number.isInteger(pal) && pal >= 0 && pal <= 7))
      bad.push(`cmd ${i} bad palette index ${pal}`);
    switch (c[0]) {
      case "ellipse":
        if (!(c[3] > 0 && c[4] > 0)) bad.push(`cmd ${i} ellipse radius ${c[3]},${c[4]}`);
        break;
      case "roundRect":
        if (!(c[3] > 0 && c[4] > 0 && c[5] >= 0)) bad.push(`cmd ${i} roundRect size`);
        break;
      case "line":
        if (!(c[5] > 0)) bad.push(`cmd ${i} line width`);
        break;
      case "arc":
        if (!(c[3] > 0 && c[6] > 0 && c[5] >= c[4])) bad.push(`cmd ${i} arc params`);
        break;
    }
    const b = boxes[i];
    if (!b) return;
    if (b[0] < -TOL || b[1] < -TOL || b[2] > CANVAS + TOL || b[3] > CANVAS + TOL) {
      bad.push(`cmd ${i} (${c[0]}, part ${tags[i]}) off canvas`);
    }
    const dist = cmdMaxDist(c, SAFE_X, SAFE_Y, TEST_SAMPLES);
    if (dist > SAFE_R + TOL)
      bad.push(
        `cmd ${i} (${c[0]}, part ${tags[i]}) outside safe circle by ${(dist - SAFE_R).toFixed(2)}`,
      );
  });
  const of = (part: number) => union(boxes.filter((_, i) => tags[i] === part));
  const body = of(PART.body);
  if (!body || body[2] - body[0] < 4 || body[3] - body[1] < 4) bad.push("zero-area body");
  if (opts.faceInBody !== false && body) {
    for (const [name, part] of [
      ["eyes", PART.eyes],
      ["mouth", PART.mouth],
    ] as const) {
      const b = of(part);
      if (!b) continue;
      if (
        b[0] < body[0] - TOL ||
        b[1] < body[1] - TOL ||
        b[2] > body[2] + TOL ||
        b[3] > body[3] + TOL
      ) {
        bad.push(
          `${name} bbox ${b.map((v) => v.toFixed(1))} outside body ${body.map((v) => v.toFixed(1))}`,
        );
      }
    }
  }
  return bad;
}
