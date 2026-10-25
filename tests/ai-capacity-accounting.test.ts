import { describe, expect, it, vi } from "vitest";
import {
  AIError,
  AIService,
  HTTPProvider,
  ScriptedProvider,
  defaultAIConfig,
  parseResponse,
  readResponseStream,
  responseRequest,
  type AIResponse,
} from "../src/ai";
const context = { appId: "app", correlationId: "generation" };
const input = {
  messages: [{ role: "user" as const, content: "Build violin practice" }],
};
const output = [
  { type: "message", content: [{ type: "output_text", text: "Done" }] },
];
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
};
function service(
  responses: ConstructorParameters<typeof ScriptedProvider>[0],
  enabled = false,
  budget = 20,
) {
  const config = defaultAIConfig();
  config.limits.budgetEnabled = enabled;
  config.limits.budgetUSD = budget;
  const provider = new ScriptedProvider(responses);
  return {
    config,
    provider,
    ai: new AIService(config, {
      providers: { openai: provider },
      credentials: () => ({ openai: "private-key" }),
    }),
  };
}
function incomplete(): AIError {
  try {
    parseResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output,
      usage,
    });
  } catch (error) {
    return error as AIError;
  }
  throw new Error("fixture did not fail");
}
describe("full provider capacity", () => {
  it("drops persisted V3 output allowances at configuration boundaries and never serializes a cap", () => {
    const config = defaultAIConfig();
    Object.assign(config.routes.conversation, { maxOutputTokens: 8192 });
    const ai = new AIService(config);
    expect(ai.config.routes.conversation).not.toHaveProperty("maxOutputTokens");
    ai.configure(config);
    expect(ai.config.routes.conversation).not.toHaveProperty("maxOutputTokens");
    expect(
      responseRequest(config.routes.conversation, input),
    ).not.toHaveProperty("max_output_tokens");
    expect(
      responseRequest(config.routes["coding-complex"], input).reasoning,
    ).toEqual({ effort: "high" });
  });
  it("accepts large complete source/conversation contexts beyond both former request ceilings", async () => {
    const { ai, provider } = service([{ text: "Done", toolCalls: [] }]);
    const messages = Array.from({ length: 125 }, (_, i) => ({
      role: "user" as const,
      content: `${i}: ${"source ".repeat(1000)}`,
    }));
    await ai.generate("coding-standard", { messages }, context);
    expect(provider.requests[0]!.input.messages).toEqual(messages);
  });
  it("accepts outputs larger than the former 8192 token and 8 MB transport ceilings", async () => {
    const longText = "violin ".repeat(1_200_000);
    const terminal = {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: longText }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 40_000 },
      },
    };
    const result = await readResponseStream(
      new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    expect(result.text).toBe(longText);
    expect(result.usage!.outputTokens).toBe(40_000);
  });
  it("preserves only complete executable actions and exact usage after an incomplete response", () => {
    const good = {
      type: "function_call",
      status: "completed",
      call_id: "good",
      name: "write_file",
      arguments: '{"path":"App.tsx","content":"ready"}',
    };
    const partial = {
      type: "function_call",
      status: "incomplete",
      call_id: "partial",
      name: "patch_file",
      arguments: '{"path":',
    };
    try {
      parseResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          good,
          partial,
          {
            type: "reasoning",
            status: "in_progress",
            encrypted_content: "incomplete-opaque-content",
          },
        ],
        usage,
      });
    } catch (error) {
      const failure = error as AIError;
      expect(failure.response!.completion).toEqual({
        status: "incomplete",
        reason: "max_output_tokens",
        recoverable: true,
      });
      expect(failure.response!.toolCalls.map((call) => call.id)).toEqual([
        "good",
      ]);
      expect(failure.response!.responseItems).toEqual([good]);
      expect(failure.response!.usage!.inputTokens).toBe(100);
      return;
    }
    throw new Error("incomplete response unexpectedly succeeded");
  });
  it("classifies actual provider context exhaustion without silent truncation or fabricated recovery", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(
          {
            error: {
              code: "context_length_exceeded",
              message: "private content",
            },
          },
          { status: 400 },
        ),
    );
    const failure = await new HTTPProvider("openai", fetcher)
      .generate(defaultAIConfig().routes.conversation, input, "key")
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AIError);
    expect(failure.kind).toBe("context");
    expect(failure.detail.reason).toBe("context_length_exceeded");
    expect(failure.message).not.toContain("private content");
    expect(
      JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).truncation,
    ).toBe("disabled");
  });
});
describe("usage after requests", () => {
  it("records exact tokens separately from estimated charges, cached discounts and cache-write prices", async () => {
    const { ai } = service([
      parseResponse({ status: "completed", output, usage }),
    ]);
    await ai.generate("coding-standard", input, context);
    expect(ai.usage[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 40,
      cacheWriteTokens: 10,
      usageStatus: "reported",
      costStatus: "estimated",
      status: "success",
    });
    expect(ai.spentUSD).toBeCloseTo(
      (50 * 2 + 40 * 0.1 + 10 * 2.5 + 20 * 10) / 1e6,
      12,
    );
  });
  it("prices documented long-context rates from actual input usage", async () => {
    const { ai } = service([
      {
        text: "done",
        toolCalls: [],
        usage: {
          inputTokens: 300_000,
          outputTokens: 100,
          cachedTokens: 200_000,
        },
      },
    ]);
    await ai.generate("coding-standard", input, context);
    expect(ai.spentUSD).toBeCloseTo(
      (100_000 * 4 + 200_000 * 0.2 + 100 * 15) / 1e6,
      12,
    );
  });
  it("accounts for incomplete and failed terminal responses with usage", async () => {
    let failed: AIError;
    try {
      parseResponse({
        status: "failed",
        error: { code: "server_error" },
        usage,
      });
    } catch (error) {
      failed = error as AIError;
    }
    const { ai } = service([incomplete(), failed!]);
    await expect(
      ai.generate("coding-standard", input, context),
    ).rejects.toThrow("progress is saved");
    await expect(
      ai.generate("coding-standard", input, context),
    ).rejects.toThrow("progress is saved");
    expect(
      ai.usage.every(
        (record) =>
          record.status === "failed" &&
          record.usageStatus === "reported" &&
          record.costStatus === "estimated",
      ),
    ).toBe(true);
    expect(ai.spentUSD).toBeCloseTo(
      (2 * (50 * 2 + 40 * 0.1 + 10 * 2.5 + 20 * 10)) / 1e6,
      12,
    );
  });
  it("retains reported usage from HTTP context failures after the safe server boundary", async () => {
    const config = defaultAIConfig();
    const ai = new AIService(config, {
      credentials: () => ({ openai: "key" }),
      providers: {
        openai: new HTTPProvider("openai", async () =>
          Response.json(
            { error: { code: "context_length_exceeded" }, usage },
            { status: 400 },
          ),
        ),
      },
    });
    await expect(
      ai.generate("coding-standard", input, context),
    ).rejects.toMatchObject({ kind: "context" });
    expect(ai.usage[0]).toMatchObject({
      usageStatus: "reported",
      costStatus: "estimated",
      inputTokens: 100,
      status: "failed",
    });
    expect(ai.spentUSD).toBeCloseTo(
      (50 * 2 + 40 * 0.1 + 10 * 2.5 + 20 * 10) / 1e6,
      12,
    );
  });
  it("keeps interrupted and missing usage unknown, including on reload", async () => {
    const { ai } = service([
      new Error("transport interrupted"),
      { text: "answer without usage", toolCalls: [] },
    ]);
    await expect(
      ai.generate("coding-standard", input, context),
    ).rejects.toThrow("transport interrupted");
    await ai.generate("conversation", input, context);
    expect(ai.unknownCostCount).toBe(2);
    expect(ai.usage.map((record) => record.costStatus)).toEqual([
      "unknown",
      "unknown",
    ]);
    const restored = service([]).ai;
    restored.importUsage(ai.usage);
    expect(restored.unknownCostCount).toBe(2);
    const legacy = {
      ...ai.usage[0]!,
      status: "pending" as const,
      costUSD: 200,
      costStatus: undefined,
      usageStatus: undefined,
    };
    restored.importUsage([legacy]);
    expect(restored.spentUSD).toBe(0);
    expect(restored.usage[0]!.costStatus).toBe("unknown");
  });
  it("allows concurrent in-flight requests to exceed a threshold, then prevents new spending", async () => {
    let finishA!: (response: AIResponse) => void;
    let finishB!: (response: AIResponse) => void;
    const { ai, provider } = service(
      [
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
        () =>
          new Promise((resolve) => {
            finishB = resolve;
          }),
      ],
      true,
      0.01,
    );
    const a = ai.generate("coding-standard", input, context);
    const b = ai.generate("conversation", input, context);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(ai.spentUSD).toBe(0);
    expect(ai.unknownCostCount).toBe(2);
    const charged = {
      text: "done",
      toolCalls: [],
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        cachedTokens: 0,
        costUSD: 0.02,
      },
    };
    finishA(charged);
    finishB(charged);
    await Promise.all([a, b]);
    expect(ai.spentUSD).toBe(0.04);
    await expect(ai.generate("application", input, context)).rejects.toThrow(
      "spending limit",
    );
    expect(provider.requests).toHaveLength(2);
    expect(ai.usage.every((record) => record.costStatus === "reported")).toBe(
      true,
    );
  });
  it("blocks only billable requests and does not call plan usage unknown API spending", async () => {
    const config = defaultAIConfig();
    config.routes.conversation.provider = "chatgpt";
    config.limits.budgetEnabled = true;
    config.limits.budgetUSD = 0;
    const ai = new AIService(config, {
      providers: {
        chatgpt: new ScriptedProvider([{ text: "answer", toolCalls: [] }]),
      },
      credentials: () => ({ chatgpt: "connected" }),
    });
    await ai.generate("conversation", input, context);
    expect(ai.usage[0]).toMatchObject({
      costStatus: "not-billed",
      usageStatus: "unknown",
      costUSD: 0,
    });
    expect(ai.unknownCostCount).toBe(0);
  });
  it("does not abort ongoing generation at the previous three-minute ceiling", async () => {
    vi.useFakeTimers();
    try {
      let release!: (response: AIResponse) => void;
      let requestSignal: AbortSignal | undefined;
      const ai = new AIService(defaultAIConfig(), {
        credentials: () => ({ openai: "key" }),
        providers: {
          openai: {
            generate: async (_route, _input, _credential, signal) => {
              requestSignal = signal;
              return new Promise((resolve, reject) => {
                release = resolve;
                signal?.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            },
          },
        },
      });
      const pending = ai.generate("coding-standard", input, context);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(requestSignal?.aborted).not.toBe(true);
      release({ text: "done", toolCalls: [] });
      await expect(pending).resolves.toMatchObject({ text: "done" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps queued work waiting through long valid requests instead of expiring at two minutes", async () => {
    vi.useFakeTimers();
    try {
      let release!: (response: AIResponse) => void;
      const { ai, config, provider } = service([
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        { text: "second", toolCalls: [] },
      ]);
      config.limits.concurrency = 1;
      ai.configure(config);
      const active = ai.generate("coding-standard", input, context);
      await Promise.resolve();
      await Promise.resolve();
      const waiting = ai.generate("conversation", input, context);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(provider.requests).toHaveLength(1);
      release({ text: "first", toolCalls: [] });
      await expect(active).resolves.toMatchObject({ text: "first" });
      await expect(waiting).resolves.toMatchObject({ text: "second" });
    } finally {
      vi.useRealTimers();
    }
  });
});
