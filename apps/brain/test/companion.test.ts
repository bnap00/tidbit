import { afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import WebSocket from "ws";
import { PersonalitySchema, parseServerMessage, type ServerMessage } from "@tidbit/protocol";
import { Store } from "../src/store.js";
import { PalService } from "../src/service.js";
import { ScriptedBrain } from "../src/scripted-brain.js";
import { startServer } from "../src/server.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function setup(maxTurns = 40) {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const root = new PalService(store, new ScriptedBrain(), { sessionMaxTurns: maxTurns });
  const identity = root.companions.createOwner();
  return { store, root, identity, service: root.forOwner(identity.ownerId) };
}
const request = (service: PalService, id: string, text = "Hello!") => ({
  requestId: id,
  text,
  palId: service.pal.id,
  conversationId: service.conversationId,
});

describe("companion continuity", () => {
  it("preserves the installation's pets for its first owner and isolates later owners", async () => {
    const { root, identity, service } = setup();
    expect(service.pal.id).toBe(root.pal.id);
    await service.sayOnce(request(service, "a", "My name is Sam."));
    const second = root.companions.createOwner(),
      other = root.forOwner(second.ownerId);
    expect(other.pal.id).not.toBe(service.pal.id);
    expect((await other.snapshot()).lines).toEqual([]);
    expect(other.memories()).toEqual([]);
    await expect(other.manage({ action: "switch_pal", palId: service.pal.id })).rejects.toThrow(
      "Pal not found",
    );
    expect(root.companions.owner(identity.token)).toBe(identity.ownerId);
    expect(root.companions.owner("bad credential")).toBeUndefined();
  });
  it("deduplicates concurrent sends and replays them after a service restart", async () => {
    const { root, identity, store, service } = setup();
    const msg = request(service, "durable-1", "I like oolong tea.");
    const [first, second] = await Promise.all([service.sayOnce(msg), service.sayOnce(msg)]);
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    expect(store.totalTurns(service.pal.id)).toBe(1);
    expect((await service.snapshot()).lines.map((line) => line.who)).toEqual(["you", "pal"]);
    const restarted = new PalService(store, new ScriptedBrain()).forOwner(identity.ownerId);
    const replay = await restarted.sayOnce(msg);
    expect(replay.id).toBe(first.id);
    expect(store.totalTurns(service.pal.id)).toBe(1);
    expect((await restarted.snapshot()).lines).toHaveLength(2);
    expect(root.companions.owner(identity.token)).toBe(identity.ownerId);
    await expect(restarted.sayOnce({ ...msg, text: "Different message" })).rejects.toThrow(
      "another message",
    );
  });
  it("keeps public history across context rollovers and resumes earlier conversations", async () => {
    const { store, service } = setup(2);
    const first = service.conversationId;
    await service.sayOnce(request(service, "1", "Remember that my dog is Biscuit."));
    const context = store.openSession(service.pal.id).id;
    await service.sayOnce(request(service, "2", "Hello again"));
    await service.sayOnce(request(service, "3", "What's my dog?"));
    expect(store.openSession(service.pal.id).id).not.toBe(context);
    expect(service.conversationId).toBe(first);
    expect((await service.snapshot()).lines).toHaveLength(6);
    expect(service.memories().some((m) => m.fact.includes("Biscuit"))).toBe(true);
    await service.manage({ action: "new_conversation", palId: service.pal.id });
    expect(service.conversationId).not.toBe(first);
    expect((await service.snapshot()).lines).toEqual([]);
    await expect(
      service.sayOnce({ ...request(service, "wrong"), conversationId: first }),
    ).rejects.toThrow("different conversation");
    await service.manage({ action: "resume", palId: service.pal.id, conversationId: first });
    expect((await service.snapshot()).lines).toHaveLength(6);
    await service.create("a tiny robot");
    const newPal = service.pal.id;
    expect((await service.snapshot()).pals).toHaveLength(2);
    const oldPal = (await service.snapshot()).pals.find((p) => p.id !== newPal)!;
    await service.manage({ action: "switch_pal", palId: oldPal.id });
    expect(service.conversationId).toBe(first);
  });
  it("paginates history without gaps or duplicate rows", async () => {
    const { service } = setup(100);
    for (let i = 0; i < 30; i++) await service.sayOnce(request(service, `m${i}`, `Hello ${i}`));
    const recent = await service.snapshot();
    expect(recent.lines).toHaveLength(50);
    expect(recent.hasOlder).toBe(true);
    const earlier = service.history(service.conversationId, recent.lines[0]!.id);
    expect(earlier.lines).toHaveLength(10);
    expect(earlier.hasOlder).toBe(false);
    expect(new Set([...earlier.lines, ...recent.lines].map((line) => line.id)).size).toBe(60);
  });
  it("edits and forgets memories in both the store and full-text search", async () => {
    const { store, service } = setup();
    await service.manage({ action: "remember", palId: service.pal.id, fact: "Likes oolong tea" });
    const id = service.memories()[0]!.id;
    await service.manage({
      action: "edit_memory",
      palId: service.pal.id,
      memoryId: id,
      fact: "Likes peppermint tea",
    });
    expect(store.searchMemories(service.pal.id, "oolong")).toEqual([]);
    expect(store.searchMemories(service.pal.id, "peppermint")).toHaveLength(1);
    await service.manage({ action: "forget", palId: service.pal.id, memoryId: id });
    expect(service.memories()).toEqual([]);
    expect(store.searchMemories(service.pal.id, "peppermint")).toEqual([]);
  });
  it("keeps personality stable, gives it its own tastes, and changes expression with state", async () => {
    const { service, store, identity } = setup();
    const initial = (await service.snapshot()).personality;
    expect(Value.Check(PersonalitySchema, initial)).toBe(true);
    const profile = {
      ...initial,
      humor: "dry" as const,
      speech: "quiet" as const,
      likes: ["moon cakes"],
      dislikes: ["loud surprises"],
    };
    await service.manage({ action: "personality", palId: service.pal.id, personality: profile });
    const liked = await service.sayOnce(request(service, "likes", "What do you like?"));
    expect(liked.turn.beats[0]!.say).toContain("moon cakes");
    const pat = await service.sayOnce(request(service, "pat", "Can I pet you?"));
    expect(pat.turn.beats[0]).toMatchObject({ look: "away", intensity: 1 });
    expect(pat.turn.beats[0]!.say).toContain("One more head pat");
    const disagree = await service.sayOnce(request(service, "disagree", "I love loud surprises"));
    expect(disagree.turn.beats[0]!.action).toBe("shake");
    expect(disagree.turn.beats[0]!.say).toContain("moon cakes");
    const restarted = new PalService(store, new ScriptedBrain()).forOwner(identity.ownerId);
    expect((await restarted.snapshot()).personality).toEqual(profile);
    for (let i = 0; i < 15; i++)
      await restarted.sayOnce(request(restarted, `bond-${i}`, "You're my best pal. I love you!"));
    const familiar = await restarted.sayOnce(request(restarted, "familiar-pat", "Can I pet you?"));
    expect(familiar.turn.beats[0]!.look).toBe("user");
    const state = await restarted.snapshot();
    expect(state.personality).toEqual(profile);
    expect(state.relationship.stage).toBe("Close companions");
  });
  it("issues independent device credentials and makes pairing codes expire after one use", () => {
    const { root, identity } = setup();
    const pair = root.companions.pair(identity.ownerId, 1000);
    const paired = root.companions.redeem(pair.code, 2000);
    expect(paired.ownerId).toBe(identity.ownerId);
    expect(paired.token).not.toBe(identity.token);
    expect(root.companions.owner(paired.token)).toBe(identity.ownerId);
    expect(() => root.companions.redeem(pair.code, 2001)).toThrow("invalid or expired");
    const expired = root.companions.pair(identity.ownerId, 3000);
    expect(() => root.companions.redeem(expired.code, expired.expiresAt)).toThrow(
      "invalid or expired",
    );
  });
});

it("requires device identity in production, pairs devices, and keeps WebSocket traffic private", async () => {
  const { root, identity, service } = setup();
  const server = await startServer(root, {
    host: "127.0.0.1",
    port: 0,
    requireIdentity: true,
    schedulerTickMs: 0,
    log: () => {},
  });
  cleanups.push(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  const api = async (path: string, token: string, body?: unknown) => {
    const response = await fetch(`${origin}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  expect((await api("state", "invalid")).status).toBe(401);
  const otherIdentity = root.companions.createOwner();
  await service.sayOnce(request(service, "private", "My name is Sam."));
  expect(
    (await api(`history?conversation=${service.conversationId}`, otherIdentity.token)).status,
  ).toBe(404);
  const code = ((await api("pair", identity.token, {})).data as { code: string }).code;
  const paired = (
    (await api("pair/redeem", otherIdentity.token, { code })).data as {
      identity: { token: string };
    }
  ).identity;
  expect(((await api("state", paired.token)).data as { dna: { id: string } }).dna.id).toBe(
    service.pal.id,
  );
  expect((await api("pair/redeem", otherIdentity.token, { code })).status).toBe(400);
  const open = async (token?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const inbox: ServerMessage[] = [];
    ws.on("message", (data) => {
      const p = parseServerMessage(data.toString());
      if (p.ok) inbox.push(p.msg);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        clientId: "test",
        ...(token ? { ownerToken: token } : {}),
        caps: { w: 240, h: 240, colors: 65536, input: ["text"] },
      }),
    );
    cleanups.push(() => ws.close());
    return { ws, inbox };
  };
  const anonymous = await open();
  await new Promise<void>((resolve) => anonymous.ws.once("close", () => resolve()));
  expect(anonymous.inbox).toContainEqual(
    expect.objectContaining({ type: "error", code: "unauthorized" }),
  );
  const a = await open(identity.token),
    b = await open(paired.token),
    other = await open(otherIdentity.token);
  await new Promise((resolve) => setTimeout(resolve, 30));
  a.ws.send(JSON.stringify({ type: "say", ...request(service, "socket", "Hello my paired pal!") }));
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("No acknowledgement")), 2000);
    a.ws.on("message", (raw) => {
      const p = parseServerMessage(raw.toString());
      if (p.ok && p.msg.type === "ack" && p.msg.status === "done") {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  await expect
    .poll(() =>
      b.inbox.some((msg) => msg.type === "chat" && msg.line.text === "Hello my paired pal!"),
    )
    .toBe(true);
  expect(other.inbox.some((msg) => msg.type === "chat" || msg.type === "turn")).toBe(false);
});

it("serves a consistent snapshot while a model reply is still in progress", async () => {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const scripted = new ScriptedBrain();
  let release!: () => void, markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new PalService(store, {
    name: "delayed",
    createCharacter: (prompt) => scripted.createCharacter(prompt),
    async runTurn(ctx, input) {
      markStarted();
      await gate;
      return scripted.runTurn(ctx, input);
    },
  });
  const turn = service.sayOnce(request(service, "slow-reply"));
  await started;
  try {
    const snapshot = await Promise.race([
      service.snapshot(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Snapshot waited for the model")), 100),
      ),
    ]);
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]!.who).toBe("you");
    expect(snapshot.dna.id).toBe(service.pal.id);
  } finally {
    release();
    await turn;
  }
  expect((await service.snapshot()).lines).toHaveLength(2);
});

it("lets the owner inspect memories beyond the first page", async () => {
  const { store, service } = setup();
  for (let i = 0; i < 105; i++) store.addMemory(service.pal.id, `Lasting fact ${i}`, ["user"]);
  const recent = service.memories();
  const earlier = service.memories(recent.at(-1)!.id);
  expect(recent).toHaveLength(100);
  expect(earlier).toHaveLength(5);
  expect(new Set([...recent, ...earlier].map((memory) => memory.id)).size).toBe(105);
});
