#!/usr/bin/env node
import {
  DEFAULT_MODEL,
  DEFAULT_OSS_MODEL,
  listModels,
  type SummarizeResult,
  summarizeDiff,
} from "@gistdiff/core";
import { defineCommand, runMain } from "citty";
import { loadEnvLocal } from "./env.js";
import { renderComparison, renderJson, renderResult } from "./render.js";
import { readStdin } from "./stdin.js";

const main = defineCommand({
  meta: {
    name: "gistdiff",
    version: "0.0.0",
    description: [
      "Generate commit messages from a git diff.",
      "",
      "Usage:",
      "  git diff --cached | gistdiff                       # subject only",
      "  git diff --cached | gistdiff -d | git commit -F -  # subject + body, full pipeline",
      "  git diff --cached | gistdiff -c                    # compare default models side-by-side",
      "  git diff --cached | gistdiff -c openai/gpt-5,xai/grok-4   # compare specific models",
      "  git diff main...feature | gistdiff -d              # PR / branch summary",
      "", // trailing blank so citty's "(name vX.Y.Z)" appends on its own line
    ].join("\n"),
  },
  args: {
    model: {
      type: "string",
      alias: "m",
      description: "gateway model id",
      default: DEFAULT_MODEL,
    },
    description: {
      type: "boolean",
      alias: "d",
      description: "include a body paragraph, not just the subject",
      default: false,
    },
    compare: {
      type: "string",
      alias: "c",
      description: `compare models side-by-side. Bare flag uses ${DEFAULT_MODEL} + ${DEFAULT_OSS_MODEL}; pass a comma-separated list of model ids to override.`,
    },
    "list-models": {
      type: "boolean",
      description: "list available gateway models and exit",
      default: false,
    },
    json: {
      type: "boolean",
      description: "machine-readable JSON output",
      default: false,
    },
  },
  async run({ args }) {
    // citty's runMain has its own error formatter that dumps raw error
    // objects on failure. Catch here so we can present a clean message
    // for gateway errors (model-not-found, auth, rate limits, etc.).
    try {
      await runGistdiff(args);
    } catch (err) {
      fail(formatError(err));
    }
  },
});

interface RunArgs {
  model: string;
  description: boolean;
  compare: string | undefined;
  "list-models": boolean;
  json: boolean;
}

async function runGistdiff(args: RunArgs): Promise<void> {
  loadEnvLocal();

  if (args["list-models"]) {
    const models = await listModels();
    for (const m of models) {
      process.stdout.write(`${m.id}\n`);
    }
    return;
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    fail(
      "AI_GATEWAY_API_KEY not set. Add it to .env.local at the repo root, or export it in your shell.",
    );
  }

  const diff = await readStdin();
  if (!diff.trim()) {
    fail(
      "No diff on stdin. Try: `git diff | gistdiff` or `git diff main...HEAD | gistdiff`",
    );
  }

  const compareModels = resolveCompareModels(args.compare);
  if (compareModels) {
    const results = await runCompare(diff, compareModels, args.description);
    if (args.json) renderJson(results);
    else renderComparison(results);
    return;
  }

  const result = await summarizeDiff(diff, {
    model: args.model,
    description: args.description,
    reasoning: true,
  });

  if (args.json) renderJson(result);
  else renderResult(result);
}

/**
 * Resolve the `--compare` flag value into a model list, or null if the
 * user didn't pass --compare at all.
 *
 * - undefined         → not in compare mode
 * - "" (bare flag)    → use the built-in defaults
 * - "a/b,c/d,..."     → split, trim, dedupe
 */
function resolveCompareModels(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  if (value === "") return [DEFAULT_MODEL, DEFAULT_OSS_MODEL];

  const models = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return models.length > 0
    ? Array.from(new Set(models))
    : [DEFAULT_MODEL, DEFAULT_OSS_MODEL];
}

/**
 * Run N models in parallel on the same diff so the user can eyeball the
 * difference. Most direct demo of the gateway's value prop: one API,
 * swap providers freely.
 */
async function runCompare(
  diff: string,
  models: string[],
  description: boolean,
): Promise<SummarizeResult[]> {
  return Promise.all(
    models.map((model) =>
      summarizeDiff(diff, { model, description, reasoning: true }),
    ),
  );
}

function fail(message: string): never {
  process.stderr.write(`gistdiff: ${message}\n`);
  process.exit(1);
}

/**
 * Extract a human-readable message from common error shapes. Hides the
 * full stack trace unless `DEBUG` is set in the environment.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (process.env.DEBUG) {
      return `${err.message}\n${err.stack ?? ""}`;
    }
    return err.message;
  }
  return String(err);
}

runMain(main);
