// Start/stop a real brain process for e2e tests: ScriptedBrain, temp data dir, no .env.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BRAIN_PORT = 8799;

/**
 * Storage state with the first-run voice question already answered (browser voice, so
 * no model download). Tests use both origins; contexts made by hand must pass it too.
 */
export const VOICE_ANSWERED = {
  cookies: [],
  origins: ["http://127.0.0.1:5199", "http://localhost:5199"].map((origin) => ({
    origin,
    localStorage: [{ name: "a-pal:voice-engine", value: "browser" }],
  })),
};

export class TestBrain {
  private proc: ChildProcess | null = null;
  readonly dataDir = mkdtempSync(join(tmpdir(), "apal-e2e-"));

  async start(): Promise<void> {
    const cwd = resolve(import.meta.dirname, "..", "apps", "brain");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PAL_PORT: String(BRAIN_PORT),
      PAL_DATA_DIR: this.dataDir,
    };
    // Run node itself with the tsx loader: one process, so a kill really stops the brain.
    this.proc = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("brain did not start")), 20_000);
      this.proc!.stdout!.on("data", (d: Buffer) => {
        if (String(d).includes("listening")) {
          clearTimeout(t);
          ok();
        }
      });
      this.proc!.on("exit", (code) => fail(new Error(`brain exited ${code}`)));
    });
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((ok) => {
      p.once("exit", () => ok());
      p.kill("SIGKILL");
    });
  }
}
