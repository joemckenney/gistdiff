import { runSummarizeThenLookup } from "../lib/summarize-then-lookup.mjs";

const MODELS = [
  { model: "anthropic/claude-sonnet-4.6", label: "claude" },
  { model: "openai/gpt-oss-120b", label: "gpt-oss" },
];

for (const { model, label } of MODELS) {
  console.log(`== ${label} (${model}) ==`);
  await runSummarizeThenLookup({
    commit: "a9d9cbd",
    model,
    description: false,
    note: `Example 3 from EXAMPLES.md (compare mode) — ${model}.`,
    exampleNumber: 3,
    summarizeOutPath: new URL(
      `./summarize.${label}.response.json`,
      import.meta.url,
    ).pathname,
    infoOutPath: new URL(
      `./generation-info.${label}.response.json`,
      import.meta.url,
    ).pathname,
  });
}
