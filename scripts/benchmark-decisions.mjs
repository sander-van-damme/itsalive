/** Opt-in real-endpoint comparison. No token ceilings or pre-request reservations. */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!process.argv.includes("--live")) {
  console.log(
    "SKIPPED: Real Decisions/Responses benchmarking requires --live and OPENAI_API_KEY.",
  );
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY) {
  console.log(
    "SKIPPED: OPENAI_API_KEY is unavailable; no live endpoint was tested.",
  );
  process.exit(0);
}
const samplesArg = process.argv.find((arg) => arg.startsWith("--samples="));
const samples = samplesArg ? Number(samplesArg.split("=")[1]) : 3;
if (!Number.isSafeInteger(samples) || samples < 1)
  throw new Error("--samples must be a positive integer.");
const directory = resolve("work/decisions-benchmark");
await mkdir(directory, { recursive: true });
const bundled = resolve(directory, "client.mjs");
await build({
  stdin: {
    contents:
      'export { AIService } from "./src/ai/service.ts"; export { defaultAIConfig } from "./src/ai/types.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundled,
  logLevel: "silent",
});
const { AIService, defaultAIConfig } = await import(bundled);
const config = defaultAIConfig();
config.routes.application = { ...config.routes.decision };
const service = new AIService(config, {
  credentials: () => ({ openai: process.env.OPENAI_API_KEY }),
});
const input =
  "The violin practice session contains scale exercises and a chord quiz. The user can save completed practice sessions.";
const instructions =
  "Does this application let the user save practice progress?";
const records = [];
for (let sample = 0; sample < samples; sample++) {
  // Alternate ordering so warmup does not always favor one endpoint.
  for (const endpoint of sample % 2
    ? ["responses", "decisions"]
    : ["decisions", "responses"]) {
    const context = {
      appId: "live-decision-benchmark",
      correlationId: crypto.randomUUID(),
    };
    const start = performance.now();
    try {
      if (endpoint === "decisions") {
        const result = await service.decide(
          {
            input,
            questions: [
              { type: "predicate", name: "saves_progress", instructions },
            ],
          },
          context,
        );
        const answer = result.answers[0];
        if (answer?.type !== "predicate")
          throw new Error("Expected a predicate answer.");
      } else {
        const result = await service.generate(
          "application",
          {
            messages: [
              { role: "system", content: instructions },
              { role: "user", content: input },
            ],
            jsonSchema: {
              name: "progress_decision",
              schema: {
                type: "object",
                properties: {
                  probability: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["probability"],
                additionalProperties: false,
              },
            },
          },
          context,
        );
        const parsed = JSON.parse(result.text);
        if (
          typeof parsed.probability !== "number" ||
          parsed.probability < 0 ||
          parsed.probability > 1
        )
          throw new Error("Invalid probability.");
      }
      records.push({
        endpoint,
        sample,
        latencyMs: performance.now() - start,
        status: "success",
      });
    } catch (error) {
      // Do not log raw provider bodies, credentials, prompts, or generated text.
      records.push({
        endpoint,
        sample,
        latencyMs: performance.now() - start,
        status: "failed",
        errorClass: error?.constructor?.name ?? "Error",
      });
    }
  }
}
const report = {
  fixture:
    "Static violin application feature predicate, same evidence and question",
  scope:
    "Real network requests; reported tokens and estimated charges after every request. Not an application-generation benchmark.",
  timestamp: new Date().toISOString(),
  node: process.version,
  model: "gpt-6-luna",
  records,
  usage: service.usage,
};
const destination = resolve(directory, "results.json");
await writeFile(destination, JSON.stringify(report, null, 2));
console.log(`Saved ${records.length} real-request results to ${destination}.`);
if (records.some((record) => record.status === "failed")) process.exitCode = 1;
