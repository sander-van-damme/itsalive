import { describe, expect, it } from "vitest";
import {
  adaptationFingerprint,
  appendAdaptationHistory,
  createActiveAdaptation,
  decideAdaptationOutcome,
  finalizeAdaptation,
  JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION,
  markAdaptationApplied,
  recordAdaptationAssessment,
  shouldSuppressAdaptation,
  type AdaptationAssessmentAction,
} from "../src/shell/core/adaptation";
import { runJevReplay, type JevReplayFixture } from "../src/shell/core/jev-eval";
import type { JevDecisionResult } from "../src/shell/core/jev";

function result(helped: number, outcome: string, confidence = 0.9): JevDecisionResult {
  return {
    probability: helped,
    answers: {
      adaptation_helped: { type: "noul", noul: helped },
      adaptation_outcome: {
        type: "choice",
        choice: outcome,
        probabilities: { [outcome]: confidence },
        confidence,
      },
    },
    diagnostics: { elapsedMs: 1 },
  };
}

const beforeDocument = {
  html: "<main><button>Old</button></main>",
  scripts: [{ placement: "body" as const, attributes: {}, content: "window.old = true;" }],
  store: "{}",
};

describe("adaptation lifecycle", () => {
  it("keeps the reversible snapshot only on the active adaptation and compacts finalized history", () => {
    const active = createActiveAdaptation({
      id: "adapt-1",
      interactionKey: "click|button|save",
      hypothesis: "The save button did not behave as expected.",
      technicalGoal: "Make Save clearly persist the item.",
      intendedOutcome: "Clicking Save visibly persists the item.",
      beforeDocument,
      now: 100,
    });
    const applied = markAdaptationApplied(active, 120);
    const assessed = recordAdaptationAssessment(applied, {
      action: "successful",
      reason: "success-evidence",
      helpedProbability: 0.9,
      classificationConfidence: 0.92,
    });
    const final = finalizeAdaptation(assessed, "successful", "explicit-user-keep", 200);

    expect(applied.beforeDocument).toEqual(beforeDocument);
    expect(applied.beforeDocument).not.toBe(beforeDocument);
    expect(final).toMatchObject({
      id: "adapt-1",
      outcome: "successful",
      assessments: 1,
      completedAt: 200,
    });
    expect(final).not.toHaveProperty("beforeDocument");
  });

  it("suppresses only repeated failed versions of the same adaptation hypothesis", () => {
    const fingerprint = adaptationFingerprint("click|button|save", "Make Save persist");
    const history = [
      { id: "a", createdAt: 1, completedAt: 10, fingerprint, hypothesis: "h", intendedOutcome: "o", outcome: "reverted" as const, reason: "undo", assessments: 1 },
      { id: "b", createdAt: 2, completedAt: 20, fingerprint, hypothesis: "h", intendedOutcome: "o", outcome: "harmful" as const, reason: "harm", assessments: 1 },
      { id: "c", createdAt: 3, completedAt: 30, fingerprint: "other", hypothesis: "h", intendedOutcome: "o", outcome: "failed" as const, reason: "fail", assessments: 0 },
    ];
    expect(shouldSuppressAdaptation(history, fingerprint, 40)).toBe(true);
    expect(shouldSuppressAdaptation(history, "other", 40)).toBe(false);

    const kept = appendAdaptationHistory(history, {
      id: "d", createdAt: 4, completedAt: 50, fingerprint, hypothesis: "h", intendedOutcome: "o",
      outcome: "successful", reason: "keep", assessments: 2,
    }, 2);
    expect(kept.map(item => item.id)).toEqual(["d", "c"]);
  });
});

describe("Jev adaptation outcome policy", () => {
  it("distinguishes successful, neutral, rejected, harmful and uncertain evidence", () => {
    expect(decideAdaptationOutcome(result(0.9, "successful"))).toMatchObject({ action: "successful" });
    expect(decideAdaptationOutcome(result(0.5, "neutral"))).toMatchObject({ action: "neutral" });
    expect(decideAdaptationOutcome(result(0.2, "rejected"))).toMatchObject({ action: "rejected" });
    expect(decideAdaptationOutcome(result(0.1, "harmful"))).toMatchObject({ action: "harmful" });
    expect(decideAdaptationOutcome(result(0.8, "successful", 0.4))).toMatchObject({ action: "uncertain" });
  });

  it("replays the four requested outcome classes without turning uncertainty into success", () => {
    type Input = { helped: number; outcome: string; confidence?: number };
    const fixtures: JevReplayFixture<Input, AdaptationAssessmentAction>[] = [
      { id: "success", description: "friction stopped and outcome works", decisionKind: "adaptation-outcome", questionSetVersion: JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION, input: { helped: 0.92, outcome: "successful" }, expectedAction: "successful", risk: "false-negative" },
      { id: "neutral", description: "meaningful evidence but no clear effect", decisionKind: "adaptation-outcome", questionSetVersion: JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION, input: { helped: 0.48, outcome: "neutral" }, expectedAction: "neutral", risk: "balanced" },
      { id: "rejected", description: "user immediately rejects the new path", decisionKind: "adaptation-outcome", questionSetVersion: JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION, input: { helped: 0.15, outcome: "rejected" }, expectedAction: "rejected", risk: "false-positive" },
      { id: "harmful", description: "new friction appeared after adaptation", decisionKind: "adaptation-outcome", questionSetVersion: JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION, input: { helped: 0.08, outcome: "harmful" }, expectedAction: "harmful", risk: "false-positive" },
    ];
    const replay = runJevReplay(fixtures, fixture => ({
      action: decideAdaptationOutcome(result(fixture.input.helped, fixture.input.outcome, fixture.input.confidence)).action,
    }));
    expect(replay.correct).toBe(replay.total);
  });
});
