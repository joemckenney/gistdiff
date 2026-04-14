# Examples

Real `gistdiff` output on real commits from this repo's own history. Each
example shows the diff that was piped in, the flags used, and both stdout
and stderr exactly as the tool produced them.

## How to read these

- **stdout** is the commit message — pipe-safe, so `git diff --cached | gistdiff | git commit -F -` just works.
- **stderr** is the diagnostics block: model, latency (provider vs wall-clock), token usage, and cost. ANSI colors are stripped when stderr isn't a TTY, so what you see below is the exact text produced.
- `--compare` and `--json` write their full output to **stdout only** — stderr is empty for those modes by design.

All runs use the current default model (`anthropic/claude-sonnet-4.6`) with
adaptive reasoning enabled, against `gistdiff@0.1.0`. Reproduce any of them
with the command shown.

---

## Example 1 — trivial chore, default (subject only)

Tests whether the tool over-explains a one-line diff. Spoiler: it doesn't.

**Command:**

```sh
git diff 6aa8d21~1..6aa8d21 | gistdiff
```

**Diff (7 lines):**

```diff
diff --git a/.npmrc b/.npmrc
deleted file mode 100644
index 3e775ef..0000000
--- a/.npmrc
+++ /dev/null
@@ -1 +0,0 @@
-auto-install-peers=true
```

**stdout:**

```
chore: remove .npmrc auto-install-peers setting
```

**stderr:**

```
model:   anthropic/claude-sonnet-4.6
latency: 1315ms provider / 1875ms wall (560ms gateway+network)
tokens:  1477 in / 16 out
cost:    $0.004671 (authoritative)
         breakdown: in $0.004431 + cache $0 + out $0.00024 + think $0
```

Note the latency split: 1315ms is what the upstream provider actually took
(from gateway metadata), 1875ms is wall-clock, so 560ms is gateway overhead
plus network round-trip from here to Vercel.

---

## Example 2 — refactor, `-d` for body

Tests semantic understanding on a change that swaps APIs without altering
behavior. The tool needs to recognize "same thing, different mechanism"
and describe *what was replaced* rather than *what the new code does*.

**Command:**

```sh
git diff 1957f54~1..1957f54 | gistdiff -d
```

**Diff (55 lines):**

```diff
diff --git a/packages/@gistdiff/core/src/summarize.ts b/packages/@gistdiff/core/src/summarize.ts
index 70eefb4..dc9c397 100644
--- a/packages/@gistdiff/core/src/summarize.ts
+++ b/packages/@gistdiff/core/src/summarize.ts
@@ -22,29 +22,30 @@ export async function summarizeDiff(

   const result = await generateText({
     model: gateway(opts.model),
-    // Using the messages array (rather than `system` + `prompt`) so we can
-    // attach Anthropic prompt-cache markers to the system message. The marker
-    // is provider-specific but harmless to non-Anthropic providers.
     messages: [
-      {
-        role: "system",
-        content: system,
-        providerOptions: {
-          anthropic: { cacheControl: { type: "ephemeral" } },
-        },
-      },
+      { role: "system", content: system },
       { role: "user", content: user },
     ],
-    providerOptions: opts.reasoning
-      ? {
-          anthropic: {
-            thinking: { type: "enabled", budgetTokens: 2048 },
-          },
-          openai: {
-            reasoningEffort: "low",
-          },
-        }
-      : undefined,
+    // `gateway.caching: 'auto'` is the gateway-native, provider-agnostic
+    // caching switch. It inserts a `cache_control` breakpoint for providers
+    // that need explicit markers (Anthropic, MiniMax) and no-ops for
+    // providers that cache implicitly (OpenAI, Google, DeepSeek). One flag
+    // covers every provider gistdiff might route to. See NOTES.md for the
+    // discoverability story — this lives in the AI Gateway product docs,
+    // not the AI SDK docs.
+    providerOptions: {
+      gateway: { caching: "auto" },
+      ...(opts.reasoning
+        ? {
+            anthropic: {
+              thinking: { type: "enabled", budgetTokens: 2048 },
+            },
+            openai: {
+              reasoningEffort: "low",
+            },
+          }
+        : {}),
+    },
   });

   const latencyMs = Date.now() - start;
```

**stdout:**

```
refactor(core): switch to gateway-native caching with `gateway.caching: 'auto'`

Replaces the Anthropic-specific `cacheControl` provider option on the
system message with a single `gateway: { caching: "auto" }` flag that
works across all providers gistdiff may route to (Anthropic, MiniMax,
OpenAI, Google, DeepSeek). The reasoning provider options are preserved
and merged in alongside the new caching flag.
```

**stderr:**

```
model:   anthropic/claude-sonnet-4.6
latency: 3066ms provider / 3465ms wall (399ms gateway+network)
tokens:  2131 in / 116 out
cost:    $0.008133 (authoritative)
         breakdown: in $0.006393 + cache $0 + out $0.00174 + think $0
```

The tool correctly picks `refactor:` (no behavior change) and enumerates
the providers from the in-diff comment rather than hallucinating a list.

---

## Example 3 — side-by-side model comparison with `-c`

The hero demo for the AI Gateway value prop: same diff, two models, one
API, zero code changes. Bare `-c` uses the two built-in defaults (one
proprietary, one OSS).

**Command:**

```sh
git diff a9d9cbd~1..a9d9cbd | gistdiff -c
```

**Diff (62 lines):**

```diff
diff --git a/packages/@gistdiff/core/src/models.ts b/packages/@gistdiff/core/src/models.ts
index fffc05a..4503fd5 100644
--- a/packages/@gistdiff/core/src/models.ts
+++ b/packages/@gistdiff/core/src/models.ts
@@ -1,10 +1,10 @@
 import { gateway } from "@ai-sdk/gateway";

 /**
- * Default closed/proprietary model. Anthropic Sonnet handles diffs well
- * and supports prompt caching + extended thinking.
+ * Default closed/proprietary model. Anthropic Sonnet 4.6 handles diffs
+ * well and supports prompt caching + adaptive extended thinking.
  */
-export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
+export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

 /**
  * Default open/OSS model used for the `compare` flow. OpenAI's open-weights
diff --git a/packages/@gistdiff/core/src/summarize.ts b/packages/@gistdiff/core/src/summarize.ts
index dc9c397..f2b1afb 100644
--- a/packages/@gistdiff/core/src/summarize.ts
+++ b/packages/@gistdiff/core/src/summarize.ts
@@ -33,16 +33,38 @@ export async function summarizeDiff(
     // covers every provider gistdiff might route to. See NOTES.md for the
     // discoverability story — this lives in the AI Gateway product docs,
     // not the AI SDK docs.
+    //
+    // Reasoning, by contrast, is per-provider in the AI SDK path — there
+    // is no `providerOptions.gateway.reasoning`. The keys below cover the
+    // four providers that ship reasoning models on the gateway today;
+    // unused keys are silently ignored when the routed model belongs to
+    // a different provider, so this is safe to set unconditionally.
     providerOptions: {
       gateway: { caching: "auto" },
       ...(opts.reasoning
         ? {
             anthropic: {
-              thinking: { type: "enabled", budgetTokens: 2048 },
+              // Adaptive thinking: Claude decides when and how much to
+              // think based on the task. Required for Sonnet/Opus 4.6.
+              // Older Claude versions (4.5 and earlier) don't support
+              // adaptive — if a user explicitly passes -m claude-sonnet-4.5
+              // they'll get an error. That's a deliberate trade-off in
+              // favor of using the modern API for the default model.
+              thinking: { type: "adaptive" },
             },
             openai: {
               reasoningEffort: "low",
             },
+            google: {
+              // Gemini 3+ uses thinkingLevel; 2.5 uses thinkingBudget.
+              // Setting thinkingLevel covers the modern path.
+              thinkingLevel: "low",
+            },
+            bedrock: {
+              // Anthropic models routed via Bedrock. Adaptive for 4.6;
+              // older models would need `{ type: 'enabled', budgetTokens }`.
+              reasoningConfig: { type: "adaptive" },
+            },
           }
         : {}),
     },
```

**stdout:**

```
── anthropic/claude-sonnet-4.6 ─────
refactor(core): upgrade default model to Claude Sonnet 4.6 with adaptive thinking

model:   anthropic/claude-sonnet-4.6
latency: 873ms provider / 1360ms wall (487ms gateway+network)
tokens:  2283 in / 24 out
cost:    $0.007209 (authoritative)
         breakdown: in $0.006849 + cache $0 + out $0.00036 + think $0

── openai/gpt-oss-120b ─────
feat(core): upgrade default model to 4.6 and enable adaptive thinking

model:   openai/gpt-oss-120b (via cerebras)
latency: 472ms provider / 878ms wall (406ms gateway+network)
tokens:  2010 in / 418 out
cost:    $0.001017 (authoritative)
         breakdown: in $0.000703 + cache $0 + out $0.000314 + think $0
thinking: We need to produce a commit message following Conventional Commits. We have changes: updating default model version from…
```

Three things worth noticing here:

1. **Different opinions on the same diff.** Claude picks `refactor:` (the `DEFAULT_MODEL` constant is being updated — config rewrite). gpt-oss picks `feat:` (a user-facing default is being upgraded). Both are defensible — a reviewer would need to decide which framing they prefer.
2. **~7× cost difference, ~2× speed difference.** Same diff, same API, wildly different economics. The `(via cerebras)` label shows gpt-oss is being routed through Cerebras inference — that level of provider transparency is pure gateway metadata.
3. **Thinking preview only on gpt-oss.** Claude's adaptive thinking decided this task didn't warrant much reasoning (0 thinking tokens); gpt-oss produces verbose reasoning that the CLI truncates to 120 chars.

---

## Example 4 — meaty feature, `-d` for body

Tests body generation on a substantial feature diff. Shows the tool
producing a bulleted summary rather than a wall of prose.

**Command:**

```sh
git diff 9e435b4~1..9e435b4 | gistdiff -d
```

<details>
<summary>Diff (282 lines — click to expand)</summary>

Full diff available on GitHub:
[`9e435b4` — extract authoritative billing and latency from gateway metadata](https://github.com/joemckenney/gistdiff/commit/9e435b4)

Summary of what changed: adds a `GatewayInfo` type and optional `gateway`
field on `SummarizeResult`, extracts generation id + cost breakdown +
provider name + per-attempt latency from the AI SDK's
`providerMetadata.gateway` shape, and updates the CLI diagnostics block
to show authoritative vs. estimated costs and a provider/gateway latency
split.

</details>

**stdout:**

```
feat(core): extract authoritative billing and latency from gateway metadata

Pull `providerMetadata.gateway` out of the AI SDK inline response to
surface real cost figures, upstream provider routing, and server-measured
provider latency — none of which were previously visible.

- Add `GatewayInfo` type and `gateway?` field on `SummarizeResult`
- Extract generation id, cost breakdown, provider name, and per-attempt
  latency from the undocumented `providerMetadata.gateway` shape
- Update the CLI diagnostics block to show provider/gateway latency
  split, authoritative vs. estimated cost labeling, cost breakdown on
  a second line, and a warning when local and authoritative totals
  diverge by more than 1¢ or 5%
- Show "via <provider>" in the model line when the gateway routes to a
  provider that differs from the model-id prefix
```

**stderr:**

```
model:   anthropic/claude-sonnet-4.6
latency: 6536ms provider / 7100ms wall (564ms gateway+network)
tokens:  5316 in / 213 out
cost:    $0.019143 (authoritative)
         breakdown: in $0.015948 + cache $0 + out $0.003195 + think $0
```

Body structure (subject + paragraph + bullets) maps cleanly to the
conventional commit shape. Cost scales as expected: 5316 input tokens
drives most of the ~$0.019 bill.

---

## Example 5 — structured output with `--json`

Tests the programmatic surface. Everything the text renderer shows on
stderr is available as structured fields — plus the `gateway.generationId`,
which is what you'd use to correlate a run with Vercel's logs dashboard.

**Command:**

```sh
git diff 13800ff~1..13800ff | gistdiff --json
```

<details>
<summary>Diff (184 lines — click to expand)</summary>

Full diff available on GitHub:
[`13800ff` — add NOTES.md with AI Gateway rough edges writeup](https://github.com/joemckenney/gistdiff/commit/13800ff)

Summary of what changed: adds `NOTES.md` at the repo root documenting
the AI Gateway pain points encountered while building gistdiff, and
updates `.gitignore` to track `NOTES.md` while ignoring its earlier
draft (`notes.v1.md`).

</details>

**stdout:**

```json
{
  "message": "docs: add AI Gateway rough edges write-up as NOTES.md",
  "reasoningText": "The diff shows two changes:\n1. `.gitignore` - updated to ignore `notes.v1.md` instead of `NOTES.md`\n2. `NOTES.md` - new file added with extensive notes about AI Gateway rough edges\n\nThis is adding a tracked notes/documentation file and updating gitignore accordingly.",
  "model": "anthropic/claude-sonnet-4.6",
  "usage": {
    "inputTokens": 7775,
    "outputTokens": 105,
    "reasoningTokens": 0,
    "cachedInputTokens": 0,
    "cacheCreationTokens": 0,
    "totalTokens": 7880
  },
  "cost": {
    "inputUsd": 0.023325000000000002,
    "cachedInputUsd": 0,
    "cacheCreationUsd": 0,
    "outputUsd": 0.001575,
    "reasoningUsd": 0,
    "totalUsd": 0.024900000000000002
  },
  "latencyMs": 3449,
  "gateway": {
    "generationId": "gen_01KP4KVEWQ0FTSDQ104KP3SGKS",
    "providerName": "anthropic",
    "totalCostUsd": 0.0249,
    "inputCostUsd": 0.023325,
    "outputCostUsd": 0.001575,
    "providerLatencyMs": 2963
  }
}
```

`cost.totalUsd` is the local estimate (pricing table in `models.ts`);
`gateway.totalCostUsd` is the authoritative number the gateway billed
you. They agree here. When they diverge by >1¢ or >5%, the text
renderer surfaces a warning; programmatic consumers can check the
fields directly.

---

## Reproducing

Every example above was generated by running:

```sh
git diff <commit>~1..<commit> | gistdiff [flags]
```

against a clean checkout with `AI_GATEWAY_API_KEY` exported (or present
in `.env.local`). Outputs will vary across runs — model sampling isn't
deterministic — but the shapes and cost magnitudes are stable.

Total API cost for regenerating all five on the run shown here was
$0.065 (sum of the authoritative per-run costs above). Expect some
variance across runs. Provider routing and adaptive-thinking budgets
aren't deterministic.
