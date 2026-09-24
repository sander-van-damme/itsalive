import { describe, expect, it } from "vitest";
import { decideJevFailure, JEV_FAILURE_QUESTION_SET_VERSION } from "../src/shell/core/jev-failure";
import { runJevReplay, type JevReplayFixture } from "../src/shell/core/jev-eval";
import type { JevDecisionResult } from "../src/shell/core/jev";

type FailureClass = "generated_code" | "missing_context" | "environment" | "user_clarification" | "transient" | "resolved";

function result(repair: number, failureClass: FailureClass, confidence = 0.9): JevDecisionResult {
  const probabilities: Record<string, number> = { [failureClass]: confidence };
  const remainder = Math.max(0, 1 - confidence);
  if (remainder) probabilities.generated_code = failureClass === "generated_code" ? confidence : remainder;
  return {
    probability: repair,
    answers: {
      repair_likely_useful: { type: "noul", noul: repair },
      failure_class: { type: "choice", choice: failureClass, probabilities, confidence },
    },
    diagnostics: { elapsedMs: 1 },
  };
}

describe("Jev failure routing policy", () => {
  it("routes generated-code and missing-context failures to repair when useful", () => {
    expect(decideJevFailure(result(0.9, "generated_code"))).toMatchObject({ action: "repair", failureClass: "generated_code" });
    expect(decideJevFailure(result(0.85, "missing_context"))).toMatchObject({ action: "repair", failureClass: "missing_context" });
  });

  it("routes transient, environment, and user-clarification failures distinctly", () => {
    expect(decideJevFailure(result(0.5, "transient"))).toMatchObject({ action: "retry" });
    expect(decideJevFailure(result(0.1, "environment"))).toMatchObject({ action: "stop", reason: "environment-or-platform-failure" });
    expect(decideJevFailure(result(0.2, "user_clarification"))).toMatchObject({ action: "clarify" });
  });

  it("uses uncertainty rather than an aggressive route when class confidence is low", () => {
    expect(decideJevFailure(result(0.9, "generated_code", 0.5))).toMatchObject({ action: "uncertain" });
  });

  it("replays the main failure classes", () => {
    type Input = { repair: number; failureClass: FailureClass; confidence?: number };
    type Action = "repair" | "retry" | "clarify" | "stop" | "uncertain";
    const fixtures: JevReplayFixture<Input, Action>[] = [
      { id: "repair-code", description: "repairable code", decisionKind: "failure-route", questionSetVersion: JEV_FAILURE_QUESTION_SET_VERSION, input: { repair: 0.9, failureClass: "generated_code" }, expectedAction: "repair", risk: "false-negative" },
      { id: "missing-context", description: "missing technical context", decisionKind: "failure-route", questionSetVersion: JEV_FAILURE_QUESTION_SET_VERSION, input: { repair: 0.85, failureClass: "missing_context" }, expectedAction: "repair", risk: "false-negative" },
      { id: "transient", description: "retryable transient failure", decisionKind: "failure-route", questionSetVersion: JEV_FAILURE_QUESTION_SET_VERSION, input: { repair: 0.4, failureClass: "transient" }, expectedAction: "retry", risk: "balanced" },
      { id: "environment", description: "platform failure", decisionKind: "failure-route", questionSetVersion: JEV_FAILURE_QUESTION_SET_VERSION, input: { repair: 0.1, failureClass: "environment" }, expectedAction: "stop", risk: "false-positive" },
      { id: "clarify", description: "user intent required", decisionKind: "failure-route", questionSetVersion: JEV_FAILURE_QUESTION_SET_VERSION, input: { repair: 0.2, failureClass: "user_clarification" }, expectedAction: "clarify", risk: "false-positive" },
    ];
    const report = runJevReplay(fixtures, fixture => ({
      action: decideJevFailure(result(fixture.input.repair, fixture.input.failureClass, fixture.input.confidence)).action,
    }));
    expect(report.correct).toBe(report.total);
  });

  it("rejects malformed answer sets", () => {
    expect(() => decideJevFailure({ answers: { repair_likely_useful: { type: "noul", noul: 0.9 } } })).toThrow(/required Noul\/Choice/);
  });
});
