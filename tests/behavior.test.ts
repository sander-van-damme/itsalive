import { describe, expect, it } from "vitest";
import {
  BehaviorTracker,
  interpretInteractionPattern,
} from "../src/shell/core/behavior";
import { activateAlivePolicy, normalizeAlivePolicyProposal } from "../src/shell/core/alive-policy";
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

describe("shell behavioral session policy", () => {
  it("assembles bounded recent interaction context and a durable external summary", () => {
    const tracker = new BehaviorTracker();
    for (let seq = 1; seq <= 14; seq++) tracker.observe(appId, observation(seq), "Prefers fast feedback.");
    const state = tracker.observe(appId, observation(15), "Prefers fast feedback.");

    expect(state.historySummary).toBe("Prefers fast feedback.");
    expect(state.recentInteractions).toHaveLength(12);
    expect(state.recentInteractions.map(item => item.seq)).toEqual([4,5,6,7,8,9,10,11,12,13,14,15]);
    expect(state.document).toContain("Check answer");
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

  it("uses the app policy rather than hard-coded app words for repeatable controls", () => {
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
      likelyBenign: false,
      frustrationSignal: true,
    });

    const proposal = normalizeAlivePolicyProposal({
      repeatableInteractions: [{
        id: "hear-chord",
        description: "Repeated chord playback is normal practice",
        match: { targetHints: ["Hear chord"] },
      }],
    })!;
    const policy = activateAlivePolicy(proposal, undefined, 1);
    expect(interpretInteractionPattern(state, policy)).toMatchObject({
      likelyBenign: true,
      frustrationSignal: false,
    });
  });

  it("clears only session evidence while durable summaries remain external", () => {
    const tracker = new BehaviorTracker();
    tracker.observe(appId, observation(1), "Durable selected evidence");
    tracker.clear(appId);
    const fresh = tracker.observe(appId, observation(2), "Durable selected evidence");
    expect(fresh.recentInteractions.map(item => item.seq)).toEqual([2]);
    expect(fresh.historySummary).toBe("Durable selected evidence");
  });
});
