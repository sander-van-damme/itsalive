import { describe, expect, it } from "vitest";
import { decideJevCompletion, JEV_COMPLETION_QUESTION_SET_VERSION } from "../src/shell/core/jev-completion";
import { runJevReplay, type JevReplayFixture } from "../src/shell/core/jev-eval";
import type { JevDecisionResult } from "../src/shell/core/jev";

function result(outcome: number, failure: number): JevDecisionResult {
  return {
    probability: 0,
    answers: {
      requested_outcome_present: { type: "noul", noul: outcome },
      obvious_failure_remaining: { type: "noul", noul: failure },
    },
    diagnostics: { elapsedMs: 1 },
  };
}

describe("Jev completion policy", () => {
  it("finishes only when outcome evidence is high and failure evidence is low", () => {
    expect(decideJevCompletion(result(0.9, 0.05))).toMatchObject({ action: "finish" });
    expect(decideJevCompletion(result(0.1, 0.9))).toMatchObject({ action: "continue" });
    expect(decideJevCompletion(result(0.55, 0.2))).toMatchObject({ action: "uncertain" });
  });

  it("replays success, silent failure, partial success, and misleading-valid UI", () => {
    type Input = { outcome: number; failure: number };
    const fixtures: JevReplayFixture<Input, "finish" | "continue" | "uncertain">[] = [
      {
        id: "true-success",
        description: "requested observable outcome is present and no failure remains",
        decisionKind: "agent-completion",
        questionSetVersion: JEV_COMPLETION_QUESTION_SET_VERSION,
        input: { outcome: 0.92, failure: 0.04 },
        expectedAction: "finish",
        risk: "false-negative",
      },
      {
        id: "silent-failure",
        description: "agent says done but requested outcome is absent",
        decisionKind: "agent-completion",
        questionSetVersion: JEV_COMPLETION_QUESTION_SET_VERSION,
        input: { outcome: 0.08, failure: 0.88 },
        expectedAction: "continue",
        risk: "false-positive",
      },
      {
        id: "partial-success",
        description: "some evidence exists but not enough to claim completion",
        decisionKind: "agent-completion",
        questionSetVersion: JEV_COMPLETION_QUESTION_SET_VERSION,
        input: { outcome: 0.55, failure: 0.18 },
        expectedAction: "uncertain",
        risk: "balanced",
      },
      {
        id: "misleading-valid-dom",
        description: "DOM is structurally valid but does not support the requested behavior",
        decisionKind: "agent-completion",
        questionSetVersion: JEV_COMPLETION_QUESTION_SET_VERSION,
        input: { outcome: 0.18, failure: 0.79 },
        expectedAction: "continue",
        risk: "false-positive",
      },
    ];
    const report = runJevReplay(fixtures, fixture => ({
      action: decideJevCompletion(result(fixture.input.outcome, fixture.input.failure)).action,
    }));
    expect(report.correct).toBe(report.total);
  });

  it("rejects a completion response missing either required answer", () => {
    expect(() => decideJevCompletion({
      answers: { requested_outcome_present: { type: "noul", noul: 0.9 } },
    })).toThrow(/required Noul/);
  });
});
