import { writeFileSync } from "node:fs";
import { gateway } from "@ai-sdk/gateway";
import {
  buildSystemPrompt,
  buildUserPrompt,
} from "@gistdiff/core/prompt";
import { generateText } from "ai";
import { gitDiff, loadEnvLocal } from "../lib/env.mjs";

loadEnvLocal();

const COMMIT = "1957f54";
const MODEL = "anthropic/claude-sonnet-4.6";
const DESCRIPTION = true;

const diff = gitDiff(COMMIT);
const system = buildSystemPrompt(DESCRIPTION);
const user = buildUserPrompt(diff);

const start = Date.now();
const result = await generateText({
  model: gateway(MODEL),
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
    example: 2,
    model: MODEL,
    description: DESCRIPTION,
    diffCommit: COMMIT,
    wallClockMs: wallMs,
    capturedAt: new Date().toISOString(),
    note: "Example 2 from EXAMPLES.md: refactor with -d description body.",
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

const outPath = new URL("./summarize.response.json", import.meta.url).pathname;
writeFileSync(outPath, `${JSON.stringify(dump, null, 2)}\n`);
console.log(`wrote ${outPath}`);
console.log(`text: ${result.text.trim().split("\n")[0]}`);
