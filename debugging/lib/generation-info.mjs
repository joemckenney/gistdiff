import { readFileSync, writeFileSync } from "node:fs";
import { createGateway } from "@ai-sdk/gateway";
import { loadEnvLocal } from "./env.mjs";
import { serializeError } from "./errors.mjs";

/**
 * Poll gateway.getGenerationInfo for the id stored in a sibling
 * summarize response JSON, then write the result (or full error
 * history) to outPath.
 */
export async function runGenerationInfo({
  responseJsonPath,
  outPath,
  label,
  maxAttempts = 12,
  intervalMs = 1000,
}) {
  loadEnvLocal();

  const saved = JSON.parse(readFileSync(responseJsonPath, "utf8"));
  const generationId = saved.providerMetadata.gateway.generationId;
  console.log(
    `[${label ?? "generation-info"}] polling getGenerationInfo({ id: "${generationId}" })`,
  );

  const gw = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });

  const attempts = [];
  for (let i = 1; i <= maxAttempts; i++) {
    const start = Date.now();
    try {
      const info = await gw.getGenerationInfo({ id: generationId });
      attempts.push({ attempt: i, elapsedMs: Date.now() - start, ok: true, info });
      console.log(`  attempt ${i}: OK after ${Date.now() - start}ms`);
      break;
    } catch (err) {
      attempts.push({
        attempt: i,
        elapsedMs: Date.now() - start,
        ok: false,
        error: serializeError(err),
      });
      console.log(
        `  attempt ${i}: ERR (${Date.now() - start}ms) — ${err?.message ?? err}`,
      );
      if (i < maxAttempts) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        meta: {
          generationId,
          capturedAt: new Date().toISOString(),
          maxAttempts,
          intervalMs,
          note: "gateway.getGenerationInfo() polled until success or exhaustion. See NOTES.md 1.2.",
        },
        attempts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  wrote ${outPath}`);
}
