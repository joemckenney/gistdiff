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

I didn't exercise that surface, so the findings below are real, but they're scoped to one corner of the cost story.

### 1.1 — Cost is on the inline response, but undocumented and stringly-typed

- **Tried to do:** Read a per-call cost breakdown (input, output, cached, reasoning) from the `generateText` result so the CLI could display it inline next to the message.
- **What went wrong:** Getting at a cost *breakdown* is surprisingly hard, and the path the docs point you at is the less informative one.
  - **The documented surface returns a total, not a breakdown.** Both the [AI SDK gateway provider docs](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway#generation-lookup) and the [AI Gateway product docs](https://vercel.com/docs/ai-gateway/capabilities/usage#generation-lookup) point at `gateway.getGenerationInfo({ id })` as the way to get cost. But the response only exposes `totalCost` / `upstreamInferenceCost`, with no per-component split for input vs. output vs. cache vs. reasoning. A consumer trying to explain cost to their users can't do it from this surface.
  - **The undocumented inline surface has more of a breakdown.** The richer data is already on `result.providerMetadata.gateway` at `{ cost, inferenceCost, inputInferenceCost, outputInferenceCost, marketCost, generationId, routing }`. None of these fields appear in either docs surface, none are in the `@ai-sdk/gateway` exported types, and every cost field is stringly-typed (`"0.004758"` instead of `0.004758`). I only discovered them by inspecting `providerMetadata` at runtime after running into issues w/ `getGenerationInfo` (see [1.2](#12--getgenerationinfo-is-buggy-3-compounding-bugs)).
- **Proposed solution:**
  - Add the per-component cost fields (`inputInferenceCost`, `outputInferenceCost`, and any cache/reasoning equivalents the gateway tracks internally) to `getGenerationInfo`'s response so the documented path is at parity with the inline path.
  - Document `result.providerMetadata.gateway.{cost, inferenceCost, inputInferenceCost, outputInferenceCost, marketCost, generationId, routing}` on the AI SDK gateway provider page with example output.
  - Add typed accessors to `@ai-sdk/gateway`: either expand the metadata schema, or ship a normalized helper like `gateway.extractCost(result)` that works against either source.
  - Convert string cost fields to numbers.
- **Priority:** **P1.** Cost tracking and breakdown is one of the gateway's more differentiated features and it's the less-discoverable of two paths, with the documented one missing data the undocumented one already returns.

### 1.2 — `getGenerationInfo` is buggy (~3 compounding bugs)

- **Tried to do:** I switched to using `gateway.getGenerationInfo({ id })` immediately after `generateText` returned, using the generation id from `providerMetadata.gateway.generationId`, to get authoritative billing data. This is the documented approach in both the AI SDK docs and the AI Gateway product docs.
- **What went wrong:** Throws `GatewayResponseError: Invalid error response format: Gateway request failed`. Tracing the SDK source and testing w/ raw `fetch` revealed a few separate but related issues:
  1. **The endpoint seems to be eventually consistent even though the docs implying otherwise.** I polled fresh ids every 500ms across 5 runs. 3/5 failed to materialize within 12 seconds. The docs page on Generation Lookup describes the endpoint as a recovery tool for streaming, which only makes sense if it's strongly consistent, but it didn't seem to act that way.
  2. **The 404 error envelope doesn't match the SDK schema.** The `/v1/generation` endpoint returns `{error: "string", id, message}`; the SDK's `gatewayErrorResponseSchema` expects `error` to be an object like `{type, message, ...}`. Zod fails with "expected object, received string". So this endpoint serves a different error envelope than the rest of the gateway endpoints, and the SDK schema hasn't been updated to support it.
  3. **The SDK's error wrapper hides the real error.** When schema validation fails, the user sees `"Invalid error response format: Gateway request failed"`. The actually-useful underlying message (`"No usage event found"`) lives at `error.validationError.cause.issues[0].message`. The top-level message is actively misleading: it says the gateway *failed* when in fact the gateway *responded successfully* with a perfectly intelligible error that the SDK couldn't parse.
- **Proposed solution:** Each of the three bugs is independently actionable.
  - **Move usage event ingestion off the batch flush.** The fact that `providerMetadata.gateway.cost` is populated inline proves the gateway has the data immediately. Whatever produces the inline field could also write to where this is being looked up from synchronously.
  - **Fix the error envelope inconsistency.** Either update `/v1/generation` to return errors in the same `{error: {type, message}}` shape as the rest of the gateway, or extend `gatewayErrorResponseSchema` to accept both shapes.
  - **Stop swallowing the underlying error.** When `safeValidateTypes` against the error schema fails, surface the raw response body in the thrown error's top-level message. The current chain produces a message that points users in exactly the wrong direction. (See also: [5.1](#51--sdk-errors-dump-50-line-raw-object-stack-traces-by-default).)
  - **Update the docs.** The Generation Lookup page should acknowledge the consistency window and recommend `result.providerMetadata.gateway` for inline use cases.
- **Priority:** **P0.** A documented endpoint that is functionally unusable for its stated primary use case w/ some challenging debugging to arrive at that conclusion.

### 1.3 — Local cost computation is structurally wrong for routing-aware gateways

- **Tried to do:** Compute per-call cost locally by multiplying `usage` × per-token rates from `gateway.getAvailableModels()`. Cross-checked the local estimate against the inline authoritative cost as a sanity check.
- **What went wrong:** For `openai/gpt-oss-120b` routed to bedrock, my local estimate was **$0.000583** vs the gateway's authoritative **$0.000286** (**51% off**). For the *same model id* routed to cerebras on a subsequent call, the numbers matched exactly. Root cause: `getAvailableModels()` returns one set of per-token rates per model id, but the gateway routes the same model id across multiple upstream providers (I observed `openai`, `bedrock`, `cerebras` for `gpt-oss-120b`; `anthropic`, `vertex-anthropic`, `bedrock` for Claude). Each upstream has different pricing. **The "list price" for a model id is less meaningful when the actual cost depends on routing.**
- **Proposed solution:**
  - Expose per-provider pricing on `getAvailableModels()` for models that are available via multiple upstreams. The catalog already lists `fallbacksAvailable`; pricing should follow the same shape.
  - Failing that, document loudly that catalog pricing is "list price" / "indicative" and not what the customer will actually pay. Today there's no warning at all.
- **Priority:** **P3.** This isn't how cost should be computed by consumers but was admittedly confusing on my initial journey.

### 1.4 — Pricing in `getAvailableModels()` is stringly-typed

- **Tried to do:** Read `pricing.input` / `pricing.output` from `gateway.getAvailableModels()` for local cost computation.
- **What went wrong:** Returns strings (`"0.000003"`), not numbers. Same for `cachedInputTokens`, `cacheCreationInputTokens`. Every consumer has to `parseFloat`, and the docstrings literally describe the values as "Cost per input token in USD", i.e., a numeric quantity dressed as a string.
- **Proposed solution:** Parse to `number` in the SDK before returning. Per-token rates are well within IEEE 754 double precision (the published values have at most 8 significant decimal digits; you'd need 16+ to risk loss). The "JSON precision" defense doesn't apply at these magnitudes. Same theme as the inline cost fields ([1.1](#11--cost-is-on-the-inline-response-but-undocumented-and-stringly-typed)); these should be the same fix.
- **Priority:** **P3.** Easy workaround and not the happy path y'all would likely prescribe. Worth noting: OpenRouter, the closest competitor gateway, returns cost as `number` throughout.

### 1.5 — `getAvailableModels()` stopped working between initial build and a re-test a few days later

- **Context:** This one surfaced while re-running the five examples a few days after capturing EXAMPLES.md, as a sanity check before finalizing the writeup. Nothing on my end had changed (same commit, same `@ai-sdk/gateway@3.0.95`, same lockfile, same Node), but the CLI's local cost breakdown line had silently disappeared from every example, while the authoritative total was still correct.
- **What I observed:**
  - Direct call: `gateway.getAvailableModels()` throws `GatewayResponseError: Invalid error response format: Gateway request failed` with `cause: "Invalid JSON response"`.
  - Raw `fetch` against `https://ai-gateway.vercel.sh/v1/models` returns 200 with valid JSON that parses cleanly (~155KB, ~150 models). So the endpoint is healthy; the SDK's Zod validation against it is what fails.
  - The CLI's rendered output shape changed from what's in EXAMPLES.md line 54 (breakdown line present, same authoritative total) to what it produces now (breakdown line absent, same authoritative total). The two runs agree on every ingredient that comes from the inline `generateText` response; they disagree only on the catalog-derived breakdown.
- **Proposed direction:**
  - **Loosen response schemas where forward-compat matters.** Zod's `.passthrough()` / `.catchall(z.unknown())` on catalog and metadata schemas would let the SDK accept new fields on new models without rejecting the whole payload. This trades a bit of strictness (unknown fields aren't typed) for resilience against normal server evolution.
  - **Sharper error messages at boundaries.** When schema validation fails, surface which path inside the payload failed ("pricing.input_cache_read on alibaba/qwen-3-14b: unknown field") rather than a generic "Invalid JSON response". Same fix applies across `getGenerationInfo`, `getAvailableModels`, and any other response-validating call.
  - **Consider wire-format versioning.** Either honor `/v1` as a frozen contract, or let the SDK pin to a dated revision (`/v1?version=2026-04-01`), so client and server evolve explicitly and safely.
  - **Let consumers see drift.** A `warnings` entry when the SDK drops unrecognized fields would let careful consumers surface that their local view is degrading, rather than discovering it on a re-test weeks later.
- **Priority:** **P0/P1.** Painful for devs and a structural failure mode that generalizes: any method the SDK exposes that validates a server response is vulnerable to the same silent regression on any server change.

---

## Theme 2: Caching

Caching is one of the listed deliverables for this exercise and a primary value prop of any gateway. I ran into a few snags here. 

### 2.1 — Cache thresholds vary per model, and the SDK silently no-ops below them

- **Tried to do:** Mark the system prompt as cacheable and confirm a cache hit on the second identical call. Two attempts, both producing surprises.
- **What went wrong:**
  1. **Initial attempt (Sonnet 4.5).** With a ~250-token system prompt, two consecutive identical calls returned `cachedInputTokens: 0` and `cacheCreationTokens: 0`. No warning, no error, no field on the response saying "marker ignored". Eventually I dug through the Anthropic docs and found per-model cache minimums: 1024 (Sonnet 4.5 / 4 / 3.7), 2048 (Haiku 3.5), and **4096 for Haiku 4.5 and Opus 4.5**. I artificially padded the system prompt to be above 1024 and caching kicked in immediately.
  2. **Second attempt (Sonnet 4.6).** Later, I upgraded the default model from Sonnet 4.5 to Sonnet 4.6 for the speed and adaptive thinking. Same prompt (now ~1450 tokens), same `caching: 'auto'`, same provider, and again caching silently stopped working. Sonnet 4.6 isn't in the documented threshold table at all, but empirically the threshold is *above* 1450 tokens; very likely 4096, matching the rest of the 4.5-era family. So upgrading from a known-good config to the latest model in the same family silently broke the cache demo, with no warning and no field on the response indicating the marker was ignored.
- **Proposed solution:**
  - **Emit a `CallWarning` when a `cacheControl` marker is set on content below the provider minimum.** The actual numbers should be in the message: *"Cache marker on system message ignored: 1450 tokens, anthropic/claude-haiku-4.5 minimum is 4096."* The SDK already has a warnings array on the response, which could be a good place for this type of information.
  - **Expose per-model cache thresholds via `getAvailableModels()`** so library code can validate cacheability.
- **Priority:** **P2.** The silent failures were momentarily confusing and required some docs spelunking.

### 2.2 — The better caching API (`caching: 'auto'`) is hidden in the wrong doc surface

- **Tried to do:** Find the canonical way to enable prompt caching in the AI SDK + Gateway path.
- **What went wrong:** The AI SDK docs (`ai-sdk.dev`) explain the per-provider manual marker approach (`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }`).  I initially built around the manual API and discovered `providerOptions.gateway.caching: 'auto'` later, on the Vercel **product** docs page (`vercel.com/docs/ai-gateway/models-and-providers/automatic-caching`). The auto API seems strictly better i.e. it's provider-agnostic, less code, removes provider-specific knowledge from consumer code. But I didn't find it initially reading the SDK docs. So seemingly an inconsistency between the two doc surfaces.
- **Proposed solution:**
  - A central "Prompt Caching" guide on `ai-sdk.dev` that leads with `providerOptions.gateway.caching: 'auto'` and presents manual markers as the fine-grained-control fallback.
  - Cross-link aggressively from each provider page back to the central guide. Right now the Anthropic provider page is a dead end.
- **Priority:** **P1.** Discoverability gap. Users, like me, might not find the better API and instead they end up coupling their code to provider-specific knowledge that the gateway is supposed to abstract away.

### 2.3 — `caching: 'auto'` is documented but missing from the SDK type schema

- **Tried to do:** Use `providerOptions.gateway.caching: 'auto'` in TypeScript (per the docs from [2.2](#22--the-better-caching-api-caching-auto-is-hidden-in-the-wrong-doc-surface)).
- **What went wrong:** It works at runtime, but the explicit `gatewayProviderOptions` Zod schema exported from `@ai-sdk/gateway@3.0.95` doesn't include a `caching` field. TypeScript silently accepts the field because `providerOptions` is loose, but a strictly-typed wrapper would reject it and IDE completion doesn't suggest it.
- **Proposed solution:** Add `caching: 'auto'` (and any other documented options) to `gatewayProviderOptions`. More broadly, the SDK package types should ship in lockstep with the docs.
- **Priority:** **P2.** A paper cut, but one of a few on the caching-specific journey.

---

## Theme 3: Reasoning observability 

Reasoning is one of the listed deliverables. Two findings, both about how reasoning data is reported through the SDK.

### 3.1 — Anthropic reasoning tokens come back as `0` — should be `null` ("unavailable")

- **Tried to do:** Display "X tokens were spent thinking, Y on the final answer" in the CLI's stderr summary, sourced from `result.usage.outputTokenDetails.reasoningTokens`.
- **What went wrong:** With extended thinking enabled on `claude-sonnet-4.5`, the response includes a `reasoningText` paragraph (the model is clearly thinking) but `outputTokenDetails.reasoningTokens` returns `0`. By contrast, `deepseek/deepseek-v3.2-thinking` correctly returns non-zero reasoning tokens via the same SDK call site. So this is Anthropic-specific.
- **Canonical answer (from the Vercel docs at `/docs/ai-gateway/capabilities/reasoning`):** *"Anthropic counts thinking tokens as output tokens with no separate breakdown."* And from the Anthropic-specific reasoning page: *"Claude 4 models return summarized thinking output, not full thinking tokens. You're charged for the full thinking tokens, but the response contains a condensed summary."* So Anthropic doesn't expose this data at all; it's a fundamental observability gap baked into the upstream product surface, not a bug at any layer downstream. **However**, the SDK's choice to return `0` (rather than `null` or a sentinel) is *misleading*: a downstream consumer can't tell the difference between "definitely no thinking" and "thinking happened, but the provider doesn't report it". A user looking at "0 thinking tokens" assumes the reasoning is free, when in fact they're paying for an opaque amount of it folded into output cost.
- **Proposed solution:**
  - **Return `null` for `reasoningTokens` when the upstream provider doesn't expose the breakdown.** `null` means "unavailable", `0` means "definitely none". This is a one-line fix in the Anthropic adapter that would give consumers an honest signal.
  - **Document the distinction prominently** on the Anthropic provider page in the AI SDK docs, which is currently silent on the question.
- **Priority:** **P1.** Not a fixable bug at the upstream layer, but the misleading sentinel value is fixable today.

### 3.2 — The normalized reasoning API only exists on the OpenAI compat surface

- **Tried to do:** Find a single switch, paralleling `providerOptions.gateway.caching: 'auto'`, to enable reasoning across providers without writing per-provider config.
- **What went wrong:** It doesn't exist on the AI SDK direct path. The AI Gateway capabilities/reasoning page is explicit: *"each provider's native reasoning configuration is passed through `providerOptions`."* So consumers must write `providerOptions.openai.reasoningEffort`, `providerOptions.anthropic.thinking`, etc. One key/config per provider with provider-specific shapes. 
- **Proposed solution:**
  - **Bring the normalized `reasoning` API to the AI SDK side** as `providerOptions.gateway.reasoning: { effort, max_tokens }`, mirroring `providerOptions.gateway.caching`. The gateway already does the mapping server-side; the SDK just needs to forward the field.
  - Until then, the AI SDK reasoning docs should at minimum show the normalized API as an alternative for users who want provider-agnostic reasoning, rather than pretending it doesn't exist.
- **Priority:** **P1.** Same theme as the caching API split ([2.2](#22--the-better-caching-api-caching-auto-is-hidden-in-the-wrong-doc-surface)). Gateway-normalized concepts that exist on only one of two surfaces fragment the developer experience and undermine the gateway's value prop.

---

## Theme 4: Provider routing

Routing is the one of the gateway's more differentiated features and the data to support all of this is on every response, but it's not well-documented or surfaced. Two findings.

### 4.1 — Per-call routing data and provider latency are buried in `providerMetadata`

- **Tried to do:** While dumping `providerMetadata` for the cost investigation in [1.1](#11--cost-is-on-the-inline-response-but-undocumented-and-stringly-typed), noticed a `routing` object containing rich per-call routing information.
- **What went wrong:** It's all there: `originalModelId`, `resolvedProvider`, `finalProvider`, `fallbacksAvailable`, a human-readable `planningReasoning` string, per-attempt timings, response ids etc, but it's not documented (at least anywhere I could find). Two empirical demonstrations of why this matters:
  1. **Routing transparency.** Two consecutive calls with `openai/gpt-oss-120b` were served by **bedrock** then **cerebras** respectively. Without inspecting `providerMetadata.gateway.routing.finalProvider`, a user has no idea their gpt-oss calls are bouncing between completely different upstream providers with completely different per-token pricing (see [1.3](#13--local-cost-computation-is-structurally-wrong-for-routing-aware-gateways)) and completely different latency characteristics (below).
  2. **Hidden routing overhead.** A `gpt-oss-120b` call routed to bedrock showed **110ms** of provider latency (computed from `routing.modelAttempts[0].providerAttempts[0].endTime - startTime`) wrapped in **4972ms** of wall clock, **4862ms** of "gateway + network" overhead, completely invisible without inspecting per-attempt timings. Could be cold start, routing logic, network slowness, or a fallback that wasn't logged. The user sees "5 seconds" with no way to diagnose.
- **Proposed solution:**
  - **Surface routing info on normalized fields**, not buried inside `providerMetadata.gateway.routing`. Users shouldn't have to walk `routing.modelAttempts[0].providerAttempts[0].provider` to find out who served their call.
  - **Document everything that's currently in `providerMetadata.gateway`.** A page listing every field, with example values and what they mean. Today there's nothing.
  - **Surface `providerLatencyMs` (server-measured) alongside the wall clock** as a normalized field. Pair with `latency` from `getGenerationInfo` once that endpoint becomes usable ([1.2](#12--getgenerationinfo-is-buggy-3-compounding-bugs)). This is the single most useful diagnostic for "is the gateway adding overhead?".
  - **Build a `--show-routing` mode** (or equivalent SDK helper) for consumers debugging routing decisions.
- **Priority:** **P2.** Not a bug, but a differentiating feature with low-discoverability. Users won't ask for what they don't know exists, and the customers who do find this data will become advocates. It's better than what most competing gateways expose.

---

## Theme 5: Error handling — small fixes that compound

One finding, but it compounds with several others above ([1.2](#12--getgenerationinfo-is-buggy-3-compounding-bugs) in particular).

### 5.1 — SDK errors dump 50-line raw object stack traces by default

- **Tried to do:** Pass an invalid model id (`gistdiff -m bogus/model`) to see what the user experience looks like for a typo.
- **What went wrong:** Got a ~50-line raw object dump including the full request body, response headers, retry state, and stack traces into the SDK internals. The actually-useful part (`Model 'bogus/model' not found`) was buried inside a nested `responseBody` JSON string. The same pattern applies to every other error class: every consumer of the SDK ends up writing the same 10-15-line wrapper to extract the human-readable message. I wrote one in the gistdiff CLI; the next consumer will write one too.
- **Proposed solution:**
  - Gateway errors already expose a clean `message` field on the `GatewayError` base class. The SDK's default unhandled-rejection path should *use* it instead of dumping the entire error object.
  - When a `runMain`-style helper in the AI SDK ecosystem encounters a `GatewayError`, it should call `.message` and exit, not dump the object.
  - Pair with the fixes in [1.2](#12--getgenerationinfo-is-buggy-3-compounding-bugs) to ensure the underlying error actually *makes it into* `.message` in the first place (rather than being three levels deep in `validationError.cause.issues[0]`).
- **Priority:** **P1.** First-impression UX, easy fix. Combined with [1.2](#12--getgenerationinfo-is-buggy-3-compounding-bugs), this is the difference between "the SDK is friendly to debug against" and "every error looks like a bug in the SDK".

---

## Zooming out: a growth-funnel view

My attempt to step back to consider these rough edges through a growth lens.

### A rough growth funnel

Here's my take on a rough growth funnel for the gateway.

1. **Choosing.** "I'm picking how to talk to models." Tool selection, including the question of "do I even need a gateway?". The competitive set is raw provider SDKs, OpenRouter, Portkey, LiteLLM, LangChain. Most developers don't start by Googling "vercel ai gateway"; they start with "how do I call Claude from Node".
2. **First call.** "I want my first call to work." This is the conversion event for the funnel. Auth, install, hello world. If this doesn't work in the first few minutes, the developer tends to bounce back to step 1 and try a different tool.
3. **Building.** "I'm iterating locally on the actual thing." The longest stage. Prompt tuning, model swapping, debugging, discovering features (caching, reasoning), watching cost. Most of the above section lives here.
4. **Hardening.** "I'm getting it ready for users." Pre-prod work. Error handling, observability, fallbacks, cost concerns at scale. The first time the question stops being "does this work for me" and starts being "does this work for my customers".
5. **Operating.** "I'm running it in production." Monitoring, attribution, debugging prod issues, ongoing cost management. Long-term retention happens here, not at first install.

I'll try to ground recommendations/thoughts below in one of these.

### What I missed about the existing surfaces

My journey was very SDK-first i.e. login to get an API key, install packages, use SDK types (primarily) and docs (secondarily), build locally.  I leveraged claude code and was often using it answer questions that docs would typically answer.

I may or may not be the typical dev, but that path meant I missed a bunch of surfaces initially e.g.

- A **playground** exists at `ai-sdk.dev/playground`, with a clear, but below the fold, CTA from the AI SDK landing page.
- **Starter templates** exist in two places: on the AI SDK landing page (Chatbot, Slackbot Agent, SQL Agent, each with a "copy install prompt" button), and inside the Vercel dashboard's AI Gateway section.
- A polished **quickstart** lives in the dashboard, walking through project setup, install, API key creation, and first script.
- A **free trial** ("$5 of credits every 30 days" per the FAQ) that I didn't see on the landing surface I went through.

The tl;dr, it seems like y'all have most of the funnel surfaces I would have proposed building. 

So the interesting question is less "what's missing?" and more "why didn't I find any of this?". 

My initial take is that the paths between surfaces don't connect well. The sections below try to be specific about where the path breaks.


#### The surfaces I bounced between

| Surface | What's there | Audience |
|---|---|---|
| `ai-sdk.dev` (SDK landing) | Playground, templates, hello-world code, "Run with AI Gateway / Provider / Custom" toggle | SDK-first developers |
| `ai-sdk.dev/docs` (SDK reference) | API reference, provider pages, examples | Developers in implementation mode |
| `vercel.com/ai-gateway` (gateway landing) | Feature pitch, "Get an API Key" CTA, no playground link, no quickstart, no code | Gateway-curious developers |
| `vercel.com/docs/ai-gateway` (gateway product docs) | Where I found `caching: 'auto'`, the normalized reasoning API, the automatic-caching guide | Developers reading docs deeply |
| Vercel dashboard (`/[team]/~/ai-gateway`) | Templates, quickstart, model list, API keys, BYOK, leaderboards | Account holders |

A developer who lands on the gateway landing page never sees the playground or the templates. A developer who lands on `ai-sdk.dev` is told the gateway is one of three options ("Run with AI Gateway / Provider / Custom") rather than the recommended path. A developer who reads the SDK docs finds the manual cache markers but not `caching: 'auto'`. None of these paths cross-link assertively to the others, and the dashboard (which has the most polished onboarding content) sits behind an account wall.


### Stage 1: Choosing

**Friction I think exists here:** Why a gateway at all? When I first encountered the term, my mental model was the legacy "API gateway" framing, i.e. caching and rate limiting. Modern AI gateways are about **routing and failover across providers**, **cost tracking with per-customer attribution**, **quota and rate-limit headroom** (spreading TPM/RPM pressure across upstreams rather than hitting any one provider's ceiling), and **a unified API** that abstracts provider-specific quirks. 

Some of that was on the marketing surface I first encountered.

Worth noting: the strongest pull here differs by audience. For the developer making the call, the big win is usually *reliability and throughput at scale* (quota-aware routing + fallback: the thing that lets you survive an Anthropic RPM|TPM ceiling). For the buyer signing the invoice, it's *cost tracking and attribution*: splitting spend per customer so it can be billed, capped, or reported on. Those are different people with different purchase triggers, and a stage-1 pitch that tries to hit both tends to hit neither.

**Things I'd consider trying:**

- **Reposition the value prop around what's hard to build yourself.** A useful test for "do I need a gateway?" might be "would I have to build a usage attribution warehouse, a routing layer, and a fallback graph if I didn't?". For a single-tenant CLI like gistdiff, no, you probably don't need it. For a multi-tenant SaaS that exposes AI features to its own customers, yes, you almost certainly do. The current marketing surface seems to treat both audiences identically.
- **Honest competitive comparison.** Vercel AI Gateway vs. OpenRouter vs. Portkey vs. LiteLLM vs. raw provider SDKs, at the code level rather than the marketing level. Developers tend to respect honest comparisons (or at least I do).


### Stage 2: First call

**Friction I think exists here:** This is the stage I was most wrong about in my first pass. I originally wrote "friction is low here, this stage is actually pretty good" because the local install-and-call flow worked. Looking again with fresh eyes, the friction is more subtle: the surfaces that would help a brand-new developer (playground, templates, dashboard quickstart) all exist, but the path I followed never landed me on any of them. So a brand-new developer's experience depends heavily on which entry point they happened to start at.

The split I see:

- A developer landing on `ai-sdk.dev` gets a hello-world example, the playground link, and three templates. They're also told the gateway is one of three options, but not the default and/or recommended.
- A developer landing on `vercel.com/ai-gateway` gets a feature pitch and a "Get an API Key" button. They don't see the playground at all. They don't see the quickstart until they create an account.
- A developer who creates an account lands in the dashboard, which has the best content of the three but is an account-walled experience. The first-call onboarding is gated on signing up, which is a high-commitment-ish.

**Things I'd consider trying:**

- **Pick a canonical entry path and route everything to it.** If `vercel.com/ai-gateway` is the front door, then it should link to the playground, embed a code example, and surface the quickstart inline (not behind an account). If `ai-sdk.dev` is the front door, then the gateway should be the recommended option in the hello-world example, not one of three. Today both are partial front doors, and a developer's journey depends on which one Google sent them to.
- **Cross-link the surfaces aggressively.** Every page on `ai-sdk.dev` that mentions the gateway should link to the gateway docs and the gateway dashboard. Every page on `vercel.com/ai-gateway` should link to the SDK docs and the playground. Today these mostly don't cross-link.

### Stage 3: Building

This is where I spent the most time and what is reflected in the first section. Concrete frictions I hit, by sub-problem:

#### Discovering the "right" API

I hand-wrote `providerOptions.anthropic.cacheControl` because that's what the SDK docs showed. The strictly-better `providerOptions.gateway.caching: 'auto'` is documented on the product docs surface (`vercel.com/docs/ai-gateway`), not the SDK docs. Same story for the normalized reasoning API, which only exists on the OpenAI Chat Completions compat surface. So a developer who reads the SDK docs end-to-end learns the per-provider approach and not the gateway-normalized one.

#### Cost visibility

One of the more frictionful areas, as noted above: I found what I expected to be present (cost on the response), tried the docs recommended path only for it to not work as expected. The data exists; the discoverability isn't quite there yet.

#### Errors

The 50-line stack dumps and the misleading "Invalid error response format" wrapper both hurt first-impression. I think a new user hitting either of these for the first time concludes this corner of the product is early and/or unstable.

**Things I'd consider trying:**

- **`npx @ai-sdk/gateway doctor`.** Checks env vars, makes an e2e test call, reports specifically what's wrong with copy-pasteable fixes. This is a small CLI that would change the first 5 minutes of every developer's experience. I think it's low-cost to build and would have a big effect on how the SDK feels.
- **Errors that point to the fix.** Every error message ends with either a doc link or a specific next action. Something like `Model 'bogs/model' not found. Did you mean 'openai/gpt-4o'? See https://...`. This is the difference between an SDK that feels polished and one that feels raw, and it'd compound nicely with the "no opaque wrapper" fix from [5.1](#51--sdk-errors-dump-50-line-raw-object-stack-traces-by-default).
- **Close the docs, types, and product loop.** I think this is the highest-leverage structural fix in the entire writeup. If there's one source of truth for SDK options that auto-generates types and docs and ships them together, a lot of the rough edges I found ("documented but missing from types", "in product docs but not SDK docs") collapse into one fix. It's probably process work more than feature work, which is the kind of thing I'd love to help improve!


### Stage 4: Hardening

**Friction I think exists here:** This is where the small dev-loop annoyances start to compound. Each silent failure I hit (cache no-op, hidden cost, opaque error) is a dev loop irritation, but it becomes a "do I trust this thing in production?" question once I'm thinking about users. The compounding effect is real: by the time I was considering whether gistdiff was something I'd want to ship, I'd already had several "wait, what's it actually doing?" moments. Each one chipped away at trust.

What I personally felt:

- **No automatic cost display during dev.** I had to write the rendering code myself. During dev I'd love something that pretty-prints `[$0.0042 / $0.34 session]` next to every call. Like Next.js's dev overlay: automatic, dismissible, off in production.
- **No "why didn't this cache?" feedback.** The silent threshold no-op ([2.1](#21--cache-thresholds-vary-per-model-and-the-sdk-silently-no-ops-below-them)) cost me a meaningful chunk of time. A `--why-not-cached` mode (or just a `CallWarning` on the response saying "Marker ignored: 1450 tokens, threshold for this model is 4096") would have saved that whole session.
- **No REPL.** Local prompt iteration is "edit script, re-run, look at output". `npx @ai-sdk/gateway repl` with history, model switching, and visible metadata would be a fundamentally faster loop. A CLI counterpart to the playground targeting a different funnel stage.


**Things I'd consider trying:**

- **Two potential dev-loop investments** 
  - **Ambient SDK instrumentation.** Opinionated default logging when some flag/env var is set: pretty-printed cost, latency split (provider vs. gateway), routing, warnings; silent in production. Similar to Prisma's `DEBUG=prisma:*`.
  - **A sidecar inspector: `npx @ai-sdk/gateway inspect`.** A local web UI that your app pushes events to via a one-line middleware around `generateText`. Shows a live stream of calls with prompts, responses, cost, latency, cache hits, and `providerMetadata` deep-dive. This is the *Prisma Studio for AI calls* pattern: separate process, opt-in, not inline with the user's server. More ambitious but still viable.
- **`gateway repl` as first-class CLI command.** 
- **Surface warnings for silent failures.** The `result.warnings` array on the SDK already exists. Every silent no-op (cache below threshold, marker on unsupported provider, deprecated config) could produce a warning. This is a small per-case fix that I think would meaningfully reduce "what just happened?" debugging.

### Stage 5: Operating

**Friction I'm extrapolating about, not directly observing:** I built a single-tenant CLI and I deployed to npm. So this stage is me hypothesizing.

Some of the gateway's stronger features (`getSpendReport`, `tags`, `user` attribution, BYOK separation) live at this stage. They're not super visible during stages 1 through 4, which means a developer who doesn't reach stage 5 never finds out they exist. That seems worth noticing, because the audience that needs the gateway most (multi-tenant SaaS that exposes AI features to its own customers) is also the audience that converts on stage-5 features, not stage-1 features.

What's likely going on:

- **Multi-tenant attribution feels undersold.** `tags` and `user` parameters exist but aren't in the quickstart. The first time you need "show me my top 10 most expensive customers" you discover it's possible.

**Things I'd consider trying:**

- **An attribution-first quickstart.** Instead of the generic "make a call" hello world, ship a "build a SaaS that attributes AI cost to your users" hello world. This would convert the funnel right at the moment when a developer is asking themselves "is this useful for me at scale?". Today's quickstart treats this audience as advanced, when I think it should treat them as the target.
- **Migration guides.** "Switching from Anthropic SDK to AI Gateway in 5 lines of code." Same for OpenRouter, LiteLLM. This makes the gateway the easiest place to land if you're already on a competitor.


### Top three bets if I had to choose

If I were proposing where to invest first, anchored to the funnel:

#### Bet 1: Connect the surfaces (cross-cutting, structural)

Pick a canonical entry path, route everything to it, cross-link aggressively, and decide whether the dashboard quickstart needs to live behind an account wall. I think this is the most leveraged finding in the whole writeup because it fixes friction at stages 1, 2, and 3 simultaneously without shipping a single new feature.

#### Bet 2: Ambient SDK instrumentation (stages 2 and 3)

Opinionated default logging via some env var / configuration: cost, provider-vs-gateway latency split, routing, warnings, pretty-printed to stderr and silent in production. Pure library-side, low engineering cost. Precedents: Prisma's `DEBUG=prisma:*`, Rails's `development.rb` log levels, Drizzle's query logger. The gateway can't own "dev mode" the way Next.js does (it's a library imported into someone else's server, not a runtime), but it can own the logging defaults, and that's where most of the stage-3 friction I hit actually lived.

#### Bet 3: Include multi-tenant SaaS value-props via an attribution-first quickstart (stages 1 and 5, positioning)

A strong value prop of the gateway (`getSpendReport`, `tags`, `user`) isn't super visible until stage 5. I'd consider shifting it to stage 1. The pitch becomes:

> "Building a SaaS with AI features? You'll need usage attribution, multi-tenant cost reporting, and the ability to bill your customers for what they used. Here's how the gateway makes that a 10-line concern instead of a 10-engineer concern."

This would convert the right audience (high-ARPU multi-tenant SaaS) right at the moment they're evaluating, and surfaces the strongest moat upfront instead of as a stage-5 reward.
