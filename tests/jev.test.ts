import { describe, expect, it, vi } from "vitest";
import { decideJevEscalation, JEV_MODEL, OPENROUTER_DECISIONS_URL, OpenRouterJevAdapter, type JevQuestions } from "../src/shell/core/jev";
import type { JevState } from "../src/shared";

const credential = { value: "sk-or-test" };
const state = { interaction: { seq: 1 } };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OpenRouter Jev adapter", () => {
  it("preserves the existing interaction wake-up decision while exposing typed diagnostics", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { void url; void init; return jsonResponse({ id: "gen-dec-test", provider: "TypeSafe", model: "typesafe/jev-1.13-20260917", answers: { requires_llm_attention: { type: "noul", noul: .82 } }, usage: { input_tokens: 71, output_tokens: 3, cost: 0.000002982 } }); });
    const result = await new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state }, credential);
    expect(result).toMatchObject({ probability: .82, answers: { requires_llm_attention: { type: "noul", noul: .82 } }, usage: { inputTokens: 71, outputTokens: 3, cost: 0.000002982 }, diagnostics: { requestId: "gen-dec-test", provider: "TypeSafe", model: "typesafe/jev-1.13-20260917" } });
    expect(result.diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fetcher).toHaveBeenCalledWith(OPENROUTER_DECISIONS_URL, expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer sk-or-test" }) }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ model: JEV_MODEL, state, questions: { requires_llm_attention: { type: "noul" } } });
  });

  it("returns Noul, Choice, and Score answers from one focused request", async () => {
    const questions = {
      needs_repair: { type: "noul", instructions: "Does the bounded state show a repair is needed?" },
      route: { type: "choice", instructions: "Which bounded route best fits?", criteria: { local: "Deterministic local handling", agent: "Reasoning-agent handling" } },
      severity: { type: "score", instructions: "How severe is the observed failure?", criteria: ["No functional impact", "Degraded with workaround", "Blocking"] },
    } satisfies JevQuestions;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { void url; void init; return jsonResponse({
      id: "gen-dec-mixed", provider: "TypeSafe", model: "typesafe/jev-1.13-20260917",
      answers: {
        needs_repair: { type: "noul", noul: .91 },
        route: { type: "choice", choice: "agent", probabilities: { local: .08, agent: .92 }, confidence: .84 },
        severity: { type: "score", score: 1.2, legend: { "0": "No functional impact", "1": "Degraded with workaround", "2": "Blocking" }, probabilities: { "0": .05, "1": .7, "2": .25 }, confidence: .73 },
      },
    }); });
    const result = await new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state, questions }, credential);
    expect(result.answers).toEqual({
      needs_repair: { type: "noul", noul: .91 },
      route: { type: "choice", choice: "agent", probabilities: { local: .08, agent: .92 }, confidence: .84 },
      severity: { type: "score", score: 1.2, legend: { "0": "No functional impact", "1": "Degraded with workaround", "2": "Blocking" }, probabilities: { "0": .05, "1": .7, "2": .25 }, confidence: .73 },
    });
    expect(result.probability).toBe(0);
    const payload = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(payload.questions).toEqual(questions);
  });

  it("invokes fetch with the browser global as its receiver", async () => {
    const receivers: unknown[] = [];
    const fetcher = vi.fn(function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(jsonResponse({ answers: { requires_llm_attention: { type: "noul", noul: .4 } } }));
    });
    await new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state }, credential);
    expect(receivers).toEqual([globalThis]);
  });

  it.each([
    [{ answers: { requires_llm_attention: { probability: .9 } } }, /mismatched answer type|malformed answer/],
    [{ answers: {} }, /omitted answer/],
    [{ answers: { requires_llm_attention: { type: "noul", noul: 1.2 } } }, /malformed Noul/],
  ])("rejects malformed or incomplete Noul responses", async (body, message) => {
    const fetcher = vi.fn(async () => jsonResponse(body));
    await expect(new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state }, credential)).rejects.toThrow(message);
  });

  it("rejects incomplete Choice distributions", async () => {
    const questions = { route: { type: "choice", instructions: "Route it", criteria: { local: "Local", agent: "Agent" } } } satisfies JevQuestions;
    const fetcher = vi.fn(async () => jsonResponse({ answers: { route: { type: "choice", choice: "agent", probabilities: { agent: 1 }, confidence: 1 } } }));
    await expect(new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state, questions }, credential)).rejects.toThrow(/incomplete Choice/);
  });

  it("rejects incomplete Score legends", async () => {
    const questions = { severity: { type: "score", instructions: "Severity", criteria: ["Low", "High"] } } satisfies JevQuestions;
    const fetcher = vi.fn(async () => jsonResponse({ answers: { severity: { type: "score", score: 1, legend: { "0": "Low" }, probabilities: { "0": 0, "1": 1 }, confidence: 1 } } }));
    await expect(new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state, questions }, credential)).rejects.toThrow(/incomplete Score legend/);
  });

  it.each([[401, "401"], [429, "429"]])("reports provider status %i", async (status, message) => {
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: "provider error" } }, status));
    await expect(new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state }, credential)).rejects.toThrow(message);
  });

  it("passes through cancellation for timeout handling", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })));
    const pending = new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state, signal: controller.signal }, credential); controller.abort(new DOMException("timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("Jev sequence-aware escalation", () => {
  const state = (likelyBenign: boolean, frustrationSignal: boolean): JevState => ({
    interaction: { seq: 5, at: "2026-01-01T00:00:00Z", type: "click", target: { tag: "section" }, actualTarget: { tag: "button" } },
    recentInteractions: [],
    pattern: { kind: "repeated-action", actionCount: 5, coalescedCount: 3, durationMs: 320, averageIntervalMs: 80, documentChangeCount: 0, likelyBenign, frustrationSignal },
    document: "<main><button>Check answer</button></main>",
  });

  it("escalates a repeated unchanged frustration pattern below the ordinary model threshold", () => {
    expect(decideJevEscalation(.2, state(false, true))).toEqual({ escalated: true, reason: "repeated-unchanged-action" });
  });
  it("does not boost a likely-benign rapid repeat", () => {
    expect(decideJevEscalation(.2, state(true, false))).toEqual({ escalated: false, reason: "none" });
  });
  it("still honors a high-confidence model decision", () => {
    expect(decideJevEscalation(.8, state(true, false))).toEqual({ escalated: true, reason: "model-threshold" });
  });
});
