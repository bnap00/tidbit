// End to end over a real WebSocket with ScriptedBrain (PLAN 9, M3 acceptance).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import { DnaSchema, TurnSchema, parseServerMessage, type ServerMessage } from "@tidbit/protocol";
import { ScriptedBrain, dnaFromPrompt } from "../src/scripted-brain.js";
import { startServer, type RunningServer } from "../src/server.js";
import { PalService } from "../src/service.js";
import { Store } from "../src/store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(
  dir = mkdtempSync(join(tmpdir(), "apal-")),
  opts: { turnsPerMinute?: number } = {},
) {
  const store = new Store(join(dir, "pal.db"));
  const service = new PalService(store, new ScriptedBrain());
  const server = await startServer(service, { host: "127.0.0.1", port: 0, log: () => {}, ...opts });
  cleanups.push(async () => {
    await server.close();
    store.close();
  });
  return { dir, store, service, server };
}

class Client {
  readonly inbox: ServerMessage[] = [];
  /** Messages not yet consumed by next(), in arrival order. */
  private pending: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const p = parseServerMessage(d.toString());
      if (!p.ok) throw new Error(`invalid server message: ${p.message} ${d.toString()}`);
      this.inbox.push(p.msg);
      const w = this.waiters.find((x) => x.pred(p.msg));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(p.msg);
      } else this.pending.push(p.msg);
    });
  }
  static async open(server: RunningServer, hello = true): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
    const c = new Client(ws);
    cleanups.push(() => ws.close());
    if (hello) {
      c.send({
        type: "hello",
        clientId: "test",
        caps: { w: 240, h: 240, colors: 65536, input: ["text"] },
      });
      await c.next("character");
      await c.next("needs");
    }
    return c;
  }
  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  /** Resolve with the first unconsumed (or future) message matching `pred`. */
  next<T extends ServerMessage["type"]>(
    pred: ServerMessage["type"] | ((m: ServerMessage) => boolean),
    timeout = 3000,
  ) {
    const p = typeof pred === "string" ? (m: ServerMessage) => m.type === pred : pred;
    const i = this.pending.findIndex(p);
    if (i >= 0)
      return Promise.resolve(this.pending.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `timeout waiting for message; pending: ${JSON.stringify(this.pending.map((m) => m.type))}`,
            ),
          ),
        timeout,
      );
      this.waiters.push({ pred: p, resolve: (m) => (clearTimeout(t), resolve(m as never)) });
    });
  }
}

describe("brain server (ScriptedBrain)", () => {
  it("hello → character + needs; create → new pal; three messages → three valid turns", async () => {
    const { server } = await boot();
    const c = await Client.open(server);
    const first = c.inbox.find((m) => m.type === "character");
    expect(first && Value.Check(DnaSchema, first.dna)).toBe(true);

    c.send({ type: "create", prompt: "a grumpy cactus cat" });
    const created = await c.next<"character">("character");
    expect(created.dna.look.ears).toBe("cat");
    expect(created.dna.temper.grumpy).toBe(8);

    for (const text of ["Hello there!", "It's my birthday today", "Do you like music?"]) {
      const thinking = c.next<"thinking">((m) => m.type === "thinking" && m.on);
      c.send({ type: "say", text });
      await thinking;
      const res = await c.next<"turn">("turn");
      expect(Value.Check(TurnSchema, res.turn)).toBe(true);
      expect(res.turn.beats.at(-1)!.say.length).toBeGreaterThan(0);
      await c.next((m) => m.type === "thinking" && !m.on);
    }
    expect(c.inbox.filter((m) => m.type === "turn")).toHaveLength(3);
  });

  it("adopts a shared pal sent with create", async () => {
    const { server } = await boot();
    const c = await Client.open(server);
    const shared = { ...dnaFromPrompt("a blue robot", 1234), name: "Sharebot" };
    c.send({ type: "create", dna: shared });
    const got = await c.next<"character">("character");
    expect(got.dna).toEqual(shared);
  });

  it("requires hello first, ignores unknown types, rejects junk and oversize frames", async () => {
    const { server } = await boot();
    const c = await Client.open(server, false);
    c.send({ type: "say", text: "hi" });
    expect((await c.next<"error">("error")).code).toBe("hello_first");
    c.send({ type: "hello", clientId: "x", caps: { w: 1, h: 1, colors: 2, input: [] } });
    await c.next("needs");
    c.send({ type: "teleport" });
    c.send("{not json");
    expect((await c.next<"error">("error")).code).toBe("bad_json");
    c.send({ type: "touch", kind: "tickle" });
    expect((await c.next<"error">("error")).code).toBe("invalid");
    expect(c.inbox.filter((m) => m.type === "error")).toHaveLength(3);
    // Oversize frames are closed by the socket layer (4 KB limit).
    const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
    c.send({ type: "say", text: "x".repeat(5000) });
    expect(await closed).toBe(1009);
  });

  it("touches update needs and reach the next turn as context", async () => {
    const { server, service } = await boot();
    const c = await Client.open(server);
    const before = c.inbox.find((m) => m.type === "needs") as Extract<
      ServerMessage,
      { type: "needs" }
    >;
    c.send({ type: "touch", kind: "pet" });
    const after = await c.next<"needs">("needs");
    expect(after.bond).toBeGreaterThanOrEqual(before.bond);
    c.send({ type: "touch", kind: "feed" });
    const fed = await c.next<"needs">("needs");
    expect(fed.hunger).toBeLessThan(after.hunger);
    c.send({ type: "say", text: "hello" });
    const turn = await c.next<"turn">("turn");
    expect(turn.turn.beats.at(-1)!.say).toMatch(/pets/);
    expect(service.pal.id).toBeTruthy();
  });

  it("rate limits turns per client", async () => {
    const { server } = await boot(undefined, { turnsPerMinute: 2 });
    const c = await Client.open(server);
    for (let i = 0; i < 3; i++) c.send({ type: "say", text: `hi ${i}` });
    expect((await c.next<"error">("error")).code).toBe("rate_limited");
  });

  it("persists the pal and its session across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apal-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const a = await boot(dir);
    const c = await Client.open(a.server);
    c.send({ type: "create", prompt: "a sleepy blue bunny" });
    const created = await c.next<"character">("character");
    c.send({ type: "say", text: "hello" });
    await c.next("turn");
    c.ws.close();
    await a.server.close();
    a.store.close();

    const b = await boot(dir);
    const c2 = await Client.open(b.server);
    const again = c2.inbox.find((m) => m.type === "character") as Extract<
      ServerMessage,
      { type: "character" }
    >;
    expect(again.dna).toEqual(created.dna);
  });

  it("refuses to listen beyond loopback without a token, and checks it", async () => {
    const store = new Store(":memory:");
    const service = new PalService(store, new ScriptedBrain());
    await expect(startServer(service, { host: "0.0.0.0", port: 0, log: () => {} })).rejects.toThrow(
      /PAL_TOKEN/,
    );
    const server = await startServer(service, {
      host: "127.0.0.1",
      port: 0,
      token: "s3cret",
      log: () => {},
    });
    cleanups.push(() => server.close());
    const c = await Client.open(server, false);
    const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
    c.send({
      type: "hello",
      clientId: "x",
      token: "wrong",
      caps: { w: 1, h: 1, colors: 2, input: [] },
    });
    expect(await closed).toBe(4003);
  });
});
