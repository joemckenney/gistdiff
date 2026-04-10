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
  lines.push(`model:   ${r.model}`);
  lines.push(`latency: ${r.latencyMs}ms`);
  lines.push(formatTokens(r));
  if (r.cost) {
    lines.push(formatCost(r));
  } else {
    lines.push("cost:    (pricing unavailable for this model)");
  }
  if (r.reasoningText) {
    const preview = r.reasoningText.replace(/\s+/g, " ").slice(0, 120);
    lines.push(
      `thinking: ${preview}${r.reasoningText.length > 120 ? "…" : ""}`,
    );
  }
  return `${gray(lines.join("\n"))}\n`;
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

function formatCost(r: SummarizeResult): string {
  const c = r.cost;
  if (!c) return "";
  return `cost:    ${formatUsd(c.totalUsd)}  (in ${formatUsd(c.inputUsd)} + cache ${formatUsd(c.cachedInputUsd + c.cacheCreationUsd)} + out ${formatUsd(c.outputUsd)} + think ${formatUsd(c.reasoningUsd)})`;
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
