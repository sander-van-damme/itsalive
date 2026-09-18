import type { Credential, DecisionModel, DecisionRequest, DecisionResult } from "./types";

export const JEV_MODEL = "typesafe/jev";
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
export class CloudflareJevAdapter implements DecisionModel {
  readonly id = "cloudflare-jev";
  constructor(private readonly accountId: string, private readonly fetcher: typeof fetch = fetch) {}
  async evaluate(request: DecisionRequest, credential?: Credential): Promise<DecisionResult> {
    if (!credential?.value) throw new Error("Jev credential is not configured");
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${JEV_MODEL}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential.value}` },
      body: JSON.stringify({ state: request.state, questions: GENERIC_JEV_QUESTION }), signal: request.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Jev provider failed (${response.status})`);
    const result = body.result as Record<string, unknown> | undefined;
    const raw = result?.requires_llm_attention;
    const probability = typeof raw === "number" ? raw : raw && typeof raw === "object" ? (raw as Record<string, unknown>).probability : undefined;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Jev provider returned a malformed Noul probability");
    return { probability, raw: body };
  }
}

export class MockDecisionModel implements DecisionModel {
  readonly id = "mock-jev";
  constructor(private readonly decide: (request: DecisionRequest) => number | Promise<number>) {}
  async evaluate(request: DecisionRequest): Promise<DecisionResult> { return { probability: await this.decide(request) }; }
}

