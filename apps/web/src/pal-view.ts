// Canvases showing rigs, driven by one shared animation loop with a frame-time monitor.
import { createRig, replay, type Rig } from "@tidbit/rig";
import { PetTarget } from "./pet-target.js";
import type { DNA } from "@tidbit/protocol";

type Tick = (t: number) => void;
const ticks = new Set<Tick>();
let running = false;

/** Rolling frame statistics, exposed on window for the 60 fps e2e test. */
export const perf = {
  frames: 0,
  /** Mean interval between rAF callbacks (ms). */
  intervalMs: 0,
  /** Mean time spent inside our frame callbacks (ms). */
  workMs: 0,
  /** Worst work time in the current window (ms). */
  maxWorkMs: 0,
  fps: 0,
  reset(): void {
    this.frames = 0;
    this.intervalMs = 0;
    this.workMs = 0;
    this.maxWorkMs = 0;
    this.fps = 0;
  },
};
(window as unknown as { __palPerf: typeof perf }).__palPerf = perf;

let last = 0;
function loop(t: number): void {
  const start = performance.now();
  for (const f of ticks) f(t);
  const work = performance.now() - start;
  if (last) {
    const n = Math.min(perf.frames, 119);
    perf.intervalMs = (perf.intervalMs * n + (t - last)) / (n + 1);
    perf.workMs = (perf.workMs * n + work) / (n + 1);
    perf.maxWorkMs = Math.max(perf.maxWorkMs, work);
    perf.fps = perf.intervalMs > 0 ? 1000 / perf.intervalMs : 0;
    perf.frames++;
  }
  last = t;
  if (ticks.size) requestAnimationFrame(loop);
  else {
    running = false;
    last = 0;
  }
}

/** Register a per-frame callback; returns an unsubscribe function. */
export function onFrame(f: Tick): () => void {
  ticks.add(f);
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
  return () => ticks.delete(f);
}

export class PalView {
  readonly canvas: HTMLCanvasElement;
  rig: Rig;
  private target: PetTarget;
  private readonly framed: boolean;
  private stop: (() => void) | null = null;
  /** When set, frames render at this fixed time (screenshots, static thumbnails). */
  frozenAt: number | null = null;
  /** Called after each drawn frame with the frame time. */
  onDraw: ((t: number) => void) | null = null;

  constructor(dna: DNA, cssSize: number) {
    this.framed = cssSize >= 240;
    this.canvas = document.createElement("canvas");
    const px = Math.round(cssSize * Math.min(2, window.devicePixelRatio || 1));
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.width = `${cssSize}px`;
    this.canvas.style.height = `${cssSize}px`;
    const ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.target = new PetTarget(ctx, px);
    this.rig = createRig(dna);
    this.target.setPalette(this.rig.palette);
  }

  setDna(dna: DNA): void {
    this.rig = createRig(dna);
    this.target.setPalette(this.rig.palette);
  }

  draw(t: number): void {
    const time = this.frozenAt ?? t;
    const commands = this.rig.commands(time);
    this.target.beginFrame(commands, this.rig.tags, this.rig.pose, time, this.framed);
    replay(commands, this.target);
    this.onDraw?.(time);
  }

  start(): this {
    this.stop ??= onFrame((t) => this.draw(t));
    return this;
  }

  dispose(): void {
    this.stop?.();
    this.stop = null;
  }
}
