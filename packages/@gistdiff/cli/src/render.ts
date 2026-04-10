import type { SummarizeResult } from "@gistdiff/core";

const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

/**
 * Write a single result to stdout (the message) and stderr (diagnostics).
 *
 * Pipe-safe: stdout only contains the commit message, so
 * `... | gistdiff | git commit -F -` works.
 */
export function renderResult(result: SummarizeResult): void {
  process.stdout.write(`${result.message}\n`);
  process.stderr.write(formatDiagnostics(result));
}

/**
 * Two results side-by-side for `--compare`. Both go to stdout because
 * comparison output isn't meaningful as a pipe target — the user is
 * reading it, not feeding it to `git commit`.
 */
export function renderComparison(results: SummarizeResult[]): void {
  for (const r of results) {
    process.stdout.write(`${gray(`── ${r.model} ─────`)}\n`);
    process.stdout.write(`${r.message}\n\n`);
    process.stdout.write(formatDiagnostics(r));
    process.stdout.write("\n");
  }
}

export function renderJson(results: SummarizeResult | SummarizeResult[]): void {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

function formatDiagnostics(r: SummarizeResult): string {
  const lines: string[] = [];
  lines.push(formatModelLine(r));
  lines.push(formatLatency(r));
  lines.push(formatTokens(r));
  lines.push(formatCostLine(r));
  if (r.reasoningText) {
    const preview = r.reasoningText.replace(/\s+/g, " ").slice(0, 120);
    lines.push(
      `thinking: ${preview}${r.reasoningText.length > 120 ? "…" : ""}`,
    );
  }
  return `${gray(lines.join("\n"))}\n`;
}

function formatModelLine(r: SummarizeResult): string {
  // Show the actual upstream provider when it differs from what the model
  // id implies (e.g. anthropic/claude-sonnet-4.6 served via bedrock).
  const modelProvider = r.model.split("/")[0];
  if (r.gateway && r.gateway.providerName !== modelProvider) {
    return `model:   ${r.model} (via ${r.gateway.providerName})`;
  }
  return `model:   ${r.model}`;
}

function formatLatency(r: SummarizeResult): string {
  if (!r.gateway || r.gateway.providerLatencyMs === 0) {
    return `latency: ${r.latencyMs}ms`;
  }
  // Server-measured provider call time + client wall clock. The delta
  // between them is gateway overhead + network round-trip.
  const overhead = r.latencyMs - r.gateway.providerLatencyMs;
  return `latency: ${r.gateway.providerLatencyMs}ms provider / ${r.latencyMs}ms wall (${overhead}ms gateway+network)`;
}

function formatTokens(r: SummarizeResult): string {
  const u = r.usage;
  const parts = [`${u.inputTokens} in`];
  if (u.cachedInputTokens > 0) {
    parts.push(`(${u.cachedInputTokens} cached)`);
  }
  if (u.cacheCreationTokens > 0) {
    parts.push(`(${u.cacheCreationTokens} cache write)`);
  }
  parts.push(`/ ${u.outputTokens} out`);
  if (u.reasoningTokens > 0) {
    parts.push(`(${u.reasoningTokens} thinking)`);
  }
  return `tokens:  ${parts.join(" ")}`;
}

/**
 * Cost line. The headline number is the authoritative total from
 * `getGenerationInfo` when available; otherwise it's the locally-computed
 * total. The breakdown is always local — the gateway only returns one
 * total number, so the breakdown is always estimated.
 *
 * If the authoritative and local totals disagree by more than rounding,
 * we annotate the line so it's visible — that itself is a finding worth
 * surfacing (and a prompt to update local pricing).
 */
function formatCostLine(r: SummarizeResult): string {
  if (!r.cost && !r.gateway) {
    return "cost:    (pricing unavailable for this model)";
  }

  const headline = r.gateway?.totalCostUsd ?? r.cost?.totalUsd ?? 0;
  const source = r.gateway ? "authoritative" : "estimated";

  let line = `cost:    ${formatUsd(headline)} (${source})`;

  if (r.cost) {
    const c = r.cost;
    line += `\n         breakdown: in ${formatUsd(c.inputUsd)} + cache ${formatUsd(c.cachedInputUsd + c.cacheCreationUsd)} + out ${formatUsd(c.outputUsd)} + think ${formatUsd(c.reasoningUsd)}`;
  }

  // Cross-check: if authoritative and local disagree by more than 1¢ or 5%,
  // call it out — could indicate stale local pricing or a billing surprise.
  if (r.gateway && r.cost) {
    const delta = Math.abs(r.gateway.totalCostUsd - r.cost.totalUsd);
    const ratio = delta / Math.max(r.gateway.totalCostUsd, 0.0001);
    if (delta > 0.01 || ratio > 0.05) {
      line += `\n         ⚠ local estimate ${formatUsd(r.cost.totalUsd)} differs from authoritative by ${formatUsd(delta)}`;
    }
  }

  return line;
}

function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function gray(s: string): string {
  // Only colorize if stderr is a TTY; otherwise stay clean.
  if (!process.stderr.isTTY) return s;
  return `${GRAY}${s}${RESET}`;
}
