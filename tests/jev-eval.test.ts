import { describe, expect, it } from "vitest";
import {
  classifyNoulBand,
  compactJevDecisionTelemetry,
  runJevReplay,
  type JevReplayFixture,
} from "../src/shell/core/jev-eval";
import {
  JEV_INTERACTION_QUESTION_SET_VERSION,
  decideJevEscalation,
  type JevDecisionResult,
} from "../src/shell/core/jev";
import type { JevState } from "../src/shared";
import { SANITIZED_JEV_REPLAY_FIXTURES } from "./fixtures/jev-replay";

function interactionState(likelyBenign: boolean, frustrationSignal: boolean): JevState {
  return {
    interaction: { seq: 1, at: "2026-01-01T00:00:00Z", type: "click", target: { tag: "button" }, actualTarget: { tag: "button" } },
    recentInteractions: [],
    pattern: {
      kind: "repeated-action",
      actionCount: frustrationSignal ? 5 : 1,
      coalescedCount: 0,
      durationMs: 300,
      averageIntervalMs: 100,
      documentChangeCount: likelyBenign ? 1 : 0,
      likelyBenign,
      frustrationSignal,
    },
    document: "<main><button>Go</button></main>",
  };
}

describe("Jev calibration bands", () => {
  it("classifies low, uncertain, and high bands using a decision-specific policy", () => {
    const policy = { lowMax: 0.2, highMin: 0.8 };
    expect(classifyNoulBand(0.2, policy)).toBe("low");
    expect(classifyNoulBand(0.5, policy)).toBe("uncertain");
    expect(classifyNoulBand(0.8, policy)).toBe("high");
  });

  it("rejects invalid band policies", () => {
    expect(() => classifyNoulBand(0.5, { lowMax: 0.8, highMin: 0.7 })).toThrow(/band policy/);
  });
});

describe("Jev deterministic replay harness", () => {
  it("captures both false-positive and false-negative product risks in the shared fixture catalogue", () => {
    const risks = new Set(SANITIZED_JEV_REPLAY_FIXTURES.map(item => item.risk));
    expect(risks).toEqual(new Set(["false-positive", "false-negative"]));
    expect(new Set(SANITIZED_JEV_REPLAY_FIXTURES.map(item => item.decisionKind))).toEqual(new Set([
      "interaction-wake",
      "agent-completion",
      "failure-route",
      "context-relevance",
    ]));
  });

  it("baselines the current interaction wake policy without changing it", () => {
    type Input = { probability: number; state: JevState };
    const fixtures: JevReplayFixture<Input, "no-op" | "escalate">[] = [
      {
        id: "ordinary",
        description: "ordinary changed interaction",
        decisionKind: "interaction-wake",
        questionSetVersion: JEV_INTERACTION_QUESTION_SET_VERSION,
        input: { probability: 0.08, state: interactionState(true, false) },
        expectedAction: "no-op",
        risk: "false-positive",
      },
      {
        id: "benign-repeat",
        description: "benign rapid repeat",
        decisionKind: "interaction-wake",
        questionSetVersion: JEV_INTERACTION_QUESTION_SET_VERSION,
        input: { probability: 0.22, state: interactionState(true, false) },
        expectedAction: "no-op",
        risk: "false-positive",
      },
      {
        id: "clear-friction",
        description: "clear repeated unchanged interaction",
        decisionKind: "interaction-wake",
        questionSetVersion: JEV_INTERACTION_QUESTION_SET_VERSION,
        input: { probability: 0.82, state: interactionState(false, true) },
        expectedAction: "escalate",
        risk: "false-negative",
      },
      {
        id: "sequence-signal",
        description: "locally detected frustration signal below global threshold",
        decisionKind: "interaction-wake",
        questionSetVersion: JEV_INTERACTION_QUESTION_SET_VERSION,
        input: { probability: 0.2, state: interactionState(false, true) },
        expectedAction: "escalate",
        risk: "false-negative",
      },
    ];
    const report = runJevReplay(fixtures, fixture => ({
      action: decideJevEscalation(fixture.input.probability, fixture.input.state).escalated ? "escalate" : "no-op",
    }));
    expect(report.correct).toBe(report.total);
    expect(report.mismatchesByRisk).toEqual({ "false-positive": 0, "false-negative": 0, balanced: 0 });
  });
});

describe("Jev decision telemetry", () => {
  it("records versioned decision metadata and action without copying decision state", () => {
    const result: JevDecisionResult = {
      probability: 0.84,
      answers: { requires_llm_attention: { type: "noul", noul: 0.84 } },
      diagnostics: { requestId: "dec-1", provider: "TypeSafe", model: "typesafe/jev-example", elapsedMs: 11 },
      usage: { inputTokens: 55, outputTokens: 2, cost: 0.00000231 },
    };
    const telemetry = compactJevDecisionTelemetry({
      correlationId: "bridge-1",
      decisionKind: "interaction-wake",
      questionSetVersion: JEV_INTERACTION_QUESTION_SET_VERSION,
      result,
      policy: { highMin: 0.7 },
      action: "escalate-to-confirmation",
    });
    expect(telemetry).toMatchObject({
      correlationId: "bridge-1",
      decisionKind: "interaction-wake",
      questionSetVersion: JEV_INTERACTION_QUESTION_SET_VERSION,
      action: "escalate-to-confirmation",
      requestId: "dec-1",
      model: "typesafe/jev-example",
      answers: { requires_llm_attention: { type: "noul", noul: 0.84 } },
    });
    expect(JSON.stringify(telemetry)).not.toContain("semantic document");
    expect(JSON.stringify(telemetry)).not.toContain("<main");
  });
});
