import { runSummarizeThenLookup } from "../lib/summarize-then-lookup.mjs";

await runSummarizeThenLookup({
  commit: "9e435b4",
  model: "anthropic/claude-sonnet-4.6",
  description: true,
  note: "Example 4 from EXAMPLES.md: meaty feature with -d description body.",
  exampleNumber: 4,
  summarizeOutPath: new URL("./summarize.response.json", import.meta.url)
    .pathname,
  infoOutPath: new URL("./generation-info.response.json", import.meta.url)
    .pathname,
});
