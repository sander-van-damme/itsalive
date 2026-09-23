import { describe, expect, it } from "vitest";
import { LlmTraceTracker, normalizeLlmUsage } from "../src/shell/core/llm-trace";
import type { LlmTraceEvent } from "../src/shell/core/types";

function event(overrides: Partial<LlmTraceEvent> = {}): LlmTraceEvent {
  return {
    requestId: crypto.randomUUID(),
    runId: "run-parent",
    agentId: "worker-a",
    parentRunId: "manager-run",
    parentAgentId: "manager",
    role: "component-worker",
    profile: "worker-low",
    scope: "#timer-controls",
    purpose: "agent turn 1",
    provider: "openrouter",
    model: "openrouter/auto",
    streaming: true,
    startedAt: 1,
    elapsedMs: 25,
    status: "success",
    turn: 1,
    usage: normalizeLlmUsage({
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      cost: 0.01,
    }),
    ...overrides,
  };
}

describe("LLM trace accounting", () => {
  it("represents missing provider usage as unknown rather than zero", () => {
    expect(normalizeLlmUsage(undefined)).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cost: null,
    });
    expect(normalizeLlmUsage({ inputTokens: 0, cost: 0 })).toMatchObject({
      inputTokens: 0,
      cost: 0,
    });
  });

  it("rolls up one agent while preserving hierarchy and completeness", () => {
    const tracker = new LlmTraceTracker();
    tracker.record(event());
    tracker.record(event({
      requestId: "second",
      turn: 2,
      elapsedMs: 40,
      usage: normalizeLlmUsage({
        inputTokens: 120,
        outputTokens: 30,
        cost: 0.02,
      }),
    }));

    const [rollup] = tracker.rollups();
    expect(rollup).toMatchObject({
      runId: "run-parent",
      agentId: "worker-a",
      parentRunId: "manager-run",
      parentAgentId: "manager",
      role: "component-worker",
      profile: "worker-low",
      scope: "#timer-controls",
      requests: 2,
      successes: 2,
      errors: 0,
      elapsedMs: 65,
      turns: 2,
      inputTokens: { value: 220, complete: true },
      outputTokens: { value: 50, complete: true },
      cost: { value: 0.03, complete: true },
    });
    expect(rollup!.cachedInputTokens).toEqual({ value: 80, complete: false });
    expect(rollup!.cacheWriteTokens).toEqual({ value: 10, complete: false });
    expect(rollup!.reasoningTokens).toEqual({ value: 5, complete: false });
  });

  it("keeps different workers and parents in separate rollups", () => {
    const tracker = new LlmTraceTracker();
    tracker.record(event());
    tracker.record(event({
      requestId: "worker-b-request",
      agentId: "worker-b",
      scope: "#lap-list",
      usage: normalizeLlmUsage({ inputTokens: 50, outputTokens: 5, cost: 0.001 }),
    }));
    expect(tracker.rollups()).toHaveLength(2);
  });

  it("bounds in-memory request history without losing the newest traces", () => {
    const tracker = new LlmTraceTracker(2);
    tracker.record(event({ requestId: "one" }));
    tracker.record(event({ requestId: "two" }));
    tracker.record(event({ requestId: "three" }));

    expect(tracker.snapshot().map(item => item.requestId)).toEqual(["two", "three"]);
  });
});
