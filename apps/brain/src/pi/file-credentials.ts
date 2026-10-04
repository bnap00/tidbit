// A CredentialStore backed by the auth.json file that `pi-ai login` writes.
// Refreshed OAuth tokens are written back atomically with owner-only permissions.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type AuthFile = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  private chains = new Map<string, Promise<unknown>>();

  constructor(readonly path: string) {}

  private load(): AuthFile {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as AuthFile;
    } catch {
      return {};
    }
  }

  private save(data: AuthFile): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Serialize work per provider so concurrent refreshes cannot interleave. */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]): CredentialInfo => ({
      providerId,
      type: c.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const data = this.load();
      const next = await fn(data[providerId]);
      if (next === undefined) return data[providerId];
      data[providerId] = next;
      this.save(data);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      const data = this.load();
      delete data[providerId];
      this.save(data);
    });
  }
}
