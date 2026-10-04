// One shared AudioContext for Kokoro playback and pet sounds. Created on first use;
// browsers may still start it suspended, so any later pointer or key press resumes it.
let ctx: AudioContext | null = null;

export function audioContext(): AudioContext | null {
  if (!ctx && typeof AudioContext !== "undefined") ctx = new AudioContext();
  if (ctx?.state === "suspended") void ctx.resume();
  return ctx;
}

const unlock = () => {
  if (ctx?.state === "suspended") void ctx.resume();
};
window.addEventListener("pointerdown", unlock, { passive: true });
window.addEventListener("keydown", unlock);
