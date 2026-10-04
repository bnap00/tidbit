// Brain configuration from the environment (PLAN 5.2, 5.9).
import { resolve } from "node:path";
import type { SpeechServer } from "./device.js";

export interface Config {
  host: string;
  port: number;
  /** Required in `hello` when the brain listens beyond loopback. */
  token: string | undefined;
  dataDir: string;
  /** OAuth credentials written by `pnpm login` (pi-ai's auth.json). */
  authFile: string;
  provider: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
  thinking: string;
  turnTimeoutMs: number;
  maxRequestsPerTurn: number;
  maxTokens: number;
  sessionMaxTurns: number;
  /** SearXNG base URL for web_search (JSON format enabled). */
  searxngUrl: string | undefined;
  /** Brave Search API key for web_search; preferred over SearXNG when both are set. */
  braveKey: string | undefined;
  /** Allow owner-defined actions to reach LAN/Tailscale hosts (never this machine). */
  allowPrivateActions: boolean;
  /** OpenAI-compatible speech-to-text for device audio (faster-whisper, whisper.cpp, OpenAI). */
  stt: SpeechServer | undefined;
  /** OpenAI-compatible text-to-speech for device speakers (Kokoro-FastAPI, OpenAI). */
  tts: SpeechServer | undefined;
}

const root = resolve(import.meta.dirname, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.PAL_DATA_DIR ?? resolve(root, "apps/brain/data"));
  return {
    host: env.PAL_HOST ?? "127.0.0.1",
    port: Number(env.PAL_PORT ?? 18790),
    token: env.PAL_TOKEN || undefined,
    dataDir,
    authFile: resolve(env.PAL_AUTH_FILE ?? resolve(root, "auth.json")),
    provider: env.PAL_PROVIDER || undefined,
    model: env.PAL_MODEL || undefined,
    baseUrl: env.PAL_BASE_URL || undefined,
    thinking: env.PAL_THINKING || "low",
    turnTimeoutMs: Number(env.PAL_TURN_TIMEOUT_MS ?? 30_000),
    maxRequestsPerTurn: 6,
    maxTokens: 4000,
    sessionMaxTurns: 40,
    searxngUrl: env.PAL_SEARXNG_URL || undefined,
    braveKey: env.PAL_BRAVE_API_KEY || undefined,
    allowPrivateActions: env.PAL_ALLOW_PRIVATE_ACTIONS === "1",
    stt: env.PAL_STT_URL
      ? {
          url: env.PAL_STT_URL,
          key: env.PAL_STT_KEY || undefined,
          model: env.PAL_STT_MODEL || undefined,
        }
      : undefined,
    tts: env.PAL_TTS_URL
      ? {
          url: env.PAL_TTS_URL,
          key: env.PAL_TTS_KEY || undefined,
          model: env.PAL_TTS_MODEL || undefined,
        }
      : undefined,
  };
}
