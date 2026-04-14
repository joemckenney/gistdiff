import { runSummarizeThenLookup } from "../lib/summarize-then-lookup.mjs";

await runSummarizeThenLookup({
  commit: "1957f54",
  model: "anthropic/claude-sonnet-4.6",
  description: true,
  note: "Example 2 from EXAMPLES.md: refactor with -d description body.",
  exampleNumber: 2,
  summarizeOutPath: new URL("./summarize.response.json", import.meta.url)
    .pathname,
  infoOutPath: new URL("./generation-info.response.json", import.meta.url)
    .pathname,
});
