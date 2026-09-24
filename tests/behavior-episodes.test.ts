import { describe, expect, it } from "vitest";
import {
  behaviorEpisodeRetentionPlan,
  behaviorSummaryFromEpisodes,
  decideBehaviorEpisodeRetention,
  formBehaviorEpisode,
  mergeBehaviorEpisode,
  type BehaviorEpisodeRecord,
} from "../src/shell/core/behavior-episodes";
import { interpretInteractionPattern } from "../src/shell/core/behavior";
import { activateAlivePolicy, normalizeAlivePolicyProposal } from "../src/shell/core/alive-policy";
import type { JevDecisionResult } from "../src/shell/core/jev";
import type { InteractionObservation } from "../src/shared";

function observation(label = "Check answer", changes = 0): InteractionObservation {
  return {
    interaction: {
      seq: 5,
      at: "2026-09-24T08:00:00.000Z",
      type: "click",
      target: { tag: "section" },
      actualTarget: { tag: "button", state: { "aria-label": label } },
    },
    pattern: {
      kind: "repeated-action",
      actionCount: 5,
      coalescedCount: 3,
      durationMs: 320,
      averageIntervalMs: 80,
      documentChangeCount: changes,
    },
    document: "<html><body><button>Private page content</button></body></html>",
  };
}

function triageResult(retain: number, choice: string, confidence: number): JevDecisionResult {
  return {
    probability: 0,
    answers: {
      retain_behavior_episode: { type: "noul", noul: retain },
      behavior_evidence_kind: {
        type: "choice",
        choice,
        probabilities: { [choice]: confidence },
        confidence,
      },
    },
    diagnostics: { elapsedMs: 1 },
  };
}

describe("behavior episode formation and triage", () => {
  it("drops routine one-off interactions before semantic triage", () => {
    const input = { ...observation(), pattern: undefined };
    expect(formBehaviorEpisode(input, undefined)).toEqual({ action: "drop", reason: "ordinary-interaction" });
  });

  it("drops repeatable or visibly successful repeats before semantic triage", () => {
    const benign = observation("Hear chord");
    const policy = activateAlivePolicy(normalizeAlivePolicyProposal({
      repeatableInteractions: [{
        id: "hear-chord",
        description: "Chord playback is intentionally repeatable",
        match: { targetHints: ["Hear chord"] },
      }],
    })!, undefined, 1);
    const benignPattern = interpretInteractionPattern(benign, policy);
    expect(formBehaviorEpisode(benign, benignPattern)).toEqual({ action: "drop", reason: "benign-repeat" });

    const changed = observation("Check answer", 2);
    const changedPattern = interpretInteractionPattern(changed);
    expect(formBehaviorEpisode(changed, changedPattern)).toEqual({ action: "drop", reason: "successful-changing-repeat" });
  });

  it("forms a compact repeated-friction episode without persisting the semantic document", () => {
    const input = observation();
    const pattern = interpretInteractionPattern(input);
    const formed = formBehaviorEpisode(input, pattern, 1000);
    expect(formed.action).toBe("triage");
    if (formed.action !== "triage") throw new Error("expected triage candidate");
    expect(formed.candidate).toMatchObject({
      formedAt: 1000,
      actionCount: 5,
      documentChangeCount: 0,
      frustrationSignal: true,
      targetTag: "button",
    });
    expect(JSON.stringify(formed.candidate)).not.toContain("Private page content");
    expect(JSON.stringify(formed.candidate)).not.toContain("<html");
  });

  it("retains only confident non-routine evidence", () => {
    expect(decideBehaviorEpisodeRetention(triageResult(0.92, "unresolved_need", 0.88))).toMatchObject({
      action: "retain",
      kind: "unresolved-need",
    });
    expect(decideBehaviorEpisodeRetention(triageResult(0.92, "preference", 0.4))).toMatchObject({
      action: "drop",
      reason: "classification-uncertain",
    });
    expect(decideBehaviorEpisodeRetention(triageResult(0.9, "routine", 0.9))).toMatchObject({
      action: "drop",
      reason: "classified-routine",
    });
    expect(decideBehaviorEpisodeRetention(triageResult(0.3, "unresolved_need", 0.9))).toMatchObject({
      action: "drop",
      reason: "retention-below-threshold",
    });
  });

  it("coalesces matching durable episodes instead of growing one record per burst", () => {
    const input = observation();
    const pattern = interpretInteractionPattern(input);
    const formed = formBehaviorEpisode(input, pattern, 1000);
    if (formed.action !== "triage") throw new Error("expected triage candidate");
    const triage = decideBehaviorEpisodeRetention(triageResult(0.9, "unresolved_need", 0.9));
    const first = mergeBehaviorEpisode("app", [], formed.candidate, triage, "episode-1", 1000)!;
    const second = mergeBehaviorEpisode("app", [first], formed.candidate, triage, "episode-2", 2000)!;
    expect(second.id).toBe("episode-1");
    expect(second.occurrences).toBe(2);
    expect(second.lastSeenAt).toBe(2000);
  });

  it("bounds durable retention by age and count and derives summary only from retained evidence", () => {
    const records: BehaviorEpisodeRecord[] = Array.from({ length: 5 }, (_, index) => ({
      id: `episode-${index}`,
      appId: "app",
      createdAt: index,
      lastSeenAt: index * 1000,
      kind: index % 2 ? "preference" : "session-evidence",
      fingerprint: `f-${index}`,
      signal: `signal ${index}`,
      interactionType: "click",
      targetTag: "button",
      actionCount: 5,
      documentChangeCount: 0,
      frustrationSignal: false,
      occurrences: 1,
      retentionProbability: 0.9,
      classificationConfidence: 0.9,
    }));
    const plan = behaviorEpisodeRetentionPlan(records, 5000, 2, 10_000);
    expect(plan.keep.map(item => item.id)).toEqual(["episode-4", "episode-3"]);
    expect(plan.deleteIds).toEqual(expect.arrayContaining(["episode-0", "episode-1", "episode-2"]));
    const summary = behaviorSummaryFromEpisodes(plan.keep)!;
    expect(summary).toContain("[session-evidence] signal 4");
    expect(summary).toContain("[preference] signal 3");
    expect(summary).not.toContain("signal 2");
  });
});
