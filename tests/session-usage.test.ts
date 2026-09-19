import { describe, expect, it } from "vitest";
import { SessionUsageTracker } from "../src/shell/core/session-usage";

describe("SessionUsageTracker", () => {
  it("accumulates real generation tokens, authoritative cost, key spend, and latest context", () => {
    const tracker = new SessionUsageTracker();
    tracker.recordGeneration({ inputTokens: 100, outputTokens: 20, cost: 0.01 });
    tracker.recordGeneration({ inputTokens: 50, outputTokens: 10, cost: 0.005 });
    tracker.setContext(2_400, 1_000_000);
    tracker.setKeyInfo({ usage: 3.25, limit: 10, limitRemaining: 6.75 });

    expect(tracker.snapshot()).toEqual({
      requests: 2,
      inputTokens: 150,
      outputTokens: 30,
      cost: 0.015,
      latestContextTokens: 2_400,
      contextCapacity: 1_000_000,
      keyUsage: 3.25,
      keyLimit: 10,
      keyLimitRemaining: 6.75,
    });
  });

  it("does not understate session cost when any generation omits authoritative cost", () => {
    const tracker = new SessionUsageTracker();
    tracker.recordGeneration({ inputTokens: 100, outputTokens: 20, cost: 0.01 });
    tracker.recordGeneration({ inputTokens: 50, outputTokens: 10 });

    const snapshot = tracker.snapshot();
    expect(snapshot.inputTokens).toBe(150);
    expect(snapshot.outputTokens).toBe(30);
    expect(snapshot.cost).toBeUndefined();
  });

  it("resets totals and account metadata when the active API key changes", () => {
    const tracker = new SessionUsageTracker();
    tracker.recordGeneration({ inputTokens: 10, outputTokens: 5, cost: 0.001 });
    tracker.setKeyInfo({ usage: 12, limitRemaining: 3 });
    tracker.setContext(500, 10_000);

    tracker.reset();

    expect(tracker.snapshot()).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0 });
  });
});
