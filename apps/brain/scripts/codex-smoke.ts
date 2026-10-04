// One tiny request through the Codex OAuth credential, to prove the login works.
import { resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { FileCredentialStore } from "../src/pi/file-credentials.js";

const store = new FileCredentialStore(resolve(import.meta.dirname, "../../../auth.json"));
const models = createModels({ credentials: store });
models.setProvider(openaiCodexProvider());
const model = models.getModel("openai-codex", process.argv[2] ?? "gpt-5.5");
if (!model) throw new Error("model not found");
const auth = await models.getAuth(model.provider);
console.log("auth source:", auth?.source ?? "none");
const t = Date.now();
const res = await models.completeSimple(
  model,
  {
    messages: [
      { role: "user", content: "Reply with exactly one word: hello", timestamp: Date.now() },
    ],
  },
  { reasoning: "low" } as never,
);
console.log("stopReason:", res.stopReason, res.errorMessage ?? "");
console.log(
  "text:",
  res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join(""),
);
console.log("ms:", Date.now() - t, "usage:", JSON.stringify(res.usage));
