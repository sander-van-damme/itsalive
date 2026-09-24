import { describe, expect, it } from "vitest";
import {
  activateAlivePolicy,
  aliveMatcherMatches,
  normalizeAlivePolicyProposal,
  selectAlivePolicyContext,
} from "../src/shell/core/alive-policy";
import type { InteractionObservation } from "../src/shared";

function observation(label: string): InteractionObservation {
  return {
    interaction: {
      seq: 1,
      at: "2026-09-24T10:00:00.000Z",
      type: "click",
      target: { tag: "main" },
      actualTarget: { tag: "button", id: "primary-action", state: { "aria-label": label } },
    },
    pattern: {
      kind: "repeated-action",
      actionCount: 5,
      coalescedCount: 3,
      durationMs: 300,
      averageIntervalMs: 80,
      documentChangeCount: 0,
    },
    document: "<main>implementation details not policy context</main>",
  };
}

describe("alive policy", () => {
  it("normalizes different app-specific policies without hard-coded global semantics", () => {
    const stopwatch = normalizeAlivePolicyProposal({
      meaningfulEvents: [{ id: "lap", description: "Lap recorded", match: { targetHints: ["Lap"] } }],
      repeatableInteractions: [{ id: "timer-controls", description: "Start, pause, and lap are normal repeated controls", match: { targetHints: ["Lap"] } }],
      successSignals: ["Elapsed time advances after Start"],
      safeReactions: [{ id: "hint-lap", label: "Highlight the Lap control", kind: "highlight" }],
      invariants: ["Elapsed time and laps must never be silently discarded"],
      clarificationSignals: ["Repeated interaction on static elapsed-time text"],
      agentSignals: ["A requested timer control is missing"],
      retainEvidence: ["Repeated unmet intent around timer controls"],
    });
    const drawing = normalizeAlivePolicyProposal({
      meaningfulEvents: [{ id: "undo", description: "Undo/redo oscillation", match: { targetIds: ["undo"] } }],
      repeatableInteractions: [{ id: "canvas", description: "Pointer bursts on canvas are ordinary drawing", match: { interactionTypes: ["pointermove"], targetIds: ["canvas"] } }],
      successSignals: ["Canvas visibly changes after a stroke"],
      safeReactions: [{ id: "offer-undo", label: "Offer the existing Undo action", kind: "offer-existing-action" }],
      invariants: ["Canvas content must never be silently discarded"],
      clarificationSignals: ["Repeated undo/redo oscillation"],
      agentSignals: ["Tool requested by the user is unavailable"],
      retainEvidence: ["Repeated tool preference"],
    });

    expect(stopwatch).toBeDefined();
    expect(drawing).toBeDefined();
    expect(stopwatch).not.toEqual(drawing);
    expect(stopwatch!.safeReactions[0]).toMatchObject({ reversible: true });
    expect(stopwatch!.invariants).toContain("Elapsed time and laps must never be silently discarded");
  });

  it("rejects unusable policy proposals and activates valid proposals with revisions", () => {
    expect(normalizeAlivePolicyProposal({ nonsense: true })).toBeUndefined();
    const proposal = normalizeAlivePolicyProposal({
      repeatableInteractions: [{ id: "repeat", description: "Normal repeat", match: { targetHints: ["Repeat"] } }],
      invariants: ["Preserve user data"],
    })!;
    const first = activateAlivePolicy(proposal, undefined, 100);
    const second = activateAlivePolicy(proposal, first, 200);
    expect(first).toMatchObject({ schemaVersion: 1, revision: 1, updatedAt: 100 });
    expect(second).toMatchObject({ schemaVersion: 1, revision: 2, updatedAt: 200 });
  });

  it("matches exact app-specific target hints and emits only bounded selected policy context", () => {
    const proposal = normalizeAlivePolicyProposal({
      meaningfulEvents: [{ id: "check", description: "Answer check", match: { targetHints: ["Check answer"] } }],
      repeatableInteractions: [{ id: "practice", description: "Repeated correct practice is normal", match: { targetHints: ["Check answer"] } }],
      successSignals: ["Correct answer streak increases"],
      safeReactions: [{ id: "help", label: "Offer existing hint", kind: "offer-existing-action", match: { targetHints: ["Check answer"] } }],
      invariants: ["Do not silently change the learner's answer"],
      clarificationSignals: ["Repeated wrong answers with no improvement"],
      agentSignals: ["Exercise controls stop responding"],
      retainEvidence: ["Persistent difficulty on the same exercise"],
    })!;
    const policy = activateAlivePolicy(proposal, undefined, 100);
    const input = observation("Check answer");
    const rule = policy.repeatableInteractions[0]!;
    expect(aliveMatcherMatches(rule.match, input.interaction)).toBe(true);

    const context = selectAlivePolicyContext(policy, input, {
      ...input.pattern!,
      likelyBenign: true,
      frustrationSignal: false,
    })!;
    expect(context).toMatchObject({
      revision: 1,
      matchedMeaningfulEvents: ["Answer check"],
      matchedRepeatableInteractions: ["Repeated correct practice is normal"],
      invariants: ["Do not silently change the learner's answer"],
    });
    expect(context.safeReactions[0]).toMatchObject({ id: "help", reversible: true });
    expect(JSON.stringify(context)).not.toContain("implementation details");
    expect(JSON.stringify(context)).not.toContain("<main");
  });
});
