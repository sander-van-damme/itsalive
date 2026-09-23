import { classifyNoulBand, type JevNoulBandPolicy } from "./jev-eval";
import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_COMPLETION_QUESTION_SET_VERSION = "completion-v1";

export const JEV_COMPLETION_QUESTIONS: JevQuestions = {
  requested_outcome_present: {
    type: "noul",
    instructions: "Given the requested technical outcome and bounded observable application evidence, does the current application state support that the requested outcome is actually present?",
    criteria: {
      true: "The observable evidence supports the requested outcome strongly enough to finish.",
      false: "The requested outcome is absent, contradicted, only partially present, or not supported by the evidence.",
    },
  },
  obvious_failure_remaining: {
    type: "noul",
    instructions: "Given the same bounded evidence, is there an obvious unresolved user-visible or runtime failure that makes finishing inappropriate?",
    criteria: {
      true: "There is observable evidence of an unresolved failure, incomplete result, or materially broken requested behavior.",
      false: "There is no obvious unresolved failure in the supplied evidence.",
    },
  },
};

export interface JevCompletionPolicy {
  outcome: JevNoulBandPolicy;
  failure: JevNoulBandPolicy;
}

export const DEFAULT_JEV_COMPLETION_POLICY: JevCompletionPolicy = Object.freeze({
  outcome: { lowMax: 0.25, highMin: 0.75 },
  failure: { lowMax: 0.25, highMin: 0.75 },
});

export type JevCompletionAction = "finish" | "continue" | "uncertain";

export interface JevCompletionDecision {
  action: JevCompletionAction;
  reason: string;
  bands: {
    outcome: ReturnType<typeof classifyNoulBand>;
    failure: ReturnType<typeof classifyNoulBand>;
  };
}

export function decideJevCompletion(
  result: Pick<JevDecisionResult, "answers">,
  policy: JevCompletionPolicy = DEFAULT_JEV_COMPLETION_POLICY,
): JevCompletionDecision {
  const outcome = result.answers.requested_outcome_present;
  const failure = result.answers.obvious_failure_remaining;
  if (outcome?.type !== "noul" || failure?.type !== "noul") {
    throw new Error("Jev completion response omitted required Noul answers");
  }

  const outcomeBand = classifyNoulBand(outcome.noul, policy.outcome);
  const failureBand = classifyNoulBand(failure.noul, policy.failure);
  const bands = { outcome: outcomeBand, failure: failureBand };

  if (outcomeBand === "high" && failureBand === "low") {
    return { action: "finish", reason: "observable-outcome-supported", bands };
  }
  if (outcomeBand === "low" || failureBand === "high") {
    return { action: "continue", reason: outcomeBand === "low" ? "requested-outcome-not-supported" : "obvious-failure-remains", bands };
  }
  return { action: "uncertain", reason: "completion-evidence-uncertain", bands };
}
