import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_TURN } from "@tidbit/protocol";
import type { Brain, TurnContext, UserInput } from "../src/brain.js";
import { PalService } from "../src/service.js";
import { Store } from "../src/store.js";
import { createTools, sameFact } from "../src/tools.js";
import { ScriptedBrain } from "../src/scripted-brain.js";

const cleanups: (() => unknown)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Records every context it is given; `act` can call tools like a model would. */
class RecordingBrain implements Brain {
  readonly name = "recording";
  readonly contexts: TurnContext[] = [];
  readonly summaries: string[][] = [];
  act?: (ctx: TurnContext, input: UserInput) => void;
  summary: string | undefined = "";
  createCharacter = (prompt?: string) => new ScriptedBrain().createCharacter(prompt);
  async runTurn(ctx: TurnContext, input: UserInput) {
    this.contexts.push(ctx);
    this.act?.(ctx, input);
    return FALLBACK_TURN;
  }
  async summarizeSession(ctx: TurnContext) {
    this.summaries.push(ctx.memories);
    return this.summary;
  }
}

function setup(brain: Brain = new RecordingBrain()) {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const service = new PalService(store, brain, { sessionMaxTurns: 40 });
  const say = (text: string) => service.turn({ kind: "say", text });
  const manage = (action: string, extra: Record<string, unknown> = {}) =>
    service.manage({ action, palId: service.pal.id, ...extra });
  return { store, service, say, manage, palId: service.pal.id };
}

describe("memory deduplication", () => {
  it("treats rephrasings as the same fact and real additions as new", () => {
    expect(sameFact("The user's dog is called Biscuit", "User's dog is named Biscuit.")).toBe(true);
    expect(sameFact("Bharat is a software engineer", "Bharat is a software engineer.")).toBe(true);
    expect(sameFact("dog Biscuit", "The user has a dog called Biscuit")).toBe(true);
    expect(sameFact("The user's dog is not called Biscuit", "The user's dog is Biscuit")).toBe(
      false,
    );
    expect(sameFact("The user likes tea", "The user likes coffee")).toBe(false);
  });

  it("remember returns the existing memory instead of storing a duplicate", () => {
    const { store, palId } = setup();
    const tools = createTools({ store, palId, clock: Date.now, fetch });
    expect(tools.remember("The user's name is Bharat", ["user"])).toMatch(/^Remembered as/);
    expect(tools.remember("User's name is Bharat.", ["user"])).toMatch(/^Already remembered/);
    // Session summaries are prose, not facts, and never block a fact.
    store.addMemory(palId, "The user told me they love hiking and tea.", ["session"]);
    expect(tools.remember("The user loves hiking", ["user"])).toMatch(/^Remembered as/);
    expect(store.countMemories(palId)).toBe(3);
  });
});

describe("memory in the model context", () => {
  it("shows each memory once per session, and edits as updates", async () => {
    const brain = new RecordingBrain();
    const { store, say, manage, palId } = setup(brain);
    const id = store.addMemory(palId, "The user's cat is Pixel", ["pets"]);
    await say("How is my cat?");
    await say("And my cat again?");
    expect(brain.contexts[0]!.memories).toEqual(["The user's cat is Pixel"]);
    expect(brain.contexts[1]!.memories).toEqual([]);
    await manage("edit_memory", { memoryId: id, fact: "The user's cat is Nimbus" });
    await say("Tell me about my cat");
    expect(brain.contexts[2]!.memories).toEqual(["(updated) The user's cat is Nimbus"]);
    // Same session throughout: edits never break the cached prefix.
    expect(new Set(brain.contexts.map((c) => c.session.id)).size).toBe(1);
  });

  it("does not re-show a memory the model stored itself", async () => {
    const brain = new RecordingBrain();
    const { say } = setup(brain);
    brain.act = (ctx, input) => {
      if (input.kind === "say" && input.text.startsWith("My dog"))
        ctx.tools.remember("The user's dog is Biscuit", ["pets"]);
    };
    await say("My dog is Biscuit");
    await say("What is my dog called?");
    expect(brain.contexts[1]!.memories).toEqual([]);
  });

  it("forgetting a memory the model saw starts a fresh context; an unseen one does not", async () => {
    const brain = new RecordingBrain();
    const { store, say, manage, palId } = setup(brain);
    await say("Hello");
    const unseen = store.addMemory(palId, "The user dislikes rain", ["user"]);
    await manage("forget", { memoryId: unseen });
    await say("Still here?");
    expect(brain.contexts[1]!.session.id).toBe(brain.contexts[0]!.session.id);

    const seen = store.addMemory(palId, "The user's password hint is blue", ["user"]);
    await say("What do you know?");
    expect(brain.contexts[2]!.memories).toContain("The user's password hint is blue");
    await manage("forget", { memoryId: seen });
    await say("And now?");
    expect(brain.contexts[3]!.session.id).not.toBe(brain.contexts[2]!.session.id);
    // The closed context is not summarised, so the forgotten fact is not carried forward.
    expect(brain.summaries).toEqual([]);
  });
});

describe("conversations", () => {
  it("new conversation on an empty conversation stays put", async () => {
    const { service, say, manage } = setup();
    const first = service.conversationId;
    await manage("new_conversation");
    expect(service.conversationId).toBe(first);
    await say("Hi there");
    await manage("new_conversation");
    const second = service.conversationId;
    expect(second).not.toBe(first);
    await manage("new_conversation");
    expect(service.conversationId).toBe(second);
    const listed = (await service.snapshot()).conversations;
    expect(listed.map((c) => c.id).sort()).toEqual([first, second].sort());
    expect(listed.find((c) => c.id === first)).toMatchObject({ messages: 2, title: "Hi there" });
  });

  it("summarises only new turns, with known facts, and never re-dumps a resumed conversation", async () => {
    const brain = new RecordingBrain();
    brain.summary = undefined; // offline: the bridge path
    const { store, service, say, manage, palId } = setup(brain);
    store.addMemory(palId, "The user is a software engineer", ["user"]);
    const first = service.conversationId;
    await say("hello");
    await manage("new_conversation");
    expect(brain.summaries).toEqual([["The user is a software engineer"]]);
    expect(store.recentMemories(palId, 10).filter((m) => m.tags.includes("session"))).toHaveLength(
      1,
    );
    await manage("resume", { conversationId: first });
    await manage("new_conversation");
    await manage("resume", { conversationId: first });
    await manage("new_conversation");
    expect(brain.summaries).toHaveLength(1);
    expect(store.recentMemories(palId, 10).filter((m) => m.tags.includes("session"))).toHaveLength(
      1,
    );
  });

  it("stores nothing when the summariser finds nothing new", async () => {
    const brain = new RecordingBrain();
    brain.summary = "";
    const { store, say, manage, palId } = setup(brain);
    await say("hello");
    await manage("new_conversation");
    expect(store.countMemories(palId)).toBe(0);
  });
});

it("reuses an empty conversation instead of creating another", async () => {
  const { store, service, say, manage } = setup();
  const first = service.conversationId;
  await say("hello");
  await manage("new_conversation");
  const second = service.conversationId;
  await manage("resume", { conversationId: first });
  await manage("new_conversation");
  expect(service.conversationId).toBe(second);
  const rows = store.db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number };
  expect(rows.n).toBe(2);
});
