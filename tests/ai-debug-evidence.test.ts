import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  defaultAIConfig,
  ScriptedProvider,
  AIError,
  type AIEvent,
  type AIResponse,
} from "../src/ai";
import { BrowserAccount, ACCOUNT_STORAGE_KEY } from "../src/ai/browser-account";

const context = { appId: "practice", correlationId: "operation" };
describe("complete debug requests and stable accounting identities", () => {
  it("redacts opaque browser account credentials from debug content even though routing uses only a connected marker", async () => {
    const opaque = "opaque-account-value-test-fixture";
    const account = new BrowserAccount({
      origin: "https://itsalive.test",
      storage: {
        getItem: (key: string) =>
          key === ACCOUNT_STORAGE_KEY
            ? JSON.stringify({ accessToken: opaque })
            : null,
      } as Storage,
    });
    const config = defaultAIConfig();
    config.captureContent = true;
    config.routes.conversation.provider = "chatgpt";
    const events: AIEvent[] = [];
    const service = new AIService(config, {
      credentials: () => ({ chatgpt: "connected" }),
      sanitizeDiagnostic: (value) => account.redactDiagnostic(value),
      log: (event) => events.push(event),
      providers: {
        chatgpt: new ScriptedProvider([
          { text: `Received ${opaque}`, toolCalls: [] },
        ]),
      },
    });
    await service.generate(
      "conversation",
      {
        messages: [
          { role: "user", content: `I am connected and pasted ${opaque}` },
        ],
      },
      context,
    );
    expect(JSON.stringify(events)).not.toContain(opaque);
    expect(
      events.find((event) => event.event === "ai.request.content")!.data,
    ).toMatchObject({
      messages: [{ content: "I am connected and pasted [REDACTED]" }],
    });
    expect(
      events.find((event) => event.event === "ai.response.content")!.data,
    ).toMatchObject({
      response: { text: "Received [REDACTED]" },
    });
  });

  it("retains complete assembled requests and replies with credential redaction and stable local/provider IDs", async () => {
    const config = defaultAIConfig();
    config.captureContent = true;
    const events: AIEvent[] = [];
    const key = "sk-not-a-real-key-test-only";
    const longSource = "const useful = true;\n".repeat(2000);
    const service = new AIService(config, {
      providers: {
        openai: new ScriptedProvider([
          {
            requestId: "resp_provider",
            text: "A distinct practice flow is ready",
            toolCalls: [
              {
                id: "call",
                name: "write_file",
                arguments: JSON.stringify({ content: longSource }),
              },
            ],
            usage: { inputTokens: 100, outputTokens: 40, cachedTokens: 0 },
          },
        ]),
      },
      credentials: () => ({ openai: key }),
      log: (event) => events.push(event),
    });
    const messages = [
      { role: "system" as const, content: "Clarify ambiguous problems" },
      ...Array.from({ length: 130 }, (_, i) => ({
        role: "user" as const,
        content: `${i}: ${longSource}`,
      })),
      { role: "user" as const, content: `Never expose ${key}` },
    ];
    await service.generate(
      "coding-standard",
      {
        messages,
        jsonSchema: { name: "goal", schema: { type: "object" } },
        tools: [
          {
            name: "inspect",
            description: "Look at the active app",
            parameters: { type: "object" },
          },
        ],
      },
      context,
    );
    const request = events.find((e) => e.event === "ai.request")!;
    const response = events.find((e) => e.event === "ai.response")!;
    expect(response.data.requestId).toBe(request.data.requestId);
    expect(response.data.providerResponseId).toBe("resp_provider");
    const captured = events.find((e) => e.event === "ai.request.content")!;
    expect(captured.data).toMatchObject({
      requestId: request.data.requestId,
      jsonSchema: { name: "goal" },
      tools: [{ name: "inspect" }],
    });
    expect(captured.data.messages as unknown[]).toHaveLength(132);
    expect(JSON.stringify(events)).not.toContain(key);
    const capturedResponse = events.find(
      (e) => e.event === "ai.response.content",
    )!.data.response as AIResponse;
    expect(JSON.parse(capturedResponse.toolCalls[0]!.arguments).content).toBe(
      longSource,
    );
  });

  it("keeps provider HTTP IDs separate from local usage IDs on failure and captures the original exception", async () => {
    const events: AIEvent[] = [];
    const service = new AIService(defaultAIConfig(), {
      providers: {
        openai: new ScriptedProvider([
          new AIError("Unsupported voice model", "model", {
            requestId: "req_http",
            status: 400,
            code: "model_not_found",
          }),
        ]),
      },
      credentials: () => ({ openai: "key" }),
      log: (e) => events.push(e),
    });
    await expect(
      service.generate(
        "conversation",
        { messages: [{ role: "user", content: "Help" }] },
        context,
      ),
    ).rejects.toThrow("Unsupported");
    const request = events.find((e) => e.event === "ai.request")!;
    expect(events.find((e) => e.event === "ai.failure")!.data).toMatchObject({
      requestId: request.data.requestId,
      providerRequestId: "req_http",
      providerDetail: { status: 400, code: "model_not_found" },
      error: { name: "AIError", message: "Unsupported voice model" },
    });
  });

  it("declares unsaved final accounting separately when persistence still fails at export", async () => {
    const service = new AIService(defaultAIConfig(), {
      providers: {
        openai: new ScriptedProvider([
          {
            text: "Done",
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0 },
          },
        ]),
      },
      credentials: () => ({ openai: "key" }),
      onUsage: async (record) => {
        if (record.status !== "pending") throw new Error("quota");
      },
    });
    await expect(
      service.generate(
        "conversation",
        { messages: [{ role: "user", content: "Help" }] },
        context,
      ),
    ).rejects.toMatchObject({ kind: "accounting" });
    const flushed = await service.flushUsage();
    expect(flushed.pendingWrites).toBe(0);
    expect(flushed.unpersistedRecords).toHaveLength(1);
    expect(flushed.unpersistedRecords[0]).toMatchObject({
      status: "success",
      usageStatus: "reported",
    });
  });
});

describe("truthful voice usage", () => {
  it("orders a quick final voice settlement after its pending write and retains any final write failure", async () => {
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const saved: string[] = [];
    const service = new AIService(defaultAIConfig(), {
      onUsage: async (record) => {
        saved.push(record.status);
        if (record.status === "pending") await pending;
        else throw new Error("Storage quota exceeded");
      },
    });
    const voice = service.startVoice(context);
    voice.update(1, true, true, {
      elapsedMs: 1000,
      providerSeconds: 1,
      sessionCreated: true,
      initializationSeconds: 15,
      outcome: "completed",
      sessionCreateOutcome: "created",
    });
    await vi.waitFor(() => expect(saved).toEqual(["pending"]));
    releasePending();
    const flushed = await service.flushUsage();
    expect(saved).toEqual(["pending", "success", "success"]);
    expect(flushed.pendingWrites).toBe(0);
    expect(flushed.unpersistedRecords).toHaveLength(1);
    expect(flushed.unpersistedRecords[0]).toMatchObject({
      status: "success",
      usageStatus: "reported",
    });
  });

  it("distinguishes rejected creation, an ambiguous connection loss and a created-session initialization estimate", async () => {
    const service = new AIService(defaultAIConfig());
    service.startVoice(context).update(0.25, true, false, {
      elapsedMs: 250,
      sessionCreated: false,
      initializationSeconds: 0,
      outcome: "failed",
      sessionCreateOutcome: "rejected",
      failureStage: "session-create",
    });
    service.startVoice(context).update(0.5, true, false, {
      elapsedMs: 500,
      sessionCreated: false,
      initializationSeconds: 0,
      outcome: "failed",
      sessionCreateOutcome: "unknown",
      failureStage: "session-create",
    });
    service.startVoice(context).update(0.7, true, false, {
      elapsedMs: 700,
      sessionCreated: true,
      initializationSeconds: 15,
      outcome: "failed",
      sessionCreateOutcome: "created",
      failureStage: "answer",
    });
    expect(service.usage[0]).toMatchObject({
      seconds: 0.25,
      latencyMs: 250,
      costUSD: 0,
      costStatus: "not-billed",
    });
    expect(service.usage[1]).toMatchObject({
      seconds: 0.5,
      latencyMs: 500,
      costUSD: 0,
      costStatus: "unknown",
    });
    expect(service.usage[2]).toMatchObject({
      seconds: 0.7,
      latencyMs: 700,
      costUSD: 0.0125,
      costStatus: "estimated",
      usageStatus: "unknown",
      voiceAccounting: {
        initializationSeconds: 15,
        estimatedBillableSeconds: 15,
        measuredSeconds: 0.7,
      },
    });
    expect(service.spentUSD).toBeCloseTo(0.0125);
    expect(service.unknownCostCount).toBe(1);
    await service.flushUsage();
  });

  it("preserves measured wall time and reported provider duration separately and ignores late duplicate completion", async () => {
    const persisted = vi.fn();
    const service = new AIService(defaultAIConfig(), { onUsage: persisted });
    const voice = service.startVoice(context);
    voice.update(65, true, true, {
      elapsedMs: 70000,
      providerSeconds: 60,
      sessionCreated: true,
      initializationSeconds: 15,
      outcome: "completed",
      sessionCreateOutcome: "created",
    });
    voice.update(500, true, true);
    await service.flushUsage();
    expect(service.usage[0]).toMatchObject({
      seconds: 60,
      latencyMs: 70000,
      costUSD: 0.05,
      usageStatus: "reported",
      status: "success",
      voiceAccounting: {
        measuredSeconds: 70,
        observedSeconds: 65,
        providerSeconds: 60,
      },
    });
    expect(persisted).toHaveBeenCalledTimes(2);
  });
});
