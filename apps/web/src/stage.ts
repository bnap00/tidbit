// The pal stage: canvas, speech bubble with typewriter reveal, and pointer touches.
import type { Beat, DNA, TouchKind } from "@tidbit/protocol";
import { h } from "./dom.js";
import { PalView } from "./pal-view.js";

export class Stage {
  readonly el: HTMLElement;
  readonly view: PalView;
  private bubble: HTMLElement;
  private bubbleText: HTMLElement;
  private shown = "";
  onTouch: ((kind: TouchKind) => void) | null = null;
  /** Called when a conversational beat starts playing (voice output hooks in here). */
  onBeat: ((beat: Beat) => void) | null = null;
  private lastBeat: Beat | null = null;
  private readonly pointerEvents = new AbortController();
  private reactionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dna: DNA, size = 420) {
    this.view = new PalView(dna, size);
    this.bubbleText = h("span");
    this.bubble = h(
      "div",
      { class: "bubble", "data-testid": "bubble", hidden: true },
      this.bubbleText,
    );
    this.el = h("div", { class: "stage", style: `width:${size}px` }, this.bubble, this.view.canvas);
    this.view.canvas.classList.add("stage-canvas");
    this.view.canvas.setAttribute("tabindex", "0");
    this.view.canvas.setAttribute("role", "button");
    this.view.canvas.setAttribute(
      "aria-label",
      "Your pal. Click to poke, drag to pet, or press Enter.",
    );
    this.el.append(h("span", { class: "snack", "aria-hidden": true }, "✦"));
    this.view.canvas.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.touch("poke");
      }
    });
    this.view.onDraw = (t) => this.syncBubble(t);
    this.bindPointer();
    this.view.start();
  }

  get rig() {
    return this.view.rig;
  }

  setDna(dna: DNA): void {
    this.view.setDna(dna);
  }

  /** Typewriter reveal driven by the rig's beat clock. Text goes through textContent only. */
  private syncBubble(t: number): void {
    const s = this.rig.status(t);
    if (s.beat && s.beat !== this.lastBeat) this.onBeat?.(s.beat);
    this.lastBeat = s.beat;
    const text = s.beat && s.beat.say ? Array.from(s.beat.say).slice(0, s.typed).join("") : "";
    if (text === this.shown) return;
    this.shown = text;
    this.bubbleText.textContent = text;
    this.bubble.hidden = text.length === 0;
  }

  /** Click = poke; a stroke across the pal = pet. */
  private bindPointer(): void {
    const c = this.view.canvas;
    let down: { x: number; y: number; travel: number } | null = null;
    let petted = false;
    document.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerType !== "mouse" && !down) return;
        const rect = c.getBoundingClientRect();
        this.rig.setAttention(
          (e.clientX - rect.left - rect.width / 2) / (rect.width / 2),
          (e.clientY - rect.top - rect.height / 2) / (rect.height / 2),
        );
      },
      { signal: this.pointerEvents.signal, passive: true },
    );
    document.addEventListener("pointerleave", () => this.rig.setAttention(null), {
      signal: this.pointerEvents.signal,
    });
    c.addEventListener("pointercancel", () => {
      down = null;
      petted = false;
    });
    c.addEventListener("lostpointercapture", () => {
      down = null;
    });
    c.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY, travel: 0 };
      petted = false;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!down) return;
      down.travel += Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down.x = e.clientX;
      down.y = e.clientY;
      if (!petted && down.travel > 60) {
        petted = true;
        this.touch("pet");
      }
    });
    c.addEventListener("pointerup", () => {
      if (down && !petted) this.touch("poke");
      down = null;
    });
  }

  touch(kind: TouchKind): void {
    this.rig.touch(kind, performance.now());
    if (this.reactionTimer) clearTimeout(this.reactionTimer);
    this.el.dataset.touch = kind;
    this.reactionTimer = setTimeout(() => {
      delete this.el.dataset.touch;
    }, 1200);
    this.onTouch?.(kind);
  }

  dispose(): void {
    this.pointerEvents.abort();
    if (this.reactionTimer) clearTimeout(this.reactionTimer);
    this.view.dispose();
  }
}
