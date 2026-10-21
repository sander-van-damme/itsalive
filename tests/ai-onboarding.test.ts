import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  ScriptedProvider,
  defaultAIConfig,
  demoAIConfig,
  missingProviderRoles,
  type AIResponse,
} from "../src/ai";

const context = { appId: "setup", correlationId: "connection-check" };
const ok: AIResponse = {
  text: "OK",
  toolCalls: [],
  usage: { inputTokens: 9, outputTokens: 1, cachedTokens: 0 },
};

describe("real AI onboarding contract", () => {
  it("defaults to a compatible external model and never substitutes scripted responses for missing credentials", async () => {
    const config = defaultAIConfig();
    expect(config.routes.conversation).toMatchObject({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    expect(config.routes.conversation.inputPerMillion).toBeGreaterThan(0);
    const scripted = new ScriptedProvider([ok]);
    const service = new AIService(config, { providers: { demo: scripted } });
    await expect(
      service.generate(
        "conversation",
        { messages: [{ role: "user", content: "Create a violin trainer" }] },
        context,
      ),
    ).rejects.toThrow("Settings");
    expect(scripted.requests).toHaveLength(0);
    expect(missingProviderRoles(config, {})).toContain("coding-standard");
    expect(missingProviderRoles(config, { openai: "key" })).toEqual([]);
  });

  it("requires explicit opt-in even when an old saved configuration selected demo by default", async () => {
    const legacy = demoAIConfig();
    delete legacy.testProviderEnabled;
    const service = new AIService(legacy);
    await expect(
      service.generate(
        "conversation",
        { messages: [{ role: "user", content: "Hello" }] },
        context,
      ),
    ).rejects.toThrow("explicitly enable");
    expect(missingProviderRoles(legacy, {})).toContain("conversation");
    expect(missingProviderRoles(demoAIConfig(), {})).toEqual([]);
  });

  it("tests an actual completion once per selected provider/model without saving the candidate connection", async () => {
    const provider = new ScriptedProvider([ok]);
    const persisted = vi.fn();
    const original = demoAIConfig();
    const service = new AIService(original, {
      providers: { openai: provider },
      onUsage: persisted,
    });
    await service.testConfiguration(
      defaultAIConfig(),
      { openai: "new-key" },
      context,
    );
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.input.messages[0]?.content).toContain(
      "confirm the connection",
    );
    expect(provider.requests[0]?.route.maxOutputTokens).toBe(32);
    expect(service.config).toEqual(original);
    expect(service.usage).toHaveLength(1);
    expect(service.usage[0]).toMatchObject({
      status: "success",
      provider: "openai",
      appId: "setup",
    });
    expect(persisted).toHaveBeenCalledTimes(2);
    expect(service.spentUSD).toBeGreaterThan(0);
  });

  it("retains failed probe accounting, preserves the working connection and lets users retry", async () => {
    const provider = new ScriptedProvider([new Error("Key rejected"), ok]);
    const service = new AIService(demoAIConfig(), {
      providers: { openai: provider },
    });
    await expect(
      service.testConfiguration(
        defaultAIConfig(),
        { openai: "bad-key" },
        context,
      ),
    ).rejects.toThrow("Key rejected");
    expect(service.config.routes.conversation.provider).toBe("demo");
    expect(service.usage[0]?.status).toBe("failed");
    expect(service.spentUSD).toBeGreaterThan(0);
    expect(service.activeRequestCount).toBe(0);
    await expect(
      service.testConfiguration(
        defaultAIConfig(),
        { openai: "corrected-key" },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(service.usage.map((record) => record.status)).toEqual([
      "failed",
      "success",
    ]);
  });

  it("checks every distinct advanced model and blocks competing work during a connection check", async () => {
    let release!: (response: AIResponse) => void;
    const provider = new ScriptedProvider([
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      ok,
    ]);
    const service = new AIService(demoAIConfig(), {
      providers: { openai: provider },
    });
    const candidate = defaultAIConfig();
    candidate.routes["coding-complex"].model = "custom-compatible-model";
    const check = service.testConfiguration(
      candidate,
      { openai: "key" },
      context,
    );
    expect(service.activeRequestCount).toBe(1);
    await expect(
      service.generate(
        "conversation",
        { messages: [{ role: "user", content: "Hi" }] },
        context,
      ),
    ).rejects.toThrow("connection check");
    release(ok);
    await check;
    expect(provider.requests.map((request) => request.route.model)).toEqual([
      "gpt-4.1-mini",
      "custom-compatible-model",
    ]);
    expect(service.activeRequestCount).toBe(0);
  });

  it("rejects empty successful HTTP completions during setup", async () => {
    const service = new AIService(demoAIConfig(), {
      providers: {
        openai: new ScriptedProvider([{ text: "", toolCalls: [] }]),
      },
    });
    await expect(
      service.testConfiguration(defaultAIConfig(), { openai: "key" }, context),
    ).rejects.toThrow("empty response");
  });
});
