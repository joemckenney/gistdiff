import { runSummarizeThenLookup } from "../lib/summarize-then-lookup.mjs";

await runSummarizeThenLookup({
  commit: "13800ff",
  model: "anthropic/claude-sonnet-4.6",
  description: false,
  note: "Example 5 from EXAMPLES.md: structured output via --json.",
  exampleNumber: 5,
  summarizeOutPath: new URL("./summarize.response.json", import.meta.url)
    .pathname,
  infoOutPath: new URL("./generation-info.response.json", import.meta.url)
    .pathname,
});
