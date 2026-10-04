// Proactive behaviour (PLAN 5.7): reminders, first contact of the day, need thresholds.
import type { PalService, TurnResult } from "./service.js";

export const PROACTIVE_GAP_MS = 10 * 60_000;
/** Hysteresis: alert when crossing `on`, re-arm only after recovering past `off`. */
export const THRESHOLDS = {
  hungry: { on: 80, off: 60 },
  tired: { on: 15, off: 35 },
};

export interface SchedulerOptions {
  hasClients: () => boolean;
  deliver: (result: TurnResult) => void;
  tickMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA");

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private pendingEvents: string[] = [];

  constructor(
    private readonly service: PalService,
    private readonly opts: SchedulerOptions,
  ) {}

  start(): this {
    this.timer ??= setInterval(() => void this.tick(), this.opts.tickMs ?? 1000);
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called when a client says hello: greet once per day. */
  noteContact(): void {
    const today = dayKey(this.service.now());
    if (this.service.meta.get("last_contact_day") !== today) {
      this.service.meta.set("last_contact_day", today);
      this.pendingEvents.push("first_contact_of_day");
    }
  }

  private proactiveAllowed(): boolean {
    const last = Number(this.service.meta.get("last_proactive_at") ?? 0);
    return this.service.now() - last >= PROACTIVE_GAP_MS;
  }

  /** One scheduling pass. Public for tests. Never runs concurrently with itself. */
  async tick(): Promise<void> {
    if (this.busy || !this.opts.hasClients()) return;
    this.busy = true;
    try {
      // Reminders are what the user asked for: deliver them without the 10-minute gap.
      const due = this.service.dueReminders();
      if (due.length) {
        this.opts.deliver(await this.service.remind(due[0]!));
        return;
      }
      const needs = await this.service.needs();
      // Collect candidates; nothing is consumed or latched until it is delivered,
      // so an event blocked by the rate limit fires later instead of being lost.
      const candidates: { event: string; commit: () => void }[] = this.pendingEvents.map(
        (event) => ({
          event,
          commit: () => this.pendingEvents.splice(this.pendingEvents.indexOf(event), 1),
        }),
      );
      for (const [name, t] of Object.entries(THRESHOLDS)) {
        const value = name === "hungry" ? needs.hunger : needs.energy;
        const crossed = name === "hungry" ? value >= t.on : value <= t.on;
        const recovered = name === "hungry" ? value < t.off : value > t.off;
        const key = `alert_${name}`;
        if (recovered) this.service.meta.set(key, "0");
        else if (crossed && this.service.meta.get(key) !== "1") {
          candidates.push({ event: name, commit: () => this.service.meta.set(key, "1") });
        }
      }
      if (!candidates.length) return;
      if (!this.proactiveAllowed()) return;
      const next = candidates[0]!;
      next.commit();
      this.service.meta.set("last_proactive_at", String(this.service.now()));
      // One proactive turn at a time; the rest wait for the next allowed slot.
      this.opts.deliver(await this.service.proactive(next.event));
    } catch (e) {
      this.opts.log?.("scheduler error", { error: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }
}
