import type { SessionLog, TurnContext } from "../src/brain.js";
import { Store } from "../src/store.js";
import { createTools } from "../src/tools.js";
import { loadDnaFixtures } from "@tidbit/protocol/fixtures";

export class MemorySession implements SessionLog {
  messages: unknown[] = [];
  constructor(readonly id = 1) {}
  load(): unknown[] {
    return structuredClone(this.messages);
  }
  save(messages: readonly unknown[]): void {
    // Append-only, as the real store enforces.
    if (messages.length < this.messages.length) throw new Error("session shrank");
    this.messages = structuredClone([...messages]);
  }
}

export function ctxFor(
  session = new MemorySession(),
  dnaIndex = 1,
  store = new Store(":memory:"),
): TurnContext {
  const dna = loadDnaFixtures()[dnaIndex]!.value;
  store.savePal(dna);
  return {
    dna,
    tools: createTools({ store, palId: dna.id, clock: Date.now, fetch }),
    memories: [],
    dueReminders: [],
    needs: { energy: 80, hunger: 20, bond: 50 },
    now: new Date("2026-09-29T19:45:00"),
    touches: {},
    session,
  };
}
