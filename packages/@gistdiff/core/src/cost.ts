import type { ModelPricing } from "./models.js";
import type { Cost, Usage } from "./types.js";

/**
 * Compute the dollar cost of a generation from token usage and per-model
 * pricing.
 *
 * Note: every provider I've checked bills reasoning tokens at the output
 * rate, so we lump them in there. If a provider ever splits the rate out,
 * the gateway pricing schema would need a `reasoningTokens` field too.
 */
export function computeCost(usage: Usage, pricing: ModelPricing): Cost {
  // Cached and freshly-created cache tokens are billed at their own rates;
  // remaining input tokens are billed at the standard input rate.
  const standardInputTokens =
    usage.inputTokens - usage.cachedInputTokens - usage.cacheCreationTokens;

  const inputUsd = standardInputTokens * pricing.inputUsdPerToken;
  const cachedInputUsd =
    usage.cachedInputTokens *
    (pricing.cachedInputUsdPerToken ?? pricing.inputUsdPerToken);
  const cacheCreationUsd =
    usage.cacheCreationTokens *
    (pricing.cacheCreationUsdPerToken ?? pricing.inputUsdPerToken);

  // Output tokens already include reasoning tokens in the AI SDK's accounting,
  // so we don't double-count. We surface the reasoning slice separately for
  // visibility.
  const outputUsd =
    (usage.outputTokens - usage.reasoningTokens) * pricing.outputUsdPerToken;
  const reasoningUsd = usage.reasoningTokens * pricing.outputUsdPerToken;

  return {
    inputUsd,
    cachedInputUsd,
    cacheCreationUsd,
    outputUsd,
    reasoningUsd,
    totalUsd:
      inputUsd + cachedInputUsd + cacheCreationUsd + outputUsd + reasoningUsd,
  };
}
