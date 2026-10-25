import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  AIError,
  HTTPProvider,
  OpenAIDecisionsProvider,
  defaultAIConfig,
  decisionRequest,
  parseDecisionResponse,
  validateDecisionInput,
  type DecisionInput,
} from "../src/ai";
const route = defaultAIConfig().routes.decision;
const context = { appId: "app", correlationId: "decision-test" };
const input: DecisionInput = {
  input: "My export failed once but worked on retry.",
  questions: [
    {
      type: "predicate",
      name: "blocked",
      instructions: "Is the user unable to continue?",
    },
    {
      type: "choice",
      name: "route",
      instructions: "Choose a queue.",
      choices: [{ value: "support" }, { value: "other" }],
    },
    {
      type: "score",
      name: "severity",
      instructions: "How severe?",
      levels: [{ label: "Minor" }, { label: "Blocked" }],
    },
  ],
};
const result = {
  model: "gpt-6-luna",
  answers: [
    { type: "predicate", name: "blocked", probability: 0.1 },
    {
      type: "choice",
      name: "route",
      choice: "support",
      confidence: 0.8,
      probabilities: [
        { value: "support", probability: 0.9 },
        { value: "other", probability: 0.1 },
      ],
    },
    {
      type: "score",
      name: "severity",
      score: 0.1,
      confidence: 0.8,
      probabilities: [
        { value: 0, label: "Minor", probability: 0.9 },
        { value: 1, label: "Blocked", probability: 0.1 },
      ],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  },
};
describe("OpenAI bounded Decisions", () => {
  it("uses the documented endpoint and preserves all probabilities and reported usage", async () => {
    const fetcher = vi.fn(function (
      this: unknown,
      _url: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      expect(this).toBeUndefined();
      return Promise.resolve(
        Response.json(result, { headers: { "x-request-id": "req-decisions" } }),
      );
    });
    const response = await new OpenAIDecisionsProvider(fetcher).decide(
      route,
      input,
      "private-key",
    );
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/decisions",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      model: "gpt-6-luna",
      ...input,
    });
    expect(response.answers).toEqual(result.answers);
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 8,
      cachedTokens: 20,
      cacheWriteTokens: 10,
    });
    expect(response.requestId).toBe("req-decisions");
    expect(response.endpoint).toBe("decisions");
  });
  it("accepts a large shared context and enforces only documented bounded-question cardinalities", () => {
    expect(
      decisionRequest(route, { ...input, input: "context".repeat(100_000) })
        .input,
    ).toHaveLength(700_000);
    const choices = Array.from({ length: 255 }, (_, i) => ({
      value: String(i),
    }));
    expect(() =>
      validateDecisionInput({
        input: "",
        questions: [
          { type: "choice", name: "allowed", instructions: "", choices },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateDecisionInput({
        input: "",
        questions: [
          {
            type: "choice",
            name: "oversized",
            instructions: "",
            choices: [...choices, { value: "256" }],
          },
        ],
      }),
    ).toThrow("2–255");
    expect(() =>
      validateDecisionInput({
        input: "",
        questions: [
          {
            type: "score",
            name: "oversized",
            instructions: "",
            levels: Array.from({ length: 11 }, () => ({ label: "x" })),
          },
        ],
      }),
    ).toThrow("2–10");
    expect(() =>
      decisionRequest({ ...route, model: "gpt-6.1-sol" }, input),
    ).toThrow("does not support");
    expect(() =>
      validateDecisionInput({
        input: "",
        questions: [...input.questions, input.questions[0]!],
      }),
    ).toThrow("distinct name");
  });
  it.each([
    (value: typeof result) => {
      value.answers[0]!.probability = 1.5;
    },
    (value: typeof result) => {
      value.answers[1]!.choice = "invented";
    },
    (value: typeof result) => {
      value.answers[1]!.confidence = -1;
    },
    (value: typeof result) => {
      value.answers[1]!.probabilities![0]!.probability = 0.4;
    },
    (value: typeof result) => {
      value.answers[2]!.score = 0.9;
    },
    (value: typeof result) => {
      value.answers[0]!.name = "wrong";
    },
  ])(
    "rejects malformed decisions while retaining usage for accounting",
    (mutate) => {
      const bad = structuredClone(result);
      mutate(bad);
      try {
        parseDecisionResponse(bad, input);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AIError);
        expect((error as AIError).response?.usage?.inputTokens).toBe(100);
      }
    },
  );
  it("preserves per-question refusals without inventing confidence", () => {
    const response = parseDecisionResponse(
      {
        ...result,
        answers: [
          { type: "refusal", name: "blocked" },
          ...result.answers.slice(1),
        ],
      },
      input,
    );
    expect(response.answers[0]).toEqual({ type: "refusal", name: "blocked" });
    expect(response.answers[1]!.type).toBe("choice");
  });
  it("reports provider errors without copying private response content", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("private source and credentials", { status: 429 }),
    );
    await expect(
      new OpenAIDecisionsProvider(fetcher).decide(route, input, "private-key"),
    ).rejects.toMatchObject({ kind: "limit" });
  });
  it("routes application predicates through Decisions with free output and cached-input accounting", async () => {
    const config = defaultAIConfig();
    const fetcher = vi.fn(async () =>
      Response.json({
        ...result,
        answers: [{ type: "predicate", name: "result", probability: 0.8 }],
      }),
    );
    const service = new AIService(config, {
      credentials: () => ({ openai: "private-key" }),
      providers: { openai: new HTTPProvider("openai", fetcher) },
    });
    expect(
      await service.application(
        { method: "decide", prompt: "Is the user blocked?" },
        context,
      ),
    ).toBe(true);
    expect(fetcher.mock.calls[0]).toBeDefined();
    expect(service.usage[0]!.outputTokens).toBe(8);
    expect(service.usage[0]!.costUSD).toBeCloseTo(
      (70 * 0.1 + 20 * 0.01 + 10 * 0.125) / 1_000_000,
      10,
    );
  });
  it("keeps arbitrary structured output on Responses when the configured decision model is unsupported", async () => {
    const config = defaultAIConfig();
    config.routes.decision.model = "gpt-6.1-sol";
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"value":true}' }],
            },
          ],
        }),
    );
    const service = new AIService(config, {
      credentials: () => ({ openai: "private-key" }),
      providers: { openai: new HTTPProvider("openai", fetcher) },
    });
    expect(
      await service.application(
        { method: "decide", prompt: "Is it true?" },
        context,
      ),
    ).toBe(true);
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/responses",
    );
  });
  it.each(["context_length_exceeded", "rate_limit_exceeded"])(
    "retains reported usage on an HTTP failure (%s)",
    async (code) => {
      const fetcher = vi.fn(async () =>
        Response.json(
          { error: { code, message: "private" }, usage: result.usage },
          { status: 400 },
        ),
      );
      try {
        await new OpenAIDecisionsProvider(fetcher).decide(
          route,
          input,
          "private-key",
        );
        throw new Error("Expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AIError);
        expect((error as AIError).response?.usage?.inputTokens).toBe(100);
        expect((error as Error).message).not.toContain("private");
        if (code === "context_length_exceeded")
          expect((error as AIError).kind).toBe("context");
      }
    },
  );
  it("uses structured Responses for cardinalities beyond the real Decisions schema", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: '{"value":"option-255"}' },
              ],
            },
          ],
        }),
    );
    const service = new AIService(defaultAIConfig(), {
      credentials: () => ({ openai: "private-key" }),
      providers: { openai: new HTTPProvider("openai", fetcher) },
    });
    const options = Array.from(
      { length: 256 },
      (_, index) => `option-${index}`,
    );
    expect(
      await service.application(
        { method: "choose", prompt: "Choose the last option.", options },
        context,
      ),
    ).toBe("option-255");
    expect(fetcher.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(
      JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).text.format.schema
        .properties.value.enum,
    ).toEqual(options);
  });
});
