import { gateway } from "@ai-sdk/gateway";

/**
 * Default closed/proprietary model. Anthropic Sonnet 4.6 handles diffs
 * well and supports prompt caching + adaptive extended thinking.
 */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

/**
 * Default open/OSS model used for the `compare` flow. OpenAI's open-weights
 * reasoning model — interesting to contrast with the closed default.
 */
export const DEFAULT_OSS_MODEL = "openai/gpt-oss-120b";

/**
 * Pricing for a model, in USD per token. Strings are parsed to numbers
 * here so the rest of the codebase can treat them as numeric.
 *
 * (The gateway returns these as strings — see NOTES.md for the rationale
 * and the rough-edge writeup.)
 */
export interface ModelPricing {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  cachedInputUsdPerToken?: number;
  cacheCreationUsdPerToken?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  pricing?: ModelPricing;
}

/**
 * Fetch the catalog of language models available on the gateway.
 *
 * Filters out non-language model types (embedding, image, video) so
 * callers don't have to.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const { models } = await gateway.getAvailableModels();
  return models
    .filter((m) => !m.modelType || m.modelType === "language")
    .map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? undefined,
      pricing: m.pricing ? parsePricing(m.pricing) : undefined,
    }));
}

/**
 * Get pricing for a specific model id, or `undefined` if the gateway
 * doesn't expose it.
 */
export async function getModelPricing(
  modelId: string,
): Promise<ModelPricing | undefined> {
  const models = await listModels();
  return models.find((m) => m.id === modelId)?.pricing;
}

function parsePricing(p: {
  input: string;
  output: string;
  cachedInputTokens?: string;
  cacheCreationInputTokens?: string;
}): ModelPricing {
  return {
    inputUsdPerToken: Number.parseFloat(p.input),
    outputUsdPerToken: Number.parseFloat(p.output),
    cachedInputUsdPerToken: p.cachedInputTokens
      ? Number.parseFloat(p.cachedInputTokens)
      : undefined,
    cacheCreationUsdPerToken: p.cacheCreationInputTokens
      ? Number.parseFloat(p.cacheCreationInputTokens)
      : undefined,
  };
}
