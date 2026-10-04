import { defineConfig } from "@playwright/test";
import { VOICE_ANSWERED } from "./e2e/brain.js";

// E2E runs its own web server on 5199 whose /ws proxy points at a test brain on 8799.
// Tests that need the brain start and stop it themselves (e2e/brain.ts).
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/playwright",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5199",
    viewport: { width: 1280, height: 900 },
    // The first-run voice question is answered up front; e2e/voice.spec.ts tests it.
    storageState: VOICE_ANSWERED,
  },
  webServer: {
    command: "pnpm --filter @tidbit/web exec vite",
    env: { PAL_WEB_PORT: "5199", PAL_PORT: "8799", PAL_WEB_HOST: "127.0.0.1" },
    url: "http://127.0.0.1:5199/gallery",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
