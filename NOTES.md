# AI Gateway Rough Edges

Below is a list of issues encountered while building **gistdiff**, a small CLI that uses the Vercel AI Gateway via `@ai-sdk/gateway` to generate commit messages from a `git diff`. 

Each item follows the format requested in the exercise: what I tried, what went wrong, proposed solution, priority + rationale. Items are grouped by theme; within each theme they are roughly ordered by severity.

This write-up represents my developer journey, so a bunch of issues are solved upon further reading/debugging, but it seems valuable to share my real experience.

---

## Theme 1: Per-call cost observability

This was the area I explored because I wanted the CLI to print a cost breakdown to stderr alongside each commit message e.g. [example #1](./EXAMPLES.md#example-1--trivial-chore-default-subject-only)


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

**Caveat:** this is the *per-call display* slice of the cost story. Upon further reading the gateway has a substantially larger usage-attribution surface via `gateway.getSpendReport` which is probably the more valuable surface for any consumer running this kind of tool as a SaaS with multi-tenant attribution needs.

I didn't exercise that surface in this exercise as the CLI is single-tenant and doesn't need it. So the findings below are real, but they're scoped to one corner of the cost story.

### 1.1 — Cost is on the inline response, but undocumented and stringly-typed

- **Tried to do:** Read a per-call cost breakdown (input, output, cached, reasoning) from the `generateText` result so the CLI could display it inline next to the message.
- **What went wrong:** Getting at a cost *breakdown* is surprisingly hard, and the path the docs point you at is the less informative one.
  - **The documented surface returns a total, not a breakdown.** Both the [AI SDK gateway provider docs](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway#generation-lookup) and the [AI Gateway product docs](https://vercel.com/docs/ai-gateway/capabilities/usage#generation-lookup) point at `gateway.getGenerationInfo({ id })` as the way to get cost. But the response only exposes `totalCost` / `upstreamInferenceCost` — there's no per-component split for input vs. output vs. cache vs. reasoning. A consumer trying to explain cost to their users can't do it from this surface.
  - **The undocumented inline surface has more of a breakdown.** The richer data is already on `result.providerMetadata.gateway` at `{ cost, inferenceCost, inputInferenceCost, outputInferenceCost, marketCost, generationId, routing }`. None of these fields appear in either docs surface, none are in the `@ai-sdk/gateway` exported types, and every cost field is stringly-typed (`"0.004758"` instead of `0.004758`). I only discovered them by inspecting `providerMetadata` at runtime after running into issues w/ `getGenerationInfo` (see [1.2](#12--getgenerationinfo-is-buggy-3-compounding-bugs)).
  - **Net result:** a user who follows the docs gets a worse answer than one who goes off-script. The breakdown exists, the data is returned on every call, and the public surface just doesn't expose it.
- **Proposed solution:**
  - Add the per-component cost fields (`inputInferenceCost`, `outputInferenceCost`, and any cache/reasoning equivalents the gateway tracks internally) to `getGenerationInfo`'s response so the documented path is at parity with the inline path.
  - Document `result.providerMetadata.gateway.{cost, inferenceCost, inputInferenceCost, outputInferenceCost, marketCost, generationId, routing}` on the AI SDK gateway provider page with example output.
  - Add typed accessors to `@ai-sdk/gateway` — either expand the metadata schema, or ship a normalized helper like `gateway.extractCost(result)` that works against either source.
  - Convert string cost fields to numbers.
- **Priority:** **P1.** Cost tracking and breakdown is one of the gateway's more differentiated features and it's the less-discoverable of two paths, with the documented one missing data the undocumented one already returns.

### 1.2 — `getGenerationInfo` is buggy (~3 compounding bugs)

- **Tried to do:** I switched to using `gateway.getGenerationInfo({ id })` immediately after `generateText` returned, using the generation id from `providerMetadata.gateway.generationId`, to get authoritative billing data. This is the documented approach in both the AI SDK docs and the AI Gateway product docs.
- **What went wrong:** Throws `GatewayResponseError: Invalid error response format: Gateway request failed`. Tracing the SDK source and testing w/ raw `fetch` revealed a few separate but related issues:
  1. **The endpoint seems to be eventually consistent even though the docs implying otherwise.** I polled fresh ids every 500ms across 5 runs. **60% (3/5) failed to materialize within 12 seconds** and the two that succeeded both did so at exactly 8000ms. This might suggest a fixed batch flush interval. The docs page on Generation Lookup describes the endpoint as a recovery tool for streaming, which only makes sense if it's strongly consistent, but it didn't seemt to act that way.
  2. **The 404 error envelope doesn't match the SDK schema.** The `/v1/generation` endpoint returns `{error: "string", id, message}`; the SDK's `gatewayErrorResponseSchema` expects `error` to be an object like `{type, message, ...}`. Zod fails with "expected object, received string". So this endpoint serves a different error envelope than the rest of the gateway endpoints, and the SDK schema hasn't been updated to support it.
  3. **The SDK's error wrapper hides the real error.** When schema validation fails, the user sees `"Invalid error response format: Gateway request failed"`. The actually-useful underlying message (`"No usage event found"`) lives at `error.validationError.cause.issues[0].message`. The top-level message is actively misleading: it says the gateway *failed* when in fact the gateway *responded successfully* with a perfectly intelligible error that the SDK couldn't parse.
- **Confirmed not specific to my setup:** [`vercel/ai#9579`](https://github.com/vercel/ai/issues/9579) is open since March 2026, has 7 comments, and is titled literally `"GatewayResponseError: Invalid error response format: Gateway request failed 😵"`. Multiple users hitting it from different angles. Related: [`#11460`](https://github.com/vercel/ai/issues/11460) (same opaque-wrapper pattern on BFL image generation) and [`#13396`](https://github.com/vercel/ai/issues/13396) (intermittent under production load, opened the day before this writeup, labeled `bug` + `reproduction provided`). The `getGenerationInfo` feature itself was added in [`#13842`](https://github.com/vercel/ai/pull/13842), merged 2026-03-27, so i'm guessing there are still bugs to hammer out.
- **Proposed solution:** Each of the three bugs is independently actionable.
  - **Move usage event ingestion off the batch flush.** The fact that `providerMetadata.gateway.cost` is populated inline proves the gateway has the data immediately. Whatever produces the inline field could also write to the lookup table synchronously.
  - **Fix the error envelope inconsistency.** Either update `/v1/generation` to return errors in the same `{error: {type, message}}` shape as the rest of the gateway, or extend `gatewayErrorResponseSchema` to accept both shapes.
  - **Stop swallowing the underlying error.** When `safeValidateTypes` against the error schema fails, surface the raw response body in the thrown error's top-level message. The current chain produces a message that points users in exactly the wrong direction. (See also: 5.1.)
  - **Update the docs.** The Generation Lookup page should acknowledge the consistency window and recommend `result.providerMetadata.gateway` for inline use cases.
- **Priority:** **P0.** A documented endpoint that is functionally unusable for its stated primary use case w/ some challenging debugging to arrive at that conclusion.

### 1.3 — Local cost computation is structurally wrong for routing-aware gateways

- **Tried to do:** Compute per-call cost locally by multiplying `usage` × per-token rates from `gateway.getAvailableModels()`. Cross-checked the local estimate against the inline authoritative cost as a sanity check.
- **What went wrong:** For `openai/gpt-oss-120b` routed to bedrock, my local estimate was **$0.000583** vs the gateway's authoritative **$0.000286** — **51% off**. For the *same model id* routed to cerebras on a subsequent call, the numbers matched exactly. Root cause: `getAvailableModels()` returns one set of per-token rates per model id, but the gateway routes the same model id across multiple upstream providers (I observed `openai`, `bedrock`, `cerebras` for `gpt-oss-120b`; `anthropic`, `vertex-anthropic`, `bedrock` for Claude). Each upstream has different pricing. **The "list price" for a model id is less meaningful when the actual cost depends on routing.**.
- **Proposed solution:**
  - Expose per-provider pricing on `getAvailableModels()` for models that are available via multiple upstreams. The catalog already lists `fallbacksAvailable`; pricing should follow the same shape.
  - Failing that, document loudly that catalog pricing is "list price" / "indicative" and not what the customer will actually pay. Today there's no warning at all.
- **Priority:** **P3.** This isn't how cost should be computed by consumers but was admittedly confusing on my initial journey.

### 1.4 — Pricing in `getAvailableModels()` is stringly-typed

- **Tried to do:** Read `pricing.input` / `pricing.output` from `gateway.getAvailableModels()` for local cost computation.
- **What went wrong:** Returns strings (`"0.000003"`), not numbers. Same for `cachedInputTokens`, `cacheCreationInputTokens`. Every consumer has to `parseFloat`, and the docstrings literally describe the values as "Cost per input token in USD" — i.e., a numeric quantity dressed as a string.
- **Proposed solution:** Parse to `number` in the SDK before returning. Per-token rates are well within IEEE 754 double precision (the published values have at most 8 significant decimal digits; you'd need 16+ to risk loss). The "JSON precision" defense doesn't apply at these magnitudes. Same theme as the inline cost fields (1.1) — these should be the same fix.
- **Priority:** **P3.** Easy workaround and not the happy path y'all would likely prescribe. Worth noting: OpenRouter, the closest competitor gateway, returns cost as `number` throughout.

### 1.5 — `getAvailableModels()` stopped working between initial build and a re-test a few days later

- **Context:** This one surfaced while re-running the five examples a few days after capturing EXAMPLES.md, as a sanity check before finalizing the writeup. Nothing on my end had changed — same commit, same `@ai-sdk/gateway@3.0.95`, same lockfile, same Node — but the CLI's local cost breakdown line had silently disappeared from every example, while the authoritative total was still correct.
- **What I observed:**
  - Direct call: `gateway.getAvailableModels()` throws `GatewayResponseError: Invalid error response format: Gateway request failed` with `cause: "Invalid JSON response"`.
  - Raw `fetch` against `https://ai-gateway.vercel.sh/v1/models` returns 200 with valid JSON that parses cleanly (~155KB, ~150 models). So the endpoint is healthy; the SDK's Zod validation against it is what fails.
  - The CLI's rendered output shape changed from what's in EXAMPLES.md line 54 (breakdown line present, same authoritative total) to what it produces now (breakdown line absent, same authoritative total). The two runs agree on every ingredient that comes from the inline `generateText` response; they disagree only on the catalog-derived breakdown.
- **Why this is worth flagging:** it's a clean case of a pinned SDK version losing capability without any client-side change. Versioning the package pins *our* code, but the SDK's contract with the live gateway service isn't pinned in the same way — when the server response evolves (new pricing field on one model, a new model type, etc.) a strict Zod schema in the SDK rejects the whole payload, and every consumer of that method starts failing at once. The `/v1/` prefix in the URL is informal; it isn't enforcing a frozen wire format.
- **Where this compounds with earlier findings:**
  - Same opaque-wrapper pattern as **1.2** and **5.1**: "Invalid JSON response" is misleading — the JSON parses fine; it's schema validation that fails. The actually-useful detail (which field on which model entry the schema rejected) lives several `.cause` levels deep.
  - Same silent-degrade pattern the CLI itself contributes to: `getModelPricing(...).catch(() => undefined)` drops the error on the floor, so the breakdown vanishes without a warning. That's a gistdiff choice, not an SDK one — but the SDK didn't give the consumer much to work with either.
  - Ties back to **1.1**: if consumers could rely on `providerMetadata.gateway.{inputInferenceCost, outputInferenceCost}` as a documented breakdown source, the catalog round-trip wouldn't be load-bearing for this line in the first place, and this regression would have been invisible.
- **Proposed direction:**
  - **Loosen response schemas where forward-compat matters.** Zod's `.passthrough()` / `.catchall(z.unknown())` on catalog and metadata schemas would let the SDK accept new fields on new models without rejecting the whole payload. This trades a bit of strictness (unknown fields aren't typed) for resilience against normal server evolution.
  - **Sharper error messages at boundaries.** When schema validation fails, surface which path inside the payload failed ("pricing.input_cache_read on alibaba/qwen-3-14b: unknown field") rather than a generic "Invalid JSON response". Same fix applies across `getGenerationInfo`, `getAvailableModels`, and any other response-validating call.
  - **Consider wire-format versioning for the catalog.** Either honor `/v1` as a frozen contract, or let the SDK pin to a dated revision (`/v1?version=2026-04-01`), so client and server evolve on an explicit handshake rather than in lockstep-by-accident.
  - **Let consumers see drift.** A `warnings` entry when the SDK drops unrecognized fields would let careful consumers surface that their local view is degrading, rather than discovering it on a re-test weeks later.
- **Priority:** **P1.** Not because the impact on gistdiff is severe — a missing line in stderr diagnostics is cosmetic — but because the structural failure mode generalizes: any method the SDK exposes that validates a server response is vulnerable to the same silent regression on any server change. The fix is a couple of schema decorators, the impact is every current and future consumer.
- **Reproduction:** `node debugging/example-1/summarize.request.mjs` still succeeds (inline response is unaffected). A direct call to `gateway.getAvailableModels()` reproduces the throw described above.

---

## Theme 2: Caching

Caching is one of the listed deliverables for this exercise and a primary value prop of any gateway. It's also where I lost some time while implementing. Three findings.

### 2.1 — Cache thresholds vary per model, and the SDK silently no-ops below them

- **Tried to do:** Mark the system prompt as cacheable and confirm a cache hit on the second identical call. Two attempts, both producing surprises.
- **What went wrong:**
  1. **Initial attempt (Sonnet 4.5).** With a ~250-token system prompt, two consecutive identical calls returned `cachedInputTokens: 0` and `cacheCreationTokens: 0`. No warning, no error, no field on the response saying "marker ignored". Eventually I dug through the Anthropic docs and found per-model cache minimums: 1024 (Sonnet 4.5 / 4 / 3.7), 2048 (Haiku 3.5), and **4096 for Haiku 4.5 and Opus 4.5**. I artifically padded the system prompt to be above 1024 and caching kicked in immediately.
  2. **Second attempt (Sonnet 4.6).** Later, I upgraded the default model from Sonnet 4.5 to Sonnet 4.6 for the speed and adaptive thinking. Same prompt (now ~1450 tokens), same `caching: 'auto'`, same provider and againt caching silently stopped working. Sonnet 4.6 isn't in the documented threshold table at all, but empirically the threshold is *above* 1450 tokens; very likely 4096, matching the rest of the 4.5-era family. So upgrading from a known-good config to the latest model in the same family silently broke the cache demo, with no warning and no field on the response indicating the marker was ignored.
- **Proposed solution:**
  - **Emit a `CallWarning` when a `cacheControl` marker is set on content below the provider minimum.** The actual numbers should be in the message: *"Cache marker on system message ignored: 1450 tokens, anthropic/claude-haiku-4.5 minimum is 4096."* The SDK already has a warnings array on the response, which could be a good place for this type of information.
  - **Expose per-model cache thresholds via `getAvailableModels()`** so library code can validate cacheability.
- **Priority:** **P2.** The silent failures were momentarily confusing and reuqired some docs spelunking.

### 2.2 — The better caching API (`caching: 'auto'`) is hidden in the wrong doc surface

- **Tried to do:** Find the canonical way to enable prompt caching in the AI SDK + Gateway path.
- **What went wrong:** The AI SDK docs (`ai-sdk.dev`) explains the per-provider manual marker approach (`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }`).  I initially built around the manual API and discovered `providerOptions.gateway.caching: 'auto'` later, on the Vercel **product** docs page (`vercel.com/docs/ai-gateway/models-and-providers/automatic-caching`). The auto API seems strictly better i.e. it's provider-agnostic, less code, removes provider-specific knowledge from consumer code. But I didn't find it initially reading the SDK docs. So seemingly an inconsistency between the two doc surfaces.
- **Proposed solution:**
  - A central "Prompt Caching" guide on `ai-sdk.dev` that leads with `providerOptions.gateway.caching: 'auto'` and presents manual markers as the fine-grained-control fallback.
  - Cross-link aggressively from each provider page back to the central guide. Right now the Anthropic provider page is a dead end.
- **Priority:** **P1.** Discoverability gap. Users, like me, might not find the better API and instead they end up coupling their code to provider-specific knowledge that the gateway is supposed to abstract away.

### 2.3 — `caching: 'auto'` is documented but missing from the SDK type schema

- **Tried to do:** Use `providerOptions.gateway.caching: 'auto'` in TypeScript (per the docs from 2.2).
- **What went wrong:** It works at runtime, but the explicit `gatewayProviderOptions` Zod schema exported from `@ai-sdk/gateway@3.0.95` doesn't include a `caching` field. TypeScript silently accepts the field because `providerOptions` is loose, but a strictly-typed wrapper would reject it and IDE completion doesn't suggest it.
- **Proposed solution:** Add `caching: 'auto'` (and any other documented options) to `gatewayProviderOptions`. More broadly, the SDK package types should ship in lockstep with the docs.
- **Priority:** **P2.** A paper cut, but one of a few on the caching-specific journey.

---

## Theme 3: Reasoning observability 

Reasoning is one of the listed deliverables. Two findings, both about how reasoning data is reported through the SDK.

### 3.1 — Anthropic reasoning tokens come back as `0` — should be `null` ("unavailable")

- **Tried to do:** Display "X tokens were spent thinking, Y on the final answer" in the CLI's stderr summary, sourced from `result.usage.outputTokenDetails.reasoningTokens`.
- **What went wrong:** With extended thinking enabled on `claude-sonnet-4.5`, the response includes a `reasoningText` paragraph (the model is clearly thinking) but `outputTokenDetails.reasoningTokens` returns `0`. By contrast, `deepseek/deepseek-v3.2-thinking` correctly returns non-zero reasoning tokens via the same SDK call site. So this is Anthropic-specific.
- **Canonical answer (from the Vercel docs at `/docs/ai-gateway/capabilities/reasoning`):** *"Anthropic counts thinking tokens as output tokens with no separate breakdown."* And from the Anthropic-specific reasoning page: *"Claude 4 models return summarized thinking output, not full thinking tokens. You're charged for the full thinking tokens, but the response contains a condensed summary."* So Anthropic doesn't expose this data at all — it's a fundamental observability gap baked into the upstream product surface, not a bug at any layer downstream. **However**, the SDK's choice to return `0` (rather than `null` or a sentinel) is *misleading*: a downstream consumer can't tell the difference between "definitely no thinking" and "thinking happened, but the provider doesn't report it". A user looking at "0 thinking tokens" assumes the reasoning is free, when in fact they're paying for an opaque amount of it folded into output cost.
- **Proposed solution:**
  - **Return `null` for `reasoningTokens` when the upstream provider doesn't expose the breakdown.** `null` means "unavailable", `0` means "definitely none". This is a one-line fix in the Anthropic adapter that would give consumers an honest signal.
  - **Document the distinction prominently** on the Anthropic provider page in the AI SDK docs, which is currently silent on the question.
- **Priority:** **P1.** Not a fixable bug at the upstream layer, but the misleading sentinel value is fixable today.

### 3.2 — The normalized reasoning API only exists on the OpenAI compat surface

- **Tried to do:** Find a single switch, paralleling `providerOptions.gateway.caching: 'auto'`, to enable reasoning across providers without writing per-provider config.
- **What went wrong:** It doesn't exist on the AI SDK direct path. The AI Gateway capabilities/reasoning page is explicit: *"each provider's native reasoning configuration is passed through `providerOptions`."* So consumers must write `providerOptions.openai.reasoningEffort`, `providerOptions.anthropic.thinking`,  etc.  One key/config per provider with provider-specific shapes. 
- **Proposed solution:**
  - **Bring the normalized `reasoning` API to the AI SDK side** as `providerOptions.gateway.reasoning: { effort, max_tokens }`, mirroring `providerOptions.gateway.caching`. The gateway already does the mapping server-side; the SDK just needs to forward the field.
  - Until then, the AI SDK reasoning docs should at minimum show the normalized API as an alternative for users who want provider-agnostic reasoning, rather than pretending it doesn't exist.
- **Priority:** **P1.** Same theme as the caching API split (2.2). Gateway-normalized concepts that exist on only one of two surfaces fragment the developer experience and undermine the gateway's value prop.

---

## Theme 4: Provider routing

Routing is the one of the gateway's more differentiated features and the data to support all of this is on every response, but it's not well-documented or surfaced. Two findings.

### 4.1 — Per-call routing data and provider latency are buried in `providerMetadata`

- **Tried to do:** While dumping `providerMetadata` for the cost investigation in 1.1, noticed a `routing` object containing rich per-call routing information.
- **What went wrong:** It's all there — `originalModelId`, `resolvedProvider`, `finalProvider`, `fallbacksAvailable`, a human-readable `planningReasoning` string, per-attempt timings, response ids etc, but it's not documented (at least anywhere i could find). Two empirical demonstrations of why this matters:
  1. **Routing transparency.** Two consecutive calls with `openai/gpt-oss-120b` were served by **bedrock** then **cerebras** respectively. Without inspecting `providerMetadata.gateway.routing.finalProvider`, a user has no idea their gpt-oss calls are bouncing between completely different upstream providers with completely different per-token pricing (see 1.3) and completely different latency characteristics (below).
  2. **Hidden routing overhead.** A `gpt-oss-120b` call routed to bedrock showed **110ms** of provider latency (computed from `routing.modelAttempts[0].providerAttempts[0].endTime - startTime`) wrapped in **4972ms** of wall clock — **4862ms** of "gateway + network" overhead, completely invisible without inspecting per-attempt timings. Could be cold start, routing logic, network slowness, or a fallback that wasn't logged. The user sees "5 seconds" with no way to diagnose.
- **Proposed solution:**
  - **Surface routing info on normalized fields**, not buried inside `providerMetadata.gateway.routing`. Users shouldn't have to walk `routing.modelAttempts[0].providerAttempts[0].provider` to find out who served their call.
  - **Document everything that's currently in `providerMetadata.gateway`.** A page listing every field, with example values and what they mean. Today there's nothing.
  - **Surface `providerLatencyMs` (server-measured) alongside the wall clock** as a normalized field. Pair with `latency` from `getGenerationInfo` once that endpoint becomes usable (1.2). This is the single most useful diagnostic for "is the gateway adding overhead?".
  - **Build a `--show-routing` mode** (or equivalent SDK helper) for consumers debugging routing decisions.
- **Priority:** **P2.** Not a bug, but a differentiating feature with low-discoverability. Users won't ask for what they don't know exists, and the customers who do find this data will become advocates. It's better than what most competing gateways expose.

---

## Theme 5: Error handling — small fixes that compound

One finding, but it compounds with several others above (1.2 in particular).

### 5.1 — SDK errors dump 50-line raw object stack traces by default

- **Tried to do:** Pass an invalid model id (`gistdiff -m bogus/model`) to see what the user experience looks like for a typo.
- **What went wrong:** Got a ~50-line raw object dump including the full request body, response headers, retry state, and stack traces into the SDK internals. The actually-useful part — `Model 'bogus/model' not found` — was buried inside a nested `responseBody` JSON string. The same pattern applies to every other error class: every consumer of the SDK ends up writing the same 10-15-line wrapper to extract the human-readable message. I wrote one in the gistdiff CLI; the next consumer will write one too.
- **Compounding effect:** This is the same opaque-output pattern that produces "Invalid error response format: Gateway request failed" in 1.2. New users hit a wall of internals on their first error, regardless of the underlying cause, and they look identical. The first impression is "the SDK is broken", when in fact every one of these has a clean human-readable underlying error somewhere inside the wrapper.
- **Proposed solution:**
  - Gateway errors already expose a clean `message` field on the `GatewayError` base class. The SDK's default unhandled-rejection path should *use* it instead of dumping the entire error object.
  - When a `runMain`-style helper in the AI SDK ecosystem encounters a `GatewayError`, it should call `.message` and exit, not dump the object.
  - Pair with the fixes in 1.2 to ensure the underlying error actually *makes it into* `.message` in the first place (rather than being three levels deep in `validationError.cause.issues[0]`).
- **Priority:** **P1.** First-impression UX, easy fix. Combined with 1.2, this is the difference between "the SDK is friendly to debug against" and "every error looks like a bug in the SDK".

---

## Cross-cutting observation: documentation drift between two surfaces

Several of the items above reference the same underlying structural problem. The `@ai-sdk/gateway` package is documented on **two separate surfaces**:

- `ai-sdk.dev` — the AI SDK docs
- `vercel.com/docs/ai-gateway` — the Vercel AI Gateway product docs

The two surfaces are not synchronized. Several of the most important features of the gateway — `caching: 'auto'` (2.2), the normalized reasoning API (3.2), the inline `providerMetadata.gateway.cost` field (1.1) — are documented on the product docs surface but missing or incorrect on the SDK docs surface. In some cases the SDK docs actively recommend the inferior option (e.g., showing only manual cache markers, or pointing users to the broken `getGenerationInfo` for cost when the data is already inline). The published SDK type schema is likewise out-of-date with what the gateway actually accepts and returns.
