import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  HTTPProvider,
  ScriptedProvider,
  defaultAIConfig,
  demoAIConfig,
  redact,
} from "../src/ai";
import type { AIResponse } from "../src/ai";
const context = { appId: "app-a", correlationId: "trace-a" };
const input = { messages: [{ role: "user" as const, content: "Hello" }] };
const response: AIResponse = {
  text: "Hello back",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 3 },
};
function liveConfig() {
  const config = demoAIConfig();
  config.routes.application = {
    provider: "openai",
    model: "gpt-4.1-mini",
    maxOutputTokens: 100,
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
  };
  return config;
}

describe("documented HTTP provider adapters", () => {
  it("does not bind the native fetch receiver to the provider adapter", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
        ),
      );
    });
    const provider = new HTTPProvider("openai", fetcher as typeof fetch);
    await expect(
      provider.generate(liveConfig().routes.application, input, "key"),
    ).resolves.toMatchObject({ text: "OK" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["openai", "openrouter"] as const)(
    "sends credentials only to the fixed %s endpoint and parses tool calls and usage",
    async (provider) => {
      const fetcher = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              id: "req-1",
              choices: [
                {
                  message: {
                    content: "",
                    tool_calls: [
                      {
                        id: "tool-1",
                        function: {
                          name: "read_files",
                          arguments: '{"paths":["src/App.tsx"]}',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 22,
                completion_tokens: 8,
                prompt_tokens_details: { cached_tokens: 4 },
                cost: 0.002,
              },
            }),
            { status: 200 },
          ),
      );
      const adapter = new HTTPProvider(provider, fetcher as typeof fetch);
      const result = await adapter.generate(
        { ...liveConfig().routes.application, provider },
        {
          ...input,
          tools: [
            {
              name: "read_files",
              description: "Read source",
              parameters: { type: "object" },
            },
          ],
          jsonSchema: { name: "test", schema: { type: "object" } },
        },
        "secret-key",
      );
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        provider === "openai"
          ? "https://api.openai.com/v1/chat/completions"
          : "https://openrouter.ai/api/v1/chat/completions",
      );
      const request = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(request?.headers).toMatchObject({
        Authorization: "Bearer secret-key",
      });
      expect(String(request?.body)).not.toContain("secret-key");
      const body = JSON.parse(String(request?.body));
      expect(body.max_completion_tokens).toBe(100);
      expect(body.tools[0].function.name).toBe("read_files");
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(result.toolCalls[0]?.name).toBe("read_files");
      expect(result.usage).toEqual({
        inputTokens: 22,
        outputTokens: 8,
        cachedTokens: 4,
        costUSD: 0.002,
      });
    },
  );
  it("does not echo provider error bodies and rejects truncated outputs", async () => {
    const denied = new HTTPProvider(
      "openai",
      vi.fn(
        async () => new Response("sk-do-not-expose", { status: 401 }),
      ) as typeof fetch,
    );
    await expect(
      denied.generate(liveConfig().routes.application, input, "key"),
    ).rejects.toThrow("401");
    await expect(
      denied.generate(liveConfig().routes.application, input, "key"),
    ).rejects.not.toThrow("sk-do-not-expose");
    const truncated = new HTTPProvider(
      "openai",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "length", message: { content: "{" } }],
            }),
          ),
      ) as typeof fetch,
    );
    await expect(
      truncated.generate(liveConfig().routes.application, input, "key"),
    ).rejects.toThrow("token limit");
  });
});

describe("privileged AI limits and accounting", () => {
  it("blocks new provider calls during storage operations without confusing persisted reservations with active work", async () => {
    let paused = true;
    const provider = new ScriptedProvider([response]);
    const service = new AIService(demoAIConfig(), {
      providers: { demo: provider },
      beforeRequest: () => {
        if (paused) throw new Error("Storage operation active");
      },
    });
    await expect(
      service.generate("application", input, context),
    ).rejects.toThrow("Storage operation active");
    expect(provider.requests).toHaveLength(0);
    expect(service.activeRequestCount).toBe(0);
    paused = false;
    await service.generate("application", input, context);
    service.importUsage(
      service.usage.map((record) => ({
        ...record,
        status: "pending",
        costUSD: 0.25,
      })),
    );
    expect(service.activeRequestCount).toBe(0);
    expect(service.spentUSD).toBe(0.25);
  });
  it("reserves budget before requests and retains uncertain spend on failures", async () => {
    const config = liveConfig();
    config.limits.budgetUSD = 0.00001;
    const provider = new ScriptedProvider([response]);
    const service = new AIService(config, {
      providers: { openai: provider },
      credentials: () => ({ openai: "key" }),
    });
    await expect(
      service.generate("application", input, context),
    ).rejects.toThrow("spending limit");
    expect(provider.requests).toHaveLength(0);
    config.limits.budgetUSD = 1;
    service.configure(config);
    const failing = new AIService(config, {
      providers: { openai: new ScriptedProvider([new Error("Disconnected")]) },
      credentials: () => ({ openai: "key" }),
    });
    await expect(
      failing.generate("application", input, context),
    ).rejects.toThrow("Disconnected");
    expect(failing.usage[0]?.status).toBe("failed");
    expect(failing.spentUSD).toBeGreaterThan(0);
  });
  it("enforces concurrency across apps and releases slots after completion", async () => {
    let release!: (value: AIResponse) => void;
    const config = demoAIConfig();
    config.limits.concurrency = 1;
    const provider = new ScriptedProvider([
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      response,
    ]);
    const service = new AIService(config, { providers: { demo: provider } });
    const first = service.generate("application", input, context);
    await expect(
      service.generate("conversation", input, { ...context, appId: "app-b" }),
    ).rejects.toThrow("concurrency");
    release(response);
    await first;
    await expect(
      service.generate("application", input, context),
    ).resolves.toMatchObject({ text: "Hello back" });
  });
  it("enforces request rates, restores the ledger and separates roles", async () => {
    const config = demoAIConfig();
    config.limits.requestsPerMinute = 2;
    const provider = new ScriptedProvider([response, response]);
    const service = new AIService(config, {
      providers: { demo: provider },
      now: () => 100_000,
    });
    await service.generate("conversation", input, context);
    await service.generate("application", input, context);
    expect(service.usage.map((record) => record.role)).toEqual([
      "conversation",
      "application",
    ]);
    const restored = new AIService(config, { now: () => 100_000 });
    restored.importUsage(service.usage);
    await expect(restored.generate("decision", input, context)).rejects.toThrow(
      "request limit",
    );
  });
  it("redacts secrets and omits content unless explicitly enabled", async () => {
    const log = vi.fn();
    const config = demoAIConfig();
    const service = new AIService(config, { log });
    await service.generate(
      "application",
      { messages: [{ role: "user", content: "Private medical note" }] },
      context,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "Private medical note",
    );
    expect(redact({ inputTokens: 100, outputTokens: 20 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(
      redact({ password: "hunter2", message: "Bearer abc and sk-1234567890" }),
    ).toEqual({ password: "[REDACTED]", message: "[REDACTED] and [REDACTED]" });
  });
  it("validates app decisions and never accepts roles or credentials from app payloads", async () => {
    const service = new AIService(demoAIConfig(), {
      providers: {
        demo: new ScriptedProvider([
          { text: '{"value":"not allowed"}', toolCalls: [] },
        ]),
      },
    });
    await expect(
      service.application(
        { method: "choose", prompt: "Choose", options: ["A", "B"] },
        context,
      ),
    ).rejects.toThrow("allowed result");
    expect(service.usage[0]?.role).toBe("application");
    await expect(
      service.application(
        { method: "choose", prompt: "Choose", options: ["A", "A"] },
        context,
      ),
    ).rejects.toThrow("distinct");
  });
});
