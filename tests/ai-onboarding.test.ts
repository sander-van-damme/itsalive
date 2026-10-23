import { describe, expect, it } from "vitest";
import {
  AIService,
  ScriptedProvider,
  defaultAIConfig,
  demoAIConfig,
  missingProviderRoles,
  type AIResponse,
  type GenerateInput,
} from "../src/ai";
const context = { appId: "setup", correlationId: "connection-check" };
const answer = (input: GenerateInput): AIResponse => ({
  text: input.tools ? "" : '{"ready":true}',
  toolCalls: input.tools
    ? [{ id: "check", name: "connection_check", arguments: '{"ready":true}' }]
    : [],
  usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 0 },
});
const probes = () => Array.from({ length: 6 }, () => answer);
describe("connection readiness", () => {
  it("starts unverified with current defaults and never substitutes a test provider", async () => {
    const config = defaultAIConfig();
    const provider = new ScriptedProvider([]);
    const service = new AIService(config, { providers: { demo: provider } });
    expect(config.routes.conversation.model).toBe("gpt-6.1-sol");
    expect(config.routes.decision.model).toBe("gpt-6-luna");
    expect(config.routes["coding-complex"].reasoningEffort).toBe("high");
    expect(config.routes.speech.model).toBe("gpt-live-1");
    expect(service.health.state).toBe("unchecked");
    expect(config.limits.budgetEnabled).toBe(false);
    await expect(
      service.generate(
        "conversation",
        { messages: [{ role: "user", content: "Hello" }] },
        context,
      ),
    ).rejects.toThrow("Settings");
    expect(provider.requests).toHaveLength(0);
    expect(missingProviderRoles(config, {})).toContain("conversation");
  });
  it("checks structured replies and actual tool support on every distinct configuration", async () => {
    const provider = new ScriptedProvider(probes());
    const service = new AIService(demoAIConfig(), {
      providers: { openai: provider },
    });
    await service.testConfiguration(
      defaultAIConfig(),
      { openai: "key" },
      context,
    );
    expect(provider.requests).toHaveLength(6);
    expect(
      provider.requests.filter(
        (request) => request.input.toolChoice === "required",
      ),
    ).toHaveLength(3);
    expect(service.config.routes.conversation.provider).toBe("demo");
    service.configure(defaultAIConfig());
    expect(service.health.state).toBe("ready");
    expect(service.usage.every((record) => record.status === "success")).toBe(
      true,
    );
  });
  it("rejects a provider that answers but cannot call tools without replacing the saved configuration", async () => {
    const provider = new ScriptedProvider([
      answer,
      { text: "I cannot do that", toolCalls: [] },
    ]);
    const service = new AIService(demoAIConfig(), {
      providers: { openai: provider },
    });
    await expect(
      service.testConfiguration(defaultAIConfig(), { openai: "key" }, context),
    ).rejects.toThrow("application actions");
    expect(service.config.routes.conversation.provider).toBe("demo");
    expect(service.health.state).toBe("error");
    expect(service.activeRequestCount).toBe(0);
  });
  it("does not let an aborted probe publish success or replace credentials", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedProvider(probes());
    const service = new AIService(demoAIConfig(), {
      providers: { openai: provider },
    });
    await expect(
      service.testConfiguration(
        defaultAIConfig(),
        { openai: "key" },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
    expect(service.health.state).not.toBe("ready");
  });
});
