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
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // `gateway.caching: 'auto'` is the gateway-native, provider-agnostic
    // caching switch. It inserts a `cache_control` breakpoint for providers
    // that need explicit markers (Anthropic, MiniMax) and no-ops for
    // providers that cache implicitly (OpenAI, Google, DeepSeek). One flag
    // covers every provider gistdiff might route to. See NOTES.md for the
    // discoverability story — this lives in the AI Gateway product docs,
    // not the AI SDK docs.
    //
    // Reasoning, by contrast, is per-provider in the AI SDK path — there
    // is no `providerOptions.gateway.reasoning`. The keys below cover the
    // four providers that ship reasoning models on the gateway today;
    // unused keys are silently ignored when the routed model belongs to
    // a different provider, so this is safe to set unconditionally.
    providerOptions: {
      gateway: { caching: "auto" },
      ...(opts.reasoning
        ? {
            anthropic: {
              // Adaptive thinking: Claude decides when and how much to
              // think based on the task. Required for Sonnet/Opus 4.6.
              // Older Claude versions (4.5 and earlier) don't support
              // adaptive — if a user explicitly passes -m claude-sonnet-4.5
              // they'll get an error. That's a deliberate trade-off in
              // favor of using the modern API for the default model.
              thinking: { type: "adaptive" },
            },
            openai: {
              reasoningEffort: "low",
            },
            google: {
              // Gemini 3+ uses thinkingLevel; 2.5 uses thinkingBudget.
              // Setting thinkingLevel covers the modern path.
              thinkingLevel: "low",
            },
            bedrock: {
              // Anthropic models routed via Bedrock. Adaptive for 4.6;
              // older models would need `{ type: 'enabled', budgetTokens }`.
              reasoningConfig: { type: "adaptive" },
            },
          }
        : {}),
    },
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
