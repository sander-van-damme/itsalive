import type { JevAnswer, JevDecisionResult } from "./jev";

export type JevDecisionBand = "low" | "uncertain" | "high";

export interface JevNoulBandPolicy {
  /** Values at or below this threshold take the low-confidence branch. */
  lowMax: number;
  /** Values at or above this threshold take the high-confidence branch. */
  highMin: number;
}

export function classifyNoulBand(probability: number, policy: JevNoulBandPolicy): JevDecisionBand {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("Jev replay probability must be between 0 and 1");
  }
  if (!Number.isFinite(policy.lowMax) || !Number.isFinite(policy.highMin)
    || policy.lowMax < 0 || policy.highMin > 1 || policy.lowMax >= policy.highMin) {
    throw new Error("Jev band policy must satisfy 0 <= lowMax < highMin <= 1");
  }
  if (probability <= policy.lowMax) return "low";
  if (probability >= policy.highMin) return "high";
  return "uncertain";
}

export type JevReplayRisk = "false-positive" | "false-negative" | "balanced";

export interface JevReplayFixture<TInput = unknown, TAction extends string = string> {
  id: string;
  description: string;
  decisionKind: string;
  questionSetVersion: string;
  input: TInput;
  expectedAction: TAction;
  risk: JevReplayRisk;
}

export interface JevReplayPrediction<TAction extends string = string> {
  action: TAction;
  band?: JevDecisionBand;
}

export interface JevReplayCase<TAction extends string = string> {
  id: string;
  decisionKind: string;
  questionSetVersion: string;
  risk: JevReplayRisk;
  expectedAction: TAction;
  actualAction: TAction;
  correct: boolean;
  band?: JevDecisionBand;
}

export interface JevReplayReport<TAction extends string = string> {
  total: number;
  correct: number;
  cases: JevReplayCase<TAction>[];
  mismatchesByRisk: Record<JevReplayRisk, number>;
}

export function runJevReplay<TInput, TAction extends string>(
  fixtures: readonly JevReplayFixture<TInput, TAction>[],
  decide: (fixture: JevReplayFixture<TInput, TAction>) => JevReplayPrediction<TAction>,
): JevReplayReport<TAction> {
  const cases = fixtures.map((fixture): JevReplayCase<TAction> => {
    const prediction = decide(fixture);
    return {
      id: fixture.id,
      decisionKind: fixture.decisionKind,
      questionSetVersion: fixture.questionSetVersion,
      risk: fixture.risk,
      expectedAction: fixture.expectedAction,
      actualAction: prediction.action,
      correct: prediction.action === fixture.expectedAction,
      ...(prediction.band ? { band: prediction.band } : {}),
    };
  });
  const mismatchesByRisk: Record<JevReplayRisk, number> = {
    "false-positive": 0,
    "false-negative": 0,
    balanced: 0,
  };
  for (const item of cases) if (!item.correct) mismatchesByRisk[item.risk]++;
  return {
    total: cases.length,
    correct: cases.filter(item => item.correct).length,
    cases,
    mismatchesByRisk,
  };
}

function compactAnswer(answer: JevAnswer): JevAnswer {
  if (answer.type === "noul") return { type: "noul", noul: answer.noul };
  if (answer.type === "choice") {
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: { ...answer.probabilities },
      confidence: answer.confidence,
    };
  }
  return {
    type: "score",
    score: answer.score,
    legend: { ...answer.legend },
    probabilities: { ...answer.probabilities },
    confidence: answer.confidence,
  };
}

export interface JevDecisionTelemetryInput {
  correlationId?: string;
  decisionKind: string;
  questionSetVersion: string;
  result: JevDecisionResult;
  action: string;
  policy?: Record<string, unknown>;
  outcome?: string;
}

export function compactJevDecisionTelemetry(input: JevDecisionTelemetryInput): Record<string, unknown> {
  return {
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    decisionKind: input.decisionKind,
    questionSetVersion: input.questionSetVersion,
    action: input.action,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    requestId: input.result.diagnostics.requestId,
    provider: input.result.diagnostics.provider,
    model: input.result.diagnostics.model,
    latencyMs: input.result.diagnostics.elapsedMs,
    answers: Object.fromEntries(Object.entries(input.result.answers).map(([id, answer]) => [id, compactAnswer(answer)])),
    usage: input.result.usage ? { ...input.result.usage } : undefined,
  };
}
