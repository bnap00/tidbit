import type { Cmd, DrawTarget, Pal } from "../types.js";

/** Records every call; used by tests, conformance, and the rig's own frame buffer. */
export class CommandListTarget implements DrawTarget {
  cmds: Cmd[] = [];

  reset(): void {
    this.cmds = [];
  }
  clear(c: Pal): void {
    this.cmds.push(["clear", c]);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Pal): void {
    this.cmds.push(["ellipse", cx, cy, rx, ry, c]);
  }
  roundRect(x: number, y: number, w: number, h: number, r: number, c: Pal): void {
    this.cmds.push(["roundRect", x, y, w, h, r, c]);
  }
  tri(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: Pal): void {
    this.cmds.push(["tri", x1, y1, x2, y2, x3, y3, c]);
  }
  line(x1: number, y1: number, x2: number, y2: number, width: number, c: Pal): void {
    this.cmds.push(["line", x1, y1, x2, y2, width, c]);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, width: number, c: Pal): void {
    this.cmds.push(["arc", cx, cy, r, a0, a1, width, c]);
  }
}
