import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Keys we'll extract from `.env.local`. Anything else in the file is
 * ignored — we don't want to slurp the user's other secrets into our
 * process just because we share a home with them.
 */
const KNOWN_KEYS = ["AI_GATEWAY_API_KEY"] as const;

/**
 * Load `.env.local` from the current git repo's root, scoped to known
 * gistdiff keys. Shell environment always wins over file values.
 *
 * Behavior:
 *   - If we're not in a git repo, do nothing.
 *   - If `.env.local` doesn't exist at the repo root, do nothing.
 *   - For each known key in the file: only set it if the shell hasn't
 *     already set it.
 *
 * No filesystem walking, no auto-discovery beyond the repo root. The
 * convention matches Next.js: `.env.local` lives at the project root.
 */
export function loadEnvLocal(): void {
  const root = findRepoRoot();
  if (!root) return;

  const contents = tryRead(join(root, ".env.local"));
  if (!contents) return;

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!KNOWN_KEYS.includes(key as (typeof KNOWN_KEYS)[number])) continue;
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Ask git for the repo root. Handles worktrees, submodules, GIT_DIR
 * overrides — all the edge cases a hand-rolled `.git` walker would miss.
 */
function findRepoRoot(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined; // not in a repo, or git not on PATH
  }
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
