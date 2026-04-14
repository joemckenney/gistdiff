import { runGenerationInfo } from "../lib/generation-info.mjs";

for (const label of ["claude", "gpt-oss"]) {
  await runGenerationInfo({
    responseJsonPath: new URL(
      `./summarize.${label}.response.json`,
      import.meta.url,
    ).pathname,
    outPath: new URL(
      `./generation-info.${label}.response.json`,
      import.meta.url,
    ).pathname,
    label: `example-3.${label}`,
  });
}
