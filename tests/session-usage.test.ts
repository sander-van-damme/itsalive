import { describe, expect, it } from "vitest";
import { SessionUsageTracker } from "../src/shell/core/session-usage";

describe("SessionUsageTracker", () => {
  it("keeps LLM and JEV usage in independent buckets", () => {
    const tracker = new SessionUsageTracker();
    tracker.recordLlmGeneration({ inputTokens: 100, outputTokens: 20, cost: 0.01 });
    tracker.recordLlmGeneration({ inputTokens: 50, outputTokens: 10, cost: 0.005 });
    tracker.recordJevDecision({ inputTokens: 2_000, outputTokens: 12, cost: 0.000084 });
    tracker.setContext(2_400, 1_000_000);
    tracker.setKeyInfo({ usage: 3.25, limit: 10, limitRemaining: 6.75 });

    expect(tracker.snapshot()).toEqual({
      llm: { requests: 2, inputTokens: 150, outputTokens: 30, cost: 0.015, costComplete: true },
      jev: { requests: 1, inputTokens: 2_000, outputTokens: 12, cost: 0.000084, costComplete: true },
      latestContextTokens: 2_400,
      contextCapacity: 1_000_000,
      keyUsage: 3.25,
      keyLimit: 10,
      keyLimitRemaining: 6.75,
    });
  });

  it("tracks incomplete pricing independently per meter", () => {
    const tracker = new SessionUsageTracker();
    tracker.recordLlmGeneration({ inputTokens: 100, outputTokens: 20, cost: 0.01 });
    tracker.recordLlmGeneration({ inputTokens: 50, outputTokens: 10 });
    tracker.recordJevDecision({ inputTokens: 25, outputTokens: 2, cost: 0 });

    expect(tracker.snapshot()).toEqual({
      llm: { requests: 2, inputTokens: 150, outputTokens: 30, cost: 0.01, costComplete: false },
      jev: { requests: 1, inputTokens: 25, outputTokens: 2, cost: 0, costComplete: true },
    });
  });

  it("counts a successful provider request even when usage metadata is absent", () => {
    const tracker = new SessionUsageTracker();
    tracker.recordLlmGeneration(undefined);
    tracker.recordJevDecision(undefined);

    expect(tracker.snapshot()).toEqual({
      llm: { requests: 1, inputTokens: 0, outputTokens: 0, costComplete: false },
      jev: { requests: 1, inputTokens: 0, outputTokens: 0, costComplete: false },
    });
  });

  it("restores both session meters across a shell reload without persisting account metadata", () => {
    const first = new SessionUsageTracker();
    first.recordLlmGeneration({ inputTokens: 100, outputTokens: 20, cost: 0.01 });
    first.recordJevDecision({ inputTokens: 250, outputTokens: 0, cost: 0.0000105 });
    first.setContext(2_400, 1_000_000);
    first.setKeyInfo({ usage: 3.25, limit: 10, limitRemaining: 6.75 });

    const restored = new SessionUsageTracker(first.state());

    expect(restored.snapshot()).toEqual({
      llm: { requests: 1, inputTokens: 100, outputTokens: 20, cost: 0.01, costComplete: true },
      jev: { requests: 1, inputTokens: 250, outputTokens: 0, cost: 0.0000105, costComplete: true },
    });
  });

  it("resets both meters and account metadata when the active API key changes", () => {
    const tracker = new SessionUsageTracker();
    tracker.recordLlmGeneration({ inputTokens: 10, outputTokens: 5, cost: 0.001 });
    tracker.recordJevDecision({ inputTokens: 100, outputTokens: 1, cost: 0.0000042 });
    tracker.setKeyInfo({ usage: 12, limitRemaining: 3 });
    tracker.setContext(500, 10_000);

    tracker.reset();

    expect(tracker.snapshot()).toEqual({
      llm: { requests: 0, inputTokens: 0, outputTokens: 0, costComplete: true },
      jev: { requests: 0, inputTokens: 0, outputTokens: 0, costComplete: true },
    });
  });
});
