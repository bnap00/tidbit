// Entry point: pick a brain from the environment, open the store, serve.
import { resolve } from "node:path";
import type { Brain } from "./brain.js";
import { loadConfig } from "./config.js";
import { PiBrain } from "./pi/pi-brain.js";
import { setupModels } from "./pi/models.js";
import { ScriptedBrain } from "./scripted-brain.js";
import { startServer } from "./server.js";
import { PalService } from "./service.js";
import { Store } from "./store.js";

const config = loadConfig();
const log = (m: string, d?: Record<string, unknown>) =>
  console.log(`[brain] ${m}`, d ? JSON.stringify(d) : "");

let brain: Brain;
const setup = await setupModels(config);
if (setup.ok) {
  brain = new PiBrain(setup.models, setup.model, {
    thinking: config.thinking,
    maxTokens: config.maxTokens,
    maxRequestsPerTurn: config.maxRequestsPerTurn,
    turnTimeoutMs: config.turnTimeoutMs,
    log,
  });
  log("using model", { model: setup.label });
} else {
  brain = new ScriptedBrain();
  log("using ScriptedBrain", { reason: setup.reason });
}

const store = new Store(resolve(config.dataDir, "pal.db"));
const service = new PalService(store, brain, {
  sessionMaxTurns: config.sessionMaxTurns,
  search: { searxngUrl: config.searxngUrl, braveKey: config.braveKey },
  allowPrivateActions: config.allowPrivateActions,
  log,
});
const server = await startServer(service, {
  requireIdentity: true,
  host: config.host,
  port: config.port,
  token: config.token,
  device: { stt: config.stt, tts: config.tts },
  log,
});
if (config.stt || config.tts) log("device speech", { stt: !!config.stt, tts: !!config.tts });

const shutdown = async () => {
  await server.close();
  brain.close?.();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
