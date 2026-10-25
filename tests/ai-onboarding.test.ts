import { describe, expect, it } from "vitest";
import {
  AIService,
  AIError,
  ScriptedProvider,
  defaultAIConfig,
  demoAIConfig,
  missingProviderRoles,
  type AIResponse,
  type GenerateInput,
} from "../src/ai";
const context = { appId: "setup", correlationId: "connection-check" };
const answer = (input: GenerateInput): AIResponse => ({
  text: input.tools || input.decisions ? "" : '{"ready":true}',
  ...(input.decisions
    ? {
        endpoint: "decisions" as const,
        answers: [
          {
            type: "predicate" as const,
            name: "connection_check",
            probability: 0.99,
          },
        ],
      }
    : {}),
  toolCalls: input.tools
    ? [{ id: "check", name: "connection_check", arguments: '{"ready":true}' }]
    : [],
  usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 0 },
});
const probes = () => Array.from({ length: 7 }, () => answer);
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
    expect(provider.requests).toHaveLength(7);
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

describe("configuration validation reuse", () => {
  it("reuses exact tested credentials and capabilities, ignoring unrelated preferences", async () => {
    const provider = new ScriptedProvider([
      ...probes(),
      ...probes(),
      ...probes(),
    ]);
    const service = new AIService(demoAIConfig(), {
      providers: { openai: provider },
    });
    const config = defaultAIConfig();
    await service.testConfiguration(config, { openai: "key-one" }, context);
    config.captureContent = true;
    config.limits.budgetUSD = 100;
    await service.testConfiguration(config, { openai: "key-one" }, context);
    expect(provider.requests).toHaveLength(7);
    await service.testConfiguration(config, { openai: "key-two" }, context);
    expect(provider.requests).toHaveLength(14);
    config.routes.conversation.model = "gpt-6-astra";
    // Changed model routing requires fresh checks; the successful cached configuration is never reused.
    await expect(
      service.testConfiguration(config, { openai: "key-two" }, context),
    ).rejects.toThrow("no remaining response");
    expect(provider.requests.length).toBeGreaterThan(14);
  });
});

// A successful Responses probe is not proof that the distinct Decisions endpoint is usable.
it("requires the configured bounded-decision capability before declaring connection readiness", async () => {
  const provider = new ScriptedProvider([
    ...Array.from({ length: 6 }, () => answer),
    { text: "unsupported", toolCalls: [] },
  ]);
  const service = new AIService(demoAIConfig(), {
    providers: { openai: provider },
  });
  await expect(
    service.testConfiguration(defaultAIConfig(), { openai: "key" }, context),
  ).rejects.toThrow("bounded decisions");
  expect(service.health.state).toBe("error");
  expect(service.config.routes.conversation.provider).toBe("demo");
});

it("invalidates successful validation after real provider failure and forces explicit rechecks", async () => {
  const provider = new ScriptedProvider([
    ...probes(),
    new AIError("Key expired", "credentials"),
    ...probes(),
    ...probes(),
  ]);
  const config = defaultAIConfig();
  const service = new AIService(config, {
    providers: { openai: provider },
    credentials: () => ({ openai: "key" }),
  });
  await service.testConfiguration(config, { openai: "key" }, context);
  expect(provider.requests).toHaveLength(7);
  await expect(
    service.generate(
      "conversation",
      { messages: [{ role: "user", content: "hello" }] },
      context,
    ),
  ).rejects.toThrow("Key expired");
  expect(service.health.state).toBe("error");
  await service.testConfiguration(config, { openai: "key" }, context);
  expect(provider.requests).toHaveLength(15);
  await service.testConfiguration(config, { openai: "key" }, context, {
    force: true,
  });
  expect(provider.requests).toHaveLength(22);
  await service.testConfiguration(config, { openai: "key" }, context);
  expect(provider.requests).toHaveLength(22);
});
it("does not restore stale readiness when an explicit recheck fails", async () => {
  const provider = new ScriptedProvider([
    ...probes(),
    new AIError("No access", "access"),
    ...probes(),
  ]);
  const config = defaultAIConfig();
  const service = new AIService(config, { providers: { openai: provider } });
  await service.testConfiguration(config, { openai: "key" }, context);
  await expect(
    service.testConfiguration(config, { openai: "key" }, context, {
      force: true,
    }),
  ).rejects.toThrow("No access");
  expect(service.health.state).toBe("error");
  await service.testConfiguration(config, { openai: "key" }, context);
  expect(provider.requests).toHaveLength(15);
});

it("keeps an existing working connection healthy when an unsaved replacement key fails validation", async () => {
  const provider = new ScriptedProvider([
    ...probes(),
    new AIError("Wrong new key", "credentials"),
  ]);
  const config = defaultAIConfig();
  const service = new AIService(config, {
    providers: { openai: provider },
    credentials: () => ({ openai: "working-key" }),
  });
  await service.testConfiguration(config, { openai: "working-key" }, context);
  await expect(
    service.testConfiguration(config, { openai: "replacement-key" }, context),
  ).rejects.toThrow("Wrong new key");
  expect(service.health.state).toBe("ready");
});
