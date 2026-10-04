// Build a pi Models collection with only the configured provider (PLAN 5.2).
import { existsSync } from "node:fs";
import {
  createModels,
  createProvider,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import { FileCredentialStore } from "./file-credentials.js";

export type ModelSetup =
  { ok: true; models: Models; model: Model<never>; label: string } | { ok: false; reason: string };

/** Load one built-in provider factory by id, e.g. "anthropic" → anthropicProvider(). */
async function builtinProvider(id: string): Promise<Provider | undefined> {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`@earendil-works/pi-ai/providers/${id}`)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const [name, value] of Object.entries(mod)) {
    if (!name.endsWith("Provider") || typeof value !== "function") continue;
    const provider = (value as () => Provider)();
    if (provider?.id === id) return provider;
  }
  return undefined;
}

async function openAiCompatible(config: Config): Promise<Provider> {
  const { openAICompletionsApi } =
    await import("@earendil-works/pi-ai/api/openai-completions.lazy");
  const id = config.provider ?? "local";
  const model = {
    id: config.model!,
    name: config.model!,
    api: "openai-completions",
    provider: id,
    baseUrl: config.baseUrl!,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_000,
  } as Model<"openai-completions">;
  const key = process.env.PAL_API_KEY;
  return createProvider({
    id,
    name: id,
    baseUrl: config.baseUrl,
    auth: { apiKey: { name: id, resolve: async () => ({ auth: key ? { apiKey: key } : {} }) } },
    models: [model],
    api: openAICompletionsApi(),
  } as never) as Provider;
}

export async function setupModels(config: Config): Promise<ModelSetup> {
  if (!config.model || (!config.provider && !config.baseUrl)) {
    return { ok: false, reason: "PAL_PROVIDER/PAL_MODEL not set" };
  }
  const credentials = existsSync(config.authFile)
    ? new FileCredentialStore(config.authFile)
    : undefined;
  const models = createModels(credentials ? { credentials } : {});
  const provider = config.baseUrl
    ? await openAiCompatible(config)
    : await builtinProvider(config.provider!);
  if (!provider) return { ok: false, reason: `unknown provider "${config.provider}"` };
  models.setProvider(provider);
  const model = models.getModel(provider.id, config.model);
  if (!model)
    return { ok: false, reason: `model "${config.model}" not found for provider "${provider.id}"` };
  let auth;
  try {
    auth = await models.getAuth(model.provider);
  } catch (e) {
    return { ok: false, reason: `auth failed for "${provider.id}": ${(e as Error).message}` };
  }
  if (!auth && !config.baseUrl) {
    return {
      ok: false,
      reason: `no credentials for "${provider.id}" (set its API key env var, or run \`pnpm login ${provider.id}\`)`,
    };
  }
  return {
    ok: true,
    models,
    model: model as Model<never>,
    label: `${provider.id}/${model.id} via ${auth?.source ?? "no auth"}`,
  };
}
