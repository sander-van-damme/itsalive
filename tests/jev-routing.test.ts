import { describe, expect, it } from "vitest";
import {
  decideTriggerRouting,
  JEV_TRIGGER_ROUTING_QUESTION_SET_VERSION,
  routeAgreesWithIntent,
  routingMisrouteClass,
  shouldSkipRuntimeWake,
  type CodingProfileRoute,
  type TriggerRoute,
} from "../src/shell/core/jev-routing";
import { runJevReplay, type JevReplayFixture } from "../src/shell/core/jev-eval";
import type { JevDecisionResult } from "../src/shell/core/jev";

function result(
  route: TriggerRoute,
  routeConfidence: number,
  profile: CodingProfileRoute,
  profileConfidence: number,
): JevDecisionResult {
  return {
    probability: 0,
    answers: {
      trigger_route: {
        type: "choice",
        choice: route,
        probabilities: { [route]: routeConfidence },
        confidence: routeConfidence,
      },
      coding_profile: {
        type: "choice",
        choice: profile,
        probabilities: { [profile]: profileConfidence },
        confidence: profileConfidence,
      },
    },
    diagnostics: { elapsedMs: 1 },
  };
}

describe("JEV trigger routing", () => {
  it("selects an existing repair profile only when route and profile are confident", () => {
    expect(decideTriggerRouting(result("debug", 0.93, "repair", 0.91))).toMatchObject({
      route: "debug",
      confident: true,
      preferredWorkerProfile: "repair-worker",
    });
    expect(decideTriggerRouting(result("debug", 0.6, "repair", 0.91))).toMatchObject({
      route: "debug",
      confident: false,
    });
    expect(decideTriggerRouting(result("modify", 0.92, "implementation", 0.88))).toMatchObject({
      preferredWorkerProfile: "component-worker",
    });
  });

  it("skips a runtime wake only for a very high-confidence no-action route", () => {
    expect(shouldSkipRuntimeWake(decideTriggerRouting(result("no_action", 0.95, "none", 0.94)))).toBe(true);
    expect(shouldSkipRuntimeWake(decideTriggerRouting(result("no_action", 0.82, "none", 0.94)))).toBe(false);
    expect(shouldSkipRuntimeWake(decideTriggerRouting(result("debug", 0.98, "repair", 0.98)))).toBe(false);
  });

  it("measures user-input routing against the stronger intent baseline", () => {
    expect(routeAgreesWithIntent("debug", { kind: "change", shouldCode: true })).toBe(true);
    expect(routingMisrouteClass("context", { kind: "change", shouldCode: true })).toBe("missed-change");
    expect(routingMisrouteClass("modify", { kind: "explanation", shouldCode: false })).toBe("false-change");
    expect(routingMisrouteClass("context", { kind: "explanation", shouldCode: false })).toBe("agreement");
  });

  it("replays representative routes using the same labelled cases as the intent baseline", () => {
    type Input = {
      route: TriggerRoute;
      routeConfidence: number;
      profile: CodingProfileRoute;
      profileConfidence: number;
      baseline: { kind: string; shouldCode: boolean };
    };
    const fixtures: JevReplayFixture<Input, TriggerRoute>[] = [
      {
        id: "explicit-change",
        description: "Explicit feature request remains a change candidate.",
        decisionKind: "trigger-routing",
        questionSetVersion: JEV_TRIGGER_ROUTING_QUESTION_SET_VERSION,
        input: { route: "modify", routeConfidence: 0.95, profile: "implementation", profileConfidence: 0.9, baseline: { kind: "change", shouldCode: true } },
        expectedAction: "modify",
        risk: "false-negative",
      },
      {
        id: "broken-control",
        description: "Broken existing behavior selects repair.",
        decisionKind: "trigger-routing",
        questionSetVersion: JEV_TRIGGER_ROUTING_QUESTION_SET_VERSION,
        input: { route: "debug", routeConfidence: 0.92, profile: "repair", profileConfidence: 0.9, baseline: { kind: "change", shouldCode: true } },
        expectedAction: "debug",
        risk: "false-negative",
      },
      {
        id: "interaction-explanation",
        description: "Explanation remains context rather than mutation permission.",
        decisionKind: "trigger-routing",
        questionSetVersion: JEV_TRIGGER_ROUTING_QUESTION_SET_VERSION,
        input: { route: "context", routeConfidence: 0.94, profile: "none", profileConfidence: 0.95, baseline: { kind: "explanation", shouldCode: false } },
        expectedAction: "context",
        risk: "false-positive",
      },
      {
        id: "user-question",
        description: "Question routes to answer rather than coding.",
        decisionKind: "trigger-routing",
        questionSetVersion: JEV_TRIGGER_ROUTING_QUESTION_SET_VERSION,
        input: { route: "answer", routeConfidence: 0.89, profile: "none", profileConfidence: 0.91, baseline: { kind: "question", shouldCode: false } },
        expectedAction: "answer",
        risk: "false-positive",
      },
    ];

    const replay = runJevReplay(fixtures, fixture => ({
      action: decideTriggerRouting(result(
        fixture.input.route,
        fixture.input.routeConfidence,
        fixture.input.profile,
        fixture.input.profileConfidence,
      )).route,
    }));
    expect(replay.correct).toBe(replay.total);
    for (const fixture of fixtures) {
      expect(routingMisrouteClass(fixture.expectedAction, fixture.input.baseline)).toBe("agreement");
    }
  });

  it("rejects malformed route answers", () => {
    expect(() => decideTriggerRouting({
      answers: { trigger_route: { type: "choice", choice: "debug", probabilities: { debug: 1 }, confidence: 1 } },
    })).toThrow(/required Choice/);
  });
});
