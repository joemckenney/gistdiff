import { runSummarizeThenLookup } from "../lib/summarize-then-lookup.mjs";

await runSummarizeThenLookup({
  commit: "6aa8d21",
  model: "anthropic/claude-sonnet-4.6",
  description: false,
  note: "Example 1 from EXAMPLES.md: trivial chore, subject-only.",
  exampleNumber: 1,
  summarizeOutPath: new URL("./summarize.response.json", import.meta.url)
    .pathname,
  infoOutPath: new URL("./generation-info.response.json", import.meta.url)
    .pathname,
});
