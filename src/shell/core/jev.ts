import type { Credential, DecisionModel, DecisionRequest, DecisionResult } from "./types";

export const JEV_MODEL = "~typesafe/jev-latest";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const GENERIC_JEV_QUESTION = {
  requires_llm_attention: {
    type: "noul" as const,
    instructions: "Given this user interaction, recent interactions, and current semantic application document, should the application invoke its reasoning agent because an intelligent or adaptive response may be useful?",
    criteria: {
      true: "Meaningful adaptation, assistance, or deeper contextual reasoning may be useful, including behavior suggesting an unmet need.",
      false: "This is an ordinary expected interaction and existing application behavior is sufficient.",
    },
  },
};

/** Narrow typed-decision adapter; deliberately separate from text generation. */
export class OpenRouterJevAdapter implements DecisionModel {
  readonly id = "openrouter-jev";
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async evaluate(request: DecisionRequest, credential?: Credential): Promise<DecisionResult> {
    if (!credential?.value) throw new Error("Jev credential is not configured");
    // Browser-native fetch is a Web IDL method and may throw "Illegal invocation"
    // when called as an arbitrary object method. Always provide the browser global
    // as its receiver; test/mocked fetch functions work with the same call shape.
    const response = await this.fetcher.call(globalThis, OPENROUTER_DECISIONS_URL, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential.value}` },
      body: JSON.stringify({ model: JEV_MODEL, state: request.state, questions: GENERIC_JEV_QUESTION }), signal: request.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`OpenRouter Jev failed (${response.status})`);
    const answers = body.answers as Record<string, unknown> | undefined;
    const answer = answers?.requires_llm_attention as Record<string, unknown> | undefined;
    const probability = answer?.noul;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Jev provider returned a malformed Noul probability");
    const usage = body.usage as Record<string, unknown> | undefined;
    return { probability, ...(typeof usage?.input_tokens === "number" ? { usage: { inputTokens: usage.input_tokens } } : {}) };
  }
}

export class MockDecisionModel implements DecisionModel {
  readonly id = "mock-jev";
  constructor(private readonly decide: (request: DecisionRequest) => number | Promise<number>) {}
  async evaluate(request: DecisionRequest): Promise<DecisionResult> { return { probability: await this.decide(request) }; }
}
