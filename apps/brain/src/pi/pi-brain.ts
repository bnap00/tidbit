// PiBrain (PLAN 5.2): the LLM-backed brain. The only module that uses pi's agent loop.
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  cleanupSessionResources,
  createInitialSystemMessage,
  getCurrentSystemMessage,
  toToolDeclaration,
  type AssistantMessage,
  type Model,
  type Models,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  FALLBACK_TURN,
  MOODS,
  type Mood,
  LlmDnaSchema,
  LlmTurnSchema,
  LlmTriageSchema,
  normalizeTriage,
  type Triage,
  fnv1a,
  idFromSeed,
  normalizeDna,
  normalizeTurn,
  textToTurn,
  type DNA,
  type Turn,
} from "@tidbit/protocol";
import type { Brain, TriageContext, TurnContext, UserInput } from "../brain.js";
import { dnaFromPrompt } from "../scripted-brain.js";
import { localIso, scriptedTriage } from "../second-brain.js";
import { agentTools } from "./agent-tools.js";
import {
  CREATOR_PROMPT,
  SUMMARY_PROMPT,
  abilitiesSection,
  characterSection,
  systemPrompt,
  triagePrompt,
  userMessageText,
} from "./prompt.js";

export interface PiBrainOptions {
  thinking?: string;
  maxTokens?: number;
  maxRequestsPerTurn?: number;
  turnTimeoutMs?: number;
  /** Extra tools on top of `perform` and the pal's own tools (tests). */
  tools?: AgentTool[];
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface UsageRecord {
  cacheRead: number;
  input: number;
  output: number;
  cost: number;
}

const THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export class PiBrain implements Brain {
  readonly name: string;
  readonly usage: UsageRecord[] = [];
  private readonly log: NonNullable<PiBrainOptions["log"]>;

  constructor(
    private readonly models: Models,
    private readonly model: Model<never>,
    private readonly opts: PiBrainOptions = {},
  ) {
    this.name = `pi:${model.provider}/${model.id}`;
    this.log = opts.log ?? ((msg, data) => console.log(`[brain] ${msg}`, data ?? ""));
  }

  /** Codex keeps a pooled WebSocket per session (reused across turns); release them all. */
  close(): void {
    cleanupSessionResources();
  }

  private get thinking(): ThinkingLevel {
    return (
      THINKING.includes(this.opts.thinking ?? "") ? this.opts.thinking : "low"
    ) as ThinkingLevel;
  }

  private recordUsage(msg: AssistantMessage): void {
    const u = msg.usage;
    const rec = {
      cacheRead: u?.cacheRead ?? 0,
      input: u?.input ?? 0,
      output: u?.output ?? 0,
      cost: u?.cost?.total ?? 0,
    };
    this.usage.push(rec);
    // PLAN 5.3: log cache reads and cost for every request.
    this.log("request", { model: msg.model, stop: msg.stopReason, ...rec });
  }

  async createCharacter(prompt?: string): Promise<DNA> {
    const seed = prompt?.trim()
      ? fnv1a(prompt.trim().toLowerCase())
      : (Math.random() * 2 ** 32) >>> 0;
    const id = idFromSeed(seed);
    if (!prompt?.trim()) return dnaFromPrompt("", seed);
    try {
      const res = await this.models.completeSimple(
        this.model,
        {
          systemPrompt: CREATOR_PROMPT,
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          tools: [
            {
              name: "create_character",
              description: "Create the pal described by the user.",
              parameters: LlmDnaSchema,
              constrainedSampling: { type: "json_schema", strict: "prefer" },
            },
          ],
        },
        {
          maxTokens: this.opts.maxTokens ?? 4000,
          reasoning: this.thinking,
          signal: AbortSignal.timeout(this.opts.turnTimeoutMs ?? 30_000),
        },
      );
      this.recordUsage(res);
      if (res.stopReason !== "error" && res.stopReason !== "aborted") {
        const call = res.content.find(
          (b) => b.type === "toolCall" && b.name === "create_character",
        );
        if (call && call.type === "toolCall") return normalizeDna(call.arguments, { id, seed });
        const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        const json = extractJson(text);
        if (json) return normalizeDna(json, { id, seed });
      } else {
        this.log("create_character failed", { error: res.errorMessage });
      }
    } catch (e) {
      this.log("create_character threw", { error: (e as Error).message });
    }
    // Last resort: a keyword-shaped random pal, seeded from the prompt.
    return dnaFromPrompt(prompt, seed);
  }

  /** One structured request that files a capture; offline triage if it fails. */
  async triage(ctx: TriageContext, text: string): Promise<Triage> {
    try {
      const res = await this.models.completeSimple(
        this.model,
        {
          systemPrompt: triagePrompt(ctx.now, localIso(ctx.now)),
          messages: [{ role: "user", content: text, timestamp: Date.now() }],
          tools: [
            {
              name: "file_capture",
              description: "File the user's capture.",
              parameters: LlmTriageSchema,
              constrainedSampling: { type: "json_schema", strict: "prefer" },
            },
          ],
        },
        {
          maxTokens: this.opts.maxTokens ?? 4000,
          reasoning: "low",
          signal: AbortSignal.timeout(this.opts.turnTimeoutMs ?? 30_000),
        },
      );
      this.recordUsage(res);
      if (res.stopReason !== "error" && res.stopReason !== "aborted") {
        const call = res.content.find((b) => b.type === "toolCall" && b.name === "file_capture");
        if (call && call.type === "toolCall") return normalizeTriage(call.arguments, text);
        const json = extractJson(
          res.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
        );
        if (json) return normalizeTriage(json, text);
      } else this.log("triage failed", { error: res.errorMessage });
    } catch (e) {
      this.log("triage threw", { error: (e as Error).message });
    }
    return scriptedTriage(text, ctx.now);
  }

  async runTurn(ctx: TurnContext, input: UserInput): Promise<Turn> {
    let captured: Turn | undefined;
    const perform: AgentTool<typeof LlmTurnSchema> = {
      name: "perform",
      label: "Perform",
      description:
        "Reply to the user as the pal. Always finish your turn by calling this exactly once.",
      parameters: LlmTurnSchema,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      // Repair out-of-range values instead of bouncing them back to the model.
      prepareArguments: (raw) => {
        const t = normalizeTurn(raw, ctx.dna.baseMood);
        return { beats: t.beats, bond: t.bond };
      },
      execute: async (_id, args) => {
        captured = normalizeTurn(args, ctx.dna.baseMood);
        return { content: [{ type: "text", text: "ok" }], details: {}, terminate: true };
      },
    };

    const stored = ctx.session.load() as AgentMessage[];
    const tools = [
      perform,
      ...agentTools(ctx.tools, {
        webSearch: ctx.abilities?.webSearch,
        actions: !!ctx.abilities?.actions.length,
      }),
      ...(this.opts.tools ?? []),
    ];
    const sections: Record<string, string> = {
      character: characterSection(ctx.dna, ctx.personality),
      abilities: abilitiesSection(ctx.abilities),
    };
    if (!stored.length) {
      const initial = createInitialSystemMessage(
        systemPrompt(ctx.dna, ctx.personality),
        tools.map(toToolDeclaration),
      )!;
      initial.sections = sections;
      stored.push(initial);
    } else {
      // Append named-section updates; never rewrite the stored transcript prefix.
      // Tool changes are appended by pi's agent loop the same way.
      const current = getCurrentSystemMessage(stored)?.sections ?? {};
      const changed = Object.fromEntries(
        Object.entries(sections).filter(([name, text]) => current[name] !== text),
      );
      if (Object.keys(changed).length)
        stored.push({ role: "system", content: "", sections: changed, timestamp: Date.now() });
    }
    const maxTokens = this.opts.maxTokens ?? 4000;
    const agent = new Agent({
      initialState: {
        // System instructions and preference updates are persisted in the message log.
        systemPrompt: "",
        model: this.model,
        thinkingLevel: this.thinking,
        tools,
        messages: stored,
      },
      streamFn: (m, c, o) => this.models.streamSimple(m, c, { ...o, maxTokens }),
      sessionId: `${ctx.dna.id}-s${ctx.session.id}`,
    });

    let earlyMoodSent = false;
    let requests = 0;
    const cap = this.opts.maxRequestsPerTurn ?? 6;
    agent.finishTurn = async () => {
      requests++;
      if (captured) return { action: "end" };
      if (requests >= cap) {
        this.log("request cap reached", { cap });
        return { action: "end" };
      }
      return undefined;
    };
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant")
        this.recordUsage(event.message);
      // Early mood (M6 streaming): partial perform arguments arrive already parsed.
      if (event.type === "message_update" && ctx.onEarlyMood && !earlyMoodSent) {
        const e = event.assistantMessageEvent as { type: string; partial?: AssistantMessage };
        if (e.type === "toolcall_delta") {
          const call = e.partial?.content.find(
            (b) => b.type === "toolCall" && b.name === "perform",
          );
          const beats =
            call?.type === "toolCall"
              ? (call.arguments as { beats?: { mood?: unknown; intensity?: unknown }[] }).beats
              : undefined;
          const mood = beats?.[0]?.mood;
          // Only once the value is complete, i.e. a later field has started streaming.
          if (
            typeof mood === "string" &&
            (MOODS as readonly string[]).includes(mood) &&
            beats?.[0]?.intensity !== undefined
          ) {
            earlyMoodSent = true;
            ctx.onEarlyMood(mood as Mood);
          }
        }
      }
    });

    const timer = setTimeout(() => {
      this.log("turn timed out", { ms: this.opts.turnTimeoutMs ?? 30_000 });
      agent.abort();
    }, this.opts.turnTimeoutMs ?? 30_000);
    try {
      await agent.prompt(userMessageText(ctx, input));
    } catch (e) {
      this.log("agent threw", { error: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
    ctx.session.save(agent.state.messages);
    return captured ?? this.resolveWithoutPerform(agent.state.messages, ctx);
  }

  /** One LLM call that condenses a closing session into a memory (PLAN 5.5). */
  async summarizeSession(ctx: TurnContext): Promise<string | undefined> {
    const lines: string[] = [];
    for (const m of ctx.session.load() as AgentMessage[]) {
      if (m.role === "user") {
        const t =
          typeof m.content === "string"
            ? m.content
            : m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
        // Drop the volatile context block; keep what the user actually said.
        lines.push(`User: ${t.replace(/^\[context\][^\n]*\n\n/, "")}`);
      } else if (m.role === "toolResult" && m.toolName === "perform") {
        continue;
      } else if (m.role === "assistant") {
        for (const b of m.content) {
          if (b.type === "toolCall" && b.name === "perform") {
            const beats = (b.arguments as { beats?: { say?: string }[] }).beats ?? [];
            const said = beats
              .map((x) => x.say ?? "")
              .filter(Boolean)
              .join(" ");
            if (said) lines.push(`${ctx.dna.name}: ${said}`);
          } else if (b.type === "text" && b.text.trim())
            lines.push(`${ctx.dna.name}: ${b.text.trim()}`);
        }
      }
    }
    if (!lines.length) return undefined;
    try {
      const res = await this.models.completeSimple(
        this.model,
        {
          systemPrompt: SUMMARY_PROMPT,
          messages: [
            {
              role: "user",
              content: `Already remembered:\n${ctx.memories.map((m) => `- ${m}`).join("\n") || "(nothing yet)"}\n\nConversation:\n${lines.join("\n").slice(-12_000)}`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: 600,
          reasoning: "low",
          signal: AbortSignal.timeout(this.opts.turnTimeoutMs ?? 30_000),
        },
      );
      this.recordUsage(res);
      if (res.stopReason === "error" || res.stopReason === "aborted") return undefined;
      const text = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ")
        .trim();
      if (/^none\.?$/i.test(text)) return "";
      return text || undefined;
    } catch (e) {
      this.log("summary failed", { error: (e as Error).message });
      return undefined;
    }
  }

  /** Resolution steps 2 and 3 (PLAN 5.2): wrap plain text, or fall back. */
  private resolveWithoutPerform(messages: readonly AgentMessage[], ctx: TurnContext): Turn {
    const last = [...messages].reverse().find((m) => m.role === "assistant") as
      AssistantMessage | undefined;
    if (!last) return FALLBACK_TURN;
    if (
      last.stopReason === "error" ||
      last.stopReason === "aborted" ||
      last.stopReason === "length"
    ) {
      this.log("turn failed", { stop: last.stopReason, error: last.errorMessage });
      return FALLBACK_TURN;
    }
    const text = last.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join(" ")
      .trim();
    if (!text) return FALLBACK_TURN;
    return textToTurn(text, ctx.dna.baseMood);
  }
}

/** Find the first balanced JSON object in free text. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
