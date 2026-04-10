/**
 * Token usage for a single generation, normalized across providers.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

/**
 * Cost breakdown for a single generation, in USD.
 *
 * Computed locally from usage × per-model pricing fetched via
 * `gateway.getAvailableModels()`. The gateway does not expose cost
 * directly on the generation response — see NOTES.md.
 */
export interface Cost {
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  cachedInputUsd: number;
  cacheCreationUsd: number;
  /** Reasoning tokens are billed at the output rate by every provider I've seen. */
  reasoningUsd: number;
}

export interface SummarizeOptions {
  /** Gateway model id, e.g. "anthropic/claude-sonnet-4.5". */
  model: string;
  /** Include a body paragraph after the subject line. */
  description?: boolean;
  /** Enable provider-side reasoning ("thinking") when supported. */
  reasoning?: boolean;
}

/**
 * Authoritative billing-side info extracted from `result.providerMetadata.gateway`.
 *
 * Surprising discovery: the gateway already includes cost (broken down),
 * routing, and per-attempt latencies on the inline response, just buried
 * inside `providerMetadata.gateway` and entirely undocumented. The
 * documented `gateway.getGenerationInfo({ id })` lookup turned out to be
 * (a) unnecessary because the data is inline and (b) currently broken
 * in `@ai-sdk/gateway@3.0.95` — it throws a generic "Gateway request
 * failed" error even though the underlying HTTP endpoint returns 200
 * with valid JSON. See NOTES.md for both rough edges.
 */
export interface GatewayInfo {
  /** The gateway-assigned generation id (`gen_<ulid>`). */
  generationId: string;
  /** The actual upstream provider that served the request (e.g. "anthropic"). */
  providerName: string;
  /** Authoritative total cost from the gateway (USD), parsed from string. */
  totalCostUsd: number;
  /** Authoritative input cost (USD). */
  inputCostUsd: number;
  /** Authoritative output cost (USD). */
  outputCostUsd: number;
  /** Server-measured provider call duration in milliseconds. */
  providerLatencyMs: number;
}

export interface SummarizeResult {
  /** Final commit message text — subject line, optionally followed by body. */
  message: string;
  /** Provider reasoning trace, if the model emitted one. */
  reasoningText?: string;
  model: string;
  usage: Usage;
  cost?: Cost;
  /** Wall-clock generation time in milliseconds (client-side). */
  latencyMs: number;
  /** Authoritative info from `gateway.getGenerationInfo`, if available. */
  gateway?: GatewayInfo;
}
