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

export interface SummarizeResult {
  /** Final commit message text — subject line, optionally followed by body. */
  message: string;
  /** Provider reasoning trace, if the model emitted one. */
  reasoningText?: string;
  model: string;
  usage: Usage;
  cost?: Cost;
  /** Wall-clock generation time in milliseconds. */
  latencyMs: number;
}
