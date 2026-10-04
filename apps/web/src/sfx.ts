// Pet sounds for touches, synthesised with Web Audio (no files to download).
// Each pal's pitch digit sets the base note, so every pal squeaks a little differently.
import type { DNA, TouchKind } from "@tidbit/protocol";
import { audioContext } from "./audio.js";

let noise: AudioBuffer | null = null;

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noise) return noise;
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

/** Attack/decay envelope on a fresh gain node wired to `out`. */
function envelope(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  peak: number,
  attack: number,
  decay: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

/** A pitched chirp gliding from f0 to f1. */
function chirp(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  f0: number,
  f1: number,
  dur: number,
  peak = 0.25,
  type: OscillatorType = "sine",
) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  o.connect(envelope(ctx, out, t, peak, Math.min(0.03, dur / 3), dur));
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Filtered noise burst: crunches (bandpass) or a purr body (lowpass). */
function burst(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  dur: number,
  filter: BiquadFilterType,
  freq: number,
  peak: number,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = filter === "bandpass" ? 1.2 : 0.7;
  src.connect(f).connect(envelope(ctx, out, t, peak, 0.01, dur));
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
  return src;
}

function purr(ctx: AudioContext, out: AudioNode, t: number, dur: number) {
  // A purr is a low rumble pulsing ~25 times a second.
  const body = ctx.createGain();
  body.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 24;
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(body.gain);
  body.connect(out);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 260;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.9, t + 0.15);
  env.gain.setValueAtTime(0.9, t + dur - 0.3);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(env).connect(body);
  lfo.start(t);
  src.start(t);
  lfo.stop(t + dur + 0.05);
  src.stop(t + dur + 0.05);
}

export function playTouchSound(kind: TouchKind, dna: DNA): void {
  const ctx = audioContext();
  if (!ctx) return;
  const out = ctx.createGain();
  out.gain.value = 0.6;
  out.connect(ctx.destination);
  const t = ctx.currentTime + 0.01;
  const f = 500 + dna.voice.pitch * 70; // 500–1130 Hz
  if (kind === "poke") {
    // "Eep!" — a quick upward squeak.
    chirp(ctx, out, t, f, f * 1.9, 0.13, 0.3);
  } else if (kind === "pet") {
    // Content "mrrp" then a purr.
    chirp(ctx, out, t, f * 0.7, f * 1.1, 0.18, 0.18, "triangle");
    purr(ctx, out, t + 0.12, 1.3);
  } else {
    // Three crunches, then a happy "mm-hm" hum.
    for (let i = 0; i < 3; i++)
      burst(ctx, out, t + i * 0.16, 0.07, "bandpass", 1600 + Math.random() * 900, 0.5);
    chirp(ctx, out, t + 0.55, f * 0.55, f * 0.62, 0.16, 0.16, "triangle");
    chirp(ctx, out, t + 0.74, f * 0.6, f * 0.8, 0.2, 0.18, "triangle");
  }
}
