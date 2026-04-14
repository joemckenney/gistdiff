import { runGenerationInfo } from "../lib/generation-info.mjs";

await runGenerationInfo({
  responseJsonPath: new URL("./summarize.response.json", import.meta.url)
    .pathname,
  outPath: new URL("./generation-info.response.json", import.meta.url).pathname,
  label: "example-2",
});
