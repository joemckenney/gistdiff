# Debugging

Per-example request/response captures for inspecting the AI Gateway surface.
Each `example-N/` directory corresponds to an example in
[`EXAMPLES.md`](../EXAMPLES.md). Use these to see exactly what the SDK sends
and what comes back — especially the undocumented `providerMetadata.gateway`
shape discussed in [`NOTES.md`](../NOTES.md).

## Layout

```
debugging/
├── lib/                              # shared helpers (env, error serialization, generation-info poller)
├── example-1/
│   ├── summarize.request.mjs         # the generateText call
│   ├── summarize.response.json       # full response incl. providerMetadata
│   ├── generation-info.request.mjs   # polls gateway.getGenerationInfo
│   └── generation-info.response.json # info payload or full error history
├── example-2/   ...
├── example-3/                        # compare mode — two models, two pairs each
│   ├── summarize.claude.response.json
│   ├── summarize.gpt-oss.response.json
│   └── ...
└── ...
```

Naming: `<call>.<label?>.request.mjs` / `<call>.<label?>.response.json`. The
label is used only when a single example issues multiple calls (example-3).

## Running

Requires `AI_GATEWAY_API_KEY` in `.env.local` at the repo root.

```sh
pnpm install                                       # wires up workspace deps
node debugging/example-1/summarize.request.mjs     # captures the inline response
node debugging/example-1/generation-info.request.mjs  # polls getGenerationInfo for that id
```

To reproduce the NOTES.md 1.2 eventual-consistency bug reliably, run the
back-to-back variant — it calls `getGenerationInfo` immediately after
`generateText` returns, with no settling time:

```sh
node debugging/example-1/summarize-then-lookup.request.mjs
```

Expect the first few lookup attempts to fail with
`Invalid error response format: Gateway request failed`, then succeed
once the usage event materializes (typically at ~4–8s). This overwrites
the same `summarize.response.json` and `generation-info.response.json`
files the two-step flow writes.

Scripts are idempotent — re-running overwrites the response JSON. Because
model sampling isn't deterministic, text and exact costs will vary across
runs; shape and order-of-magnitude are stable.

## Notes

- `generation-info.request.mjs` polls up to 12× at 1s intervals and records
  every attempt (including the full error object when it fails), so a script
  run against a fresh generationId reproduces the eventual-consistency and
  error-wrapping issues described in NOTES.md 1.2.
- Responses preserve the stringly-typed cost fields exactly as returned by
  the gateway; don't be surprised by `"cost": "0.004671"` rather than a
  number. That's the point — see NOTES.md 1.1.
