// Node-only fixture loader, shared by tests across packages.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DNA, Turn } from "./schema.js";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function load<T>(sub: string, parse: (text: string) => T): { name: string; value: T }[] {
  const dir = join(FIXTURES_DIR, sub);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      value: parse(readFileSync(join(dir, f), "utf8")),
    }));
}

export const loadDnaFixtures = () => load<DNA>("dna", (t) => JSON.parse(t) as DNA);
export const loadTurnFixtures = () => load<Turn>("turns", (t) => JSON.parse(t) as Turn);
/** Junk is returned as raw text; some files are not even valid JSON payloads. */
export const loadJunkFixtures = () => load<string>("junk", (t) => t);
