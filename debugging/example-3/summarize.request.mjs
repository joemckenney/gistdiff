import { writeFileSync } from "node:fs";
import { gateway } from "@ai-sdk/gateway";
import {
  buildSystemPrompt,
  buildUserPrompt,
} from "@gistdiff/core/prompt";
import { generateText } from "ai";
import { gitDiff, loadEnvLocal } from "../lib/env.mjs";

loadEnvLocal();

const COMMIT = "a9d9cbd";
const DESCRIPTION = false;
const MODELS = ["anthropic/claude-sonnet-4.6", "openai/gpt-oss-120b"];
const LABELS = { "anthropic/claude-sonnet-4.6": "claude", "openai/gpt-oss-120b": "gpt-oss" };

const diff = gitDiff(COMMIT);
const system = buildSystemPrompt(DESCRIPTION);
const user = buildUserPrompt(diff);

for (const model of MODELS) {
  const start = Date.now();
  const result = await generateText({
    model: gateway(model),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    providerOptions: {
      gateway: { caching: "auto" },
      anthropic: { thinking: { type: "adaptive" } },
      openai: { reasoningEffort: "low" },
      google: { thinkingLevel: "low" },
      bedrock: { reasoningConfig: { type: "adaptive" } },
    },
  });
  const wallMs = Date.now() - start;

  const dump = {
    meta: {
      example: 3,
      model,
      description: DESCRIPTION,
      diffCommit: COMMIT,
      wallClockMs: wallMs,
      capturedAt: new Date().toISOString(),
      note: `Example 3 from EXAMPLES.md (compare mode). Model ${model}. Sibling file holds the other model's response.`,
    },
    text: result.text,
    reasoningText: result.reasoningText,
    finishReason: result.finishReason,
    usage: result.usage,
    warnings: result.warnings,
    response: result.response,
    request: result.request,
    providerMetadata: result.providerMetadata,
    content: result.content,
  };

  const outPath = new URL(
    `./summarize.${LABELS[model]}.response.json`,
    import.meta.url,
  ).pathname;
  writeFileSync(outPath, `${JSON.stringify(dump, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  console.log(`  ${model}: ${result.text.trim().split("\n")[0]}`);
}
