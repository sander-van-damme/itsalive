#!/usr/bin/env node
/** Explicitly opt-in, low-budget smoke test. No credentials or raw responses are printed. */
import { build } from "esbuild";
import { resolve } from "node:path";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...parts] = arg.split("=");
    return [key, parts.join("=")];
  }),
);
if (!args.has("--live")) {
  console.error(
    "Live tests are disabled. Use --live --provider=openai|openrouter with the corresponding secure API-key environment variable. This sends at most three requests.",
  );
  process.exitCode = 2;
} else {
  try {
    const provider = args.get("--provider") ?? "openai";
    if (!["openai", "openrouter"].includes(provider))
      throw new Error("Provider must be openai or openrouter.");
    const credential =
      process.env[
        provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"
      ];
    if (!credential)
      throw new Error(
        "The selected provider API-key environment variable is missing.",
      );
    const inputPrice = Number(args.get("--input-price") ?? "0.4");
    const outputPrice = Number(args.get("--output-price") ?? "1.6");
    const budget = Number(args.get("--budget") ?? "0.01");
    if (!Number.isFinite(budget) || budget <= 0 || budget > 0.1)
      throw new Error(
        "Live-test budget must be above zero and at most USD 0.10.",
      );
    const model =
      args.get("--model") ??
      (provider === "openai" ? "gpt-4.1-mini" : "openai/gpt-4.1-mini");
    // Bundle the real application adapter in memory. Secrets are read above at runtime, never included in generated code.
    const built = await build({
      entryPoints: [resolve("src/ai/index.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node22",
    });
    const api = await import(
      `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
    );
    const config = api.defaultAIConfig();
    const route = {
      provider,
      model,
      maxOutputTokens: 96,
      inputPerMillion: inputPrice,
      outputPerMillion: outputPrice,
    };
    config.routes.application = route;
    config.routes["coding-simple"] = route;
    config.limits = { requestsPerMinute: 3, concurrency: 1, budgetUSD: budget };
    const service = new api.AIService(config, {
      credentials: () => ({ [provider]: credential }),
    });
    const context = {
      appId: "live-smoke-test",
      correlationId: crypto.randomUUID(),
      signal: AbortSignal.timeout(60_000),
    };
    const text = await service.generate(
      "application",
      {
        messages: [
          { role: "user", content: "Reply with the word OK and nothing else." },
        ],
      },
      context,
    );
    if (text.text.trim() !== "OK")
      throw new Error("Text probe did not return the expected result.");
    const decision = await service.application(
      { method: "decide", prompt: "Is 2 plus 2 equal to 4? Return true." },
      context,
    );
    if (decision !== true) throw new Error("Structured-decision probe failed.");
    const tools = await service.generate(
      "coding-simple",
      {
        messages: [
          {
            role: "user",
            content:
              "Call the echo tool exactly once with message OK. Do not answer in text.",
          },
        ],
        tools: [
          {
            name: "echo",
            description: "Echo a test message without side effects.",
            parameters: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            },
          },
        ],
      },
      context,
    );
    if (
      tools.toolCalls.length !== 1 ||
      tools.toolCalls[0].name !== "echo" ||
      JSON.parse(tools.toolCalls[0].arguments).message !== "OK"
    )
      throw new Error("Function-tool probe failed.");
    console.log(
      JSON.stringify(
        {
          ok: true,
          provider,
          model,
          checks: ["text", "structured decision", "function tool"],
          requests: service.usage.length,
          costUSD: service.spentUSD,
          estimated: service.usage.some((record) => record.estimated),
          latencyMs: service.usage.reduce(
            (sum, record) => sum + record.latencyMs,
            0,
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    // Never echo arbitrary provider response bodies or credentials, even when a transport library embeds them.
    let message =
      error instanceof Error ? error.message : "Live provider test failed.";
    for (const key of [
      process.env.OPENAI_API_KEY,
      process.env.OPENROUTER_API_KEY,
    ])
      if (key) message = message.split(key).join("[REDACTED]");
    console.error(message.replace(/\bsk-[\w-]{8,}/g, "[REDACTED]"));
    process.exitCode = 1;
  }
}
