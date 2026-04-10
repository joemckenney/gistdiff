import { gateway } from "@ai-sdk/gateway";
import { generateText } from "ai";
import { computeCost } from "./cost.js";
import { getModelPricing } from "./models.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import type { SummarizeOptions, SummarizeResult, Usage } from "./types.js";

/**
 * Generate a commit message for a git diff using a gateway model.
 *
 * Pure function: takes a diff string + options, returns a result. No I/O
 * with the filesystem, env, or stdin — those are the CLI's concern.
 */
export async function summarizeDiff(
  diff: string,
  opts: SummarizeOptions,
): Promise<SummarizeResult> {
  const system = buildSystemPrompt(opts.description ?? false);
  const user = buildUserPrompt(diff);

  const start = Date.now();

  const result = await generateText({
    model: gateway(opts.model),
    // Using the messages array (rather than `system` + `prompt`) so we can
    // attach Anthropic prompt-cache markers to the system message. The marker
    // is provider-specific but harmless to non-Anthropic providers.
    messages: [
      {
        role: "system",
        content: system,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      { role: "user", content: user },
    ],
    providerOptions: opts.reasoning
      ? {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 2048 },
          },
          openai: {
            reasoningEffort: "low",
          },
        }
      : undefined,
  });

  const latencyMs = Date.now() - start;

  // Surface SDK warnings to stderr — they're how the gateway tells us
  // about silently-degraded behavior (cache markers ignored, unsupported
  // settings, etc.).
  if (result.warnings && result.warnings.length > 0) {
    for (const w of result.warnings) {
      process.stderr.write(`[warning] ${JSON.stringify(w)}\n`);
    }
  }

  const usage: Usage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheCreationTokens: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    totalTokens: result.usage.totalTokens ?? 0,
  };

  // Pricing lookup is best-effort. If the gateway doesn't expose pricing
  // for this model, we still return the message and usage — the CLI can
  // tell the user "cost unavailable" rather than failing the whole call.
  const pricing = await getModelPricing(opts.model).catch(() => undefined);
  const cost = pricing ? computeCost(usage, pricing) : undefined;

  return {
    message: result.text.trim(),
    reasoningText: result.reasoningText,
    model: opts.model,
    usage,
    cost,
    latencyMs,
  };
}
