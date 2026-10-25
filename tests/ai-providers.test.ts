import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIService,
  HTTPProvider,
  ScriptedProvider,
  defaultAIConfig,
  demoAIConfig,
  redact,
  responseRequest,
  readResponseStream,
  parseResponse,
  type AIResponse,
} from "../src/ai";
const context = { appId: "app", correlationId: "trace" };
const input = { messages: [{ role: "user" as const, content: "Hello" }] };
const answer: AIResponse = {
  text: "Hello back",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 3 },
};
const completed = {
  id: "resp-1",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
  usage: {
    input_tokens: 22,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 4 },
  },
  service_tier: "priority",
};
afterEach(() => vi.useRealTimers());
describe("OpenAI Responses integration", () => {
  it("uses an unbound fetch, structured Responses tools, reasoning and selected speed", async () => {
    const fetcher = vi.fn(function (
      this: unknown,
      _url: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json(completed));
    });
    const route = {
      ...defaultAIConfig().routes.conversation,
      serviceTier: "ultrafast" as const,
    };
    const result = await new HTTPProvider("openai", fetcher).generate(
      route,
      {
        ...input,
        tools: [
          {
            name: "read_files",
            description: "Read",
            parameters: { type: "object" },
          },
        ],
        jsonSchema: { name: "test", schema: { type: "object" } },
      },
      "secret-key",
    );
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/responses",
    );
    const request = fetcher.mock.calls[0]![1]!;
    const body = JSON.parse(String(request.body));
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.truncation).toBe("disabled");
    expect(body.service_tier).toBe("ultrafast");
    expect(body.reasoning.effort).toBe("medium");
    expect(body.tools[0].name).toBe("read_files");
    expect(body.text.format.strict).toBe(true);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(String(request.body)).not.toContain("secret-key");
    expect(result.usage?.cachedTokens).toBe(4);
    expect(result.serviceTier).toBe("priority");
  });
  it("preserves tool call identity and obeys the ChatGPT-plan request contract", () => {
    const body = responseRequest(
      { ...defaultAIConfig().routes.conversation, provider: "chatgpt" },
      {
        messages: [
          { role: "system", content: "Private instructions" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "inspect", arguments: "{}" }],
          },
          { role: "tool", content: '{"ok":true}', toolCallId: "call-1" },
        ],
        tools: [
          {
            name: "inspect",
            description: "Inspect",
            parameters: { type: "object" },
          },
        ],
      },
    );
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.input).toEqual([
      { role: "developer", content: "Private instructions" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "inspect",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"ok":true}',
      },
    ]);
    expect((body.tools as any[])[0].type).toBe("namespace");
  });
  it("carries encrypted reasoning and original function namespaces through a stateless tool round trip", () => {
    const output = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "opaque-reasoning",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "inspect",
        namespace: "itsalive",
        arguments: "{}",
      },
    ];
    const response = parseResponse({ status: "completed", output });
    const body = responseRequest(defaultAIConfig().routes["coding-standard"], {
      messages: [
        {
          role: "assistant",
          content: response.text,
          toolCalls: response.toolCalls,
          responseItems: response.responseItems,
        },
        { role: "tool", content: '{"ok":true}', toolCallId: "call_1" },
      ],
    });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.input).toEqual([
      ...output,
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"ok":true}',
      },
    ]);
  });
  it("requires stream completion and handles chunked UTF-8, late errors and premature close", async () => {
    const bytes = new TextEncoder().encode(
      `data: {"type":"response.output_text.delta","delta":"é"}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\r\n\r\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    expect(
      (
        await readResponseStream(
          new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      ).text,
    ).toBe("OK");
    await expect(
      readResponseStream(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"Looks done"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ).rejects.toThrow("before the response finished");
    const failed = {
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "subscription_sharing_usage_limit_exceeded" },
      },
    };
    await expect(
      readResponseStream(
        new Response(`data: ${JSON.stringify(failed)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ).rejects.toThrow("allowance");
  });
  it("does not expose credentials or provider error bodies", async () => {
    const provider = new HTTPProvider(
      "openai",
      vi.fn(async () => new Response("sk-secret-and-prompt", { status: 401 })),
    );
    await expect(
      provider.generate(defaultAIConfig().routes.conversation, input, "key"),
    ).rejects.toThrow("key was not accepted");
    await expect(
      provider.generate(defaultAIConfig().routes.conversation, input, "key"),
    ).rejects.not.toThrow("sk-secret");
  });
});
describe("accounting and burst scheduling", () => {
  it("leaves limits optional and blocks new requests after recorded spending reaches the limit", async () => {
    const config = defaultAIConfig();
    config.limits.budgetUSD = 0.00001;
    const provider = new ScriptedProvider([answer]);
    const service = new AIService(config, {
      providers: { openai: provider },
      credentials: () => ({ openai: "key" }),
    });
    await service.generate("conversation", input, context);
    expect(provider.requests).toHaveLength(1);
    config.limits.budgetEnabled = true;
    service.configure(config);
    await expect(
      service.generate("conversation", input, context),
    ).rejects.toThrow("spending limit");
    expect(provider.requests).toHaveLength(1);
  });
  it("accounts for the served tier and retains uncertain spend after failure", async () => {
    const config = defaultAIConfig();
    config.routes.conversation.serviceTier = "ultrafast";
    const service = new AIService(config, {
      providers: {
        openai: new ScriptedProvider([
          { ...answer, serviceTier: "priority" },
          new Error("Disconnected"),
        ]),
      },
      credentials: () => ({ openai: "key" }),
    });
    await service.generate("conversation", input, context);
    expect(service.usage[0]!.costUSD).toBeCloseTo(
      ((7 * 2 + 3 * 0.1 + 5 * 10) * 2) / 1e6,
      12,
    );
    await expect(
      service.generate("conversation", input, context),
    ).rejects.toThrow("Disconnected");
    expect(service.usage[1]!.costStatus).toBe("unknown");
    expect(service.usage[1]!.usageStatus).toBe("unknown");
    expect(service.unknownCostCount).toBe(1);
  });
  it("queues cross-app bursts and gives conversation priority without rejecting normal work", async () => {
    let release!: (answer: AIResponse) => void;
    const config = demoAIConfig();
    config.limits.concurrency = 1;
    const provider = new ScriptedProvider([
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      answer,
      answer,
    ]);
    const service = new AIService(config, { providers: { demo: provider } });
    const first = service.generate("application", input, context);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const background = service.generate("decision", input, context);
    const conversation = service.generate("conversation", input, {
      ...context,
      appId: "second",
    });
    expect(provider.requests).toHaveLength(1);
    release(answer);
    await Promise.all([first, background, conversation]);
    expect(service.usage.map((record) => record.role)).toEqual([
      "application",
      "conversation",
      "decision",
    ]);
    expect(service.activeRequestCount).toBe(0);
  });
  it("removes cancelled queued work before a provider request", async () => {
    let release!: (answer: AIResponse) => void;
    const config = demoAIConfig();
    config.limits.concurrency = 1;
    const provider = new ScriptedProvider([
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ]);
    const service = new AIService(config, { providers: { demo: provider } });
    const first = service.generate("application", input, context);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const controller = new AbortController();
    const queued = service.generate("conversation", input, {
      ...context,
      signal: controller.signal,
    });
    controller.abort();
    await expect(queued).rejects.toThrow();
    release(answer);
    await first;
    expect(provider.requests).toHaveLength(1);
  });
  it("separates monthly API cost from ChatGPT allowance and includes voice", async () => {
    const config = defaultAIConfig();
    config.routes.conversation.provider = "chatgpt";
    const service = new AIService(config, {
      providers: { chatgpt: new ScriptedProvider([answer]) },
      credentials: () => ({ chatgpt: "connected" }),
    });
    await service.generate("conversation", input, context);
    expect(service.spentUSD).toBe(0);
    const voice = service.startVoice(context);
    voice.update(60, true, true);
    expect(service.spentUSD).toBeCloseTo(0.05);
    expect(service.usage[1]!.seconds).toBe(60);
  });
  it("keeps diagnostics content-free and redacts credential fields", async () => {
    const log = vi.fn();
    const service = new AIService(demoAIConfig(), { log });
    await service.generate(
      "application",
      { messages: [{ role: "user", content: "private note" }] },
      context,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private note");
    expect(
      redact({ password: "secret", message: "Bearer abc and sk-1234567890" }),
    ).toEqual({ password: "[REDACTED]", message: "[REDACTED] and [REDACTED]" });
  });
  it("keeps application decisions bounded and cannot choose a privileged model", async () => {
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
    expect(service.usage[0]!.role).toBe("application");
  });
});
