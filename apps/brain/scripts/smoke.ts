// pnpm smoke: create a pal from a prompt with the configured model, then hold a
// two-turn conversation. Opt-in, never part of verify (PLAN 9).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { setupModels } from "../src/pi/models.js";
import { PiBrain } from "../src/pi/pi-brain.js";
import { PalService } from "../src/service.js";
import { Store } from "../src/store.js";

const config = loadConfig();
const setup = await setupModels(config);
if (!setup.ok) {
  console.error(`smoke: no model configured (${setup.reason})`);
  process.exit(1);
}
console.log(`model: ${setup.label}`);
const brain = new PiBrain(setup.models, setup.model, {
  thinking: config.thinking,
  log: (m, d) => {
    if (m !== "request") console.log(`  (log) ${m}`, d ?? "");
  },
});
const store = new Store(join(mkdtempSync(join(tmpdir(), "apal-smoke-")), "pal.db"));
const service = new PalService(store, brain);

let t = Date.now();
const dna = await service.create(
  process.argv[2] ?? "a grumpy cactus cat who secretly loves company",
);
console.log(
  `\ncreated in ${Date.now() - t} ms: ${dna.name}: ${dna.look.body}, ${dna.look.eyes} eyes, ${dna.look.ears} ears, ${dna.look.scheme} hue ${dna.look.hue}`,
);
console.log(`persona: ${dna.persona}`);

for (const text of [
  "Hi! How are you today?",
  "I just got back from a long walk and I'm starving.",
  "By the way, my dog is called Biscuit.",
  "What's the weather like in Lisbon right now?",
  "Remind me in 10 minutes to feed Biscuit.",
]) {
  t = Date.now();
  const { turn } = await service.turn({ kind: "say", text });
  console.log(`\nyou: ${text}   (${Date.now() - t} ms)`);
  for (const b of turn.beats)
    console.log(`  [${b.mood}×${b.intensity} ${b.action} ${b.fx} look:${b.look}] ${b.say}`);
  console.log(`  bond: ${turn.bond}`);
}
const palId = service.pal.id;
console.log(
  `\nmemories stored: ${
    store
      .recentMemories(palId, 10)
      .map((m) => m.fact)
      .join(" | ") || "none"
  }`,
);
console.log(
  `reminders: ${
    store
      .pendingReminders(palId)
      .map((r) => `${new Date(r.dueAt).toLocaleTimeString()} ${r.text}`)
      .join(" | ") || "none"
  }`,
);
const cost = brain.usage.reduce((a, u) => a + u.cost, 0);
const cached = brain.usage.reduce((a, u) => a + u.cacheRead, 0);
console.log(
  `\nrequests: ${brain.usage.length}, cache-read tokens: ${cached}, equivalent cost: $${cost.toFixed(4)}`,
);
brain.close();
store.close();
