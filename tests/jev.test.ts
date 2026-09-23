import { describe, expect, it, vi } from "vitest";
import { decideJevEscalation, JEV_MODEL, OPENROUTER_DECISIONS_URL, OpenRouterJevAdapter } from "../src/shell/core/jev";
import type { JevState } from "../src/shared";

const credential = { value: "sk-or-test" };
const state = { interaction: { seq: 1 } };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OpenRouter Jev adapter", () => {
  it("uses the decisions contract and normalizes a realistic Noul answer", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { void url; void init; return jsonResponse({ model: JEV_MODEL, answers: { requires_llm_attention: { type: "noul", noul: .82 } }, usage: { input_tokens: 71, output_tokens: 3, cost: 0.000002982 } }); });
    await expect(new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state }, credential)).resolves.toEqual({ probability: .82, usage: { inputTokens: 71, outputTokens: 3, cost: 0.000002982 } });
    expect(fetcher).toHaveBeenCalledWith(OPENROUTER_DECISIONS_URL, expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer sk-or-test" }) }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ model: "~typesafe/jev-latest", state, questions: { requires_llm_attention: { type: "noul" } } });
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

  it("rejects malformed responses", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ answers: { requires_llm_attention: { probability: .9 } } }));
    await expect(new OpenRouterJevAdapter(fetcher as typeof fetch).evaluate({ state }, credential)).rejects.toThrow(/malformed Noul/);
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
    pattern: {
      kind: "repeated-action",
      actionCount: 5,
      coalescedCount: 3,
      durationMs: 320,
      averageIntervalMs: 80,
      documentChangeCount: 0,
      likelyBenign,
      frustrationSignal,
    },
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
