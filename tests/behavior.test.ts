import { describe, expect, it } from "vitest";
import {
  BehaviorTracker,
  behaviorRewritePrompt,
  interpretInteractionPattern,
} from "../src/shell/core/behavior";
import type { InteractionObservation } from "../src/shared";

const appId = "550e8400-e29b-41d4-a716-446655440000";

function observation(seq: number, overrides: Partial<InteractionObservation> = {}): InteractionObservation {
  return {
    interaction: {
      seq,
      at: new Date(seq * 100).toISOString(),
      type: "click",
      target: { tag: "section" },
      actualTarget: { tag: "button", state: { "aria-label": "Check answer" } },
    },
    document: "<html><body><button>Check answer</button></body></html>",
    ...overrides,
  };
}

describe("shell behavioral history policy", () => {
  it("assembles recent interaction context and persisted summary in the shell", () => {
    const tracker = new BehaviorTracker(12);
    const first = tracker.observe(appId, observation(1), "Prefers fast feedback.");
    const second = tracker.observe(appId, observation(2), "Prefers fast feedback.");

    expect(first.historySummary).toBe("Prefers fast feedback.");
    expect(second.recentInteractions.map(item => item.seq)).toEqual([1, 2]);
    expect(second.document).toContain("Check answer");
  });

  it("classifies rapid unchanged repeats as frustration in the shell", () => {
    const state = observation(5, {
      pattern: {
        kind: "repeated-action",
        actionCount: 5,
        coalescedCount: 3,
        durationMs: 320,
        averageIntervalMs: 80,
        documentChangeCount: 0,
      },
    });
    expect(interpretInteractionPattern(state)).toMatchObject({
      likelyBenign: false,
      frustrationSignal: true,
    });
  });

  it("treats explicit/media-style repeatable controls as benign", () => {
    const state = observation(5, {
      interaction: {
        ...observation(5).interaction,
        actualTarget: { tag: "button", state: { "aria-label": "Hear chord" } },
      },
      pattern: {
        kind: "repeated-action",
        actionCount: 5,
        coalescedCount: 3,
        durationMs: 320,
        averageIntervalMs: 80,
        documentChangeCount: 0,
      },
    });
    expect(interpretInteractionPattern(state)).toMatchObject({
      likelyBenign: true,
      frustrationSignal: false,
    });
  });

  it("batches ephemeral samples for rewrite without persisting raw events", () => {
    const tracker = new BehaviorTracker(3);
    tracker.observe(appId, observation(1));
    tracker.observe(appId, observation(2));
    expect(tracker.takeRewriteBatch(appId)).toBeUndefined();
    tracker.observe(appId, observation(3));
    const batch = tracker.takeRewriteBatch(appId);
    expect(batch).toHaveLength(3);
    expect(behaviorRewritePrompt("Existing preference", batch!)).toContain("Existing preference");
    expect(behaviorRewritePrompt("Existing preference", batch!)).toContain("New ephemeral interactions");
  });

  it("restores a failed rewrite batch for a later shell retry", () => {
    const tracker = new BehaviorTracker(2);
    tracker.observe(appId, observation(1));
    tracker.observe(appId, observation(2));
    const batch = tracker.takeRewriteBatch(appId)!;
    tracker.restoreRewriteBatch(appId, batch);
    expect(tracker.takeRewriteBatch(appId)).toHaveLength(2);
  });

  it("clears only ephemeral context while durable summaries remain external", () => {
    const tracker = new BehaviorTracker(2);
    tracker.observe(appId, observation(1), "Durable summary");
    tracker.clear(appId);
    const fresh = tracker.observe(appId, observation(2), "Durable summary");
    expect(fresh.recentInteractions.map(item => item.seq)).toEqual([2]);
    expect(fresh.historySummary).toBe("Durable summary");
  });
});
