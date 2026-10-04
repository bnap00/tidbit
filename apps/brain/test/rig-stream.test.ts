// The brain renders the pal for screens that cannot run the rig (the ESP32 pal).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRig } from "@tidbit/rig";
import { randomDna } from "@tidbit/protocol";
import { ScriptedBrain } from "../src/scripted-brain.js";
import {
  FRAME_MAGIC,
  FRAME_VERSION,
  REST_DOZE_MS,
  RigStream,
  encodeFrame,
} from "../src/rig-stream.js";
import { startServer } from "../src/server.js";
import { PalService } from "../src/service.js";
import { Store } from "../src/store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const PARAMS = [0, 4, 5, 6, 5, 6];

function decode(buf: Buffer) {
  expect(buf[0]).toBe(FRAME_MAGIC);
  expect(buf[1]).toBe(FRAME_VERSION);
  const count = buf.readUInt16LE(2);
  const t = buf.readUInt32LE(4);
  const cmds: { op: number; pal: number; params: number[] }[] = [];
  let o = 8;
  for (let i = 0; i < count; i++) {
    const head = buf[o++]!;
    const op = head & 0x0f;
    const params: number[] = [];
    for (let k = 0; k < PARAMS[op]!; k++, o += 2) params.push(buf.readInt16LE(o));
    cmds.push({ op, pal: head >> 4, params });
  }
  expect(o).toBe(buf.length);
  return { t, cmds };
}

describe("rig stream", () => {
  it("encodes every command in 1/16 px and milliradians", () => {
    const rig = createRig(randomDna(7));
    const cmds = rig.commands(1500);
    const { t, cmds: out } = decode(encodeFrame(cmds, 1500));
    expect(t).toBe(1500);
    expect(out).toHaveLength(cmds.length);
    expect(out[0]!.op).toBe(0);
    cmds.forEach((c, i) => {
      expect(out[i]!.pal).toBe(c[c.length - 1]);
      const nums = c.slice(1, -1) as number[];
      nums.forEach((v, k) => {
        const angle = c[0] === "arc" && (k === 3 || k === 4);
        expect(Math.abs(out[i]!.params[k]! / (angle ? 1000 : 16) - v)).toBeLessThan(
          angle ? 0.001 : 1 / 16,
        );
      });
    });
    // Small enough for 30 fps over a weak Wi-Fi link.
    expect(encodeFrame(cmds, 0).length).toBeLessThan(2000);
  });

  it("streams frames and captions instead of JSON pet messages", async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "apal-")), "pal.db"));
    const service = new PalService(store, new ScriptedBrain());
    const server = await startServer(service, { host: "127.0.0.1", port: 0, log: () => {} });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => ws.close());
    const json: { type: string; [k: string]: unknown }[] = [];
    const frames: Buffer[] = [];
    ws.on("message", (d, binary) => {
      if (binary) frames.push(d as Buffer);
      else json.push(JSON.parse(d.toString()));
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(
      JSON.stringify({
        type: "hello",
        clientId: "esp32",
        caps: { w: 368, h: 448, colors: 65536, input: ["touch"], stream: "rig", fps: 30 },
      }),
    );
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 30));
      expect(pred()).toBe(true);
    };
    await until(() => frames.length >= 3);
    const stream = json.find((m) => m.type === "stream")!;
    expect(stream.palette).toHaveLength(8);
    expect(stream.fps).toBe(30);
    // The device never gets the browser's DNA, needs or agenda JSON.
    expect(
      json.map((m) => m.type).every((t) => ["stream", "thinking", "caption"].includes(t)),
    ).toBe(true);
    const a = decode(frames[0]!);
    const b = decode(frames[frames.length - 1]!);
    expect(b.t).toBeGreaterThan(a.t);
    expect(a.cmds.length).toBeGreaterThan(5);

    ws.send(JSON.stringify({ type: "attend", x: 0.5, y: -0.2 }));
    ws.send(JSON.stringify({ type: "touch", kind: "poke" }));
    ws.send(JSON.stringify({ type: "say", text: "Hello there!" }));
    await until(() => json.some((m) => m.type === "caption" && (m.text as string).length > 0));
    expect(json.some((m) => m.type === "error")).toBe(false);
  });

  it("dozes off when the screen rests, stops frames once it is dark, and wakes", () => {
    let now = 0;
    const sent: (string | Buffer)[] = [];
    const ws = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (d: string | Buffer) => sent.push(d),
    };
    const stream = new RigStream(ws as never, {
      now: () => now,
      snapshot: () => Promise.reject(new Error("unused")),
    });
    cleanups.push(() => stream.close());
    stream.onMessage({ type: "character", dna: randomDna(3) });
    const frames = () => sent.filter((d) => typeof d !== "string").length;
    const step = (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        now += 50;
        stream.tick();
      }
    };
    step(500);
    stream.rest(true);
    const atRest = frames();
    step(REST_DOZE_MS);
    // Frames keep coming while the pal dozes off and the screen fades…
    expect(frames() - atRest).toBeGreaterThan(REST_DOZE_MS / 50 - 4);
    const dark = frames();
    step(5000);
    // …then stop.
    expect(frames()).toBe(dark);
    // Words still reach a resting screen, so a reminder can wake it.
    stream.onMessage({
      type: "turn",
      turn: {
        v: 1,
        beats: [
          {
            mood: "happy",
            intensity: 2,
            say: "Time to stretch!",
            action: "none",
            look: "user",
            fx: "none",
          },
        ],
        bond: "same",
      },
      needs: { hunger: 5, energy: 5, bond: 5 },
    } as never);
    step(100);
    expect(sent.some((d) => typeof d === "string" && d.includes("Time to stretch!"))).toBe(true);
    stream.rest(false);
    step(200);
    expect(frames()).toBeGreaterThan(dark);
  });
});
