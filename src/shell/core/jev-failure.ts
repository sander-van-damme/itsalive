import { classifyNoulBand, type JevNoulBandPolicy } from "./jev-eval";
import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_FAILURE_QUESTION_SET_VERSION = "failure-route-v1";

export const JEV_FAILURE_QUESTIONS: JevQuestions = {
  repair_likely_useful: {
    type: "noul",
    instructions: "Given this bounded coding failure, is another autonomous coding attempt likely to make useful progress rather than repeat the same failure?",
    criteria: {
      true: "A focused repair or retry has a plausible path to progress from the supplied evidence.",
      false: "Another autonomous coding turn is unlikely to help without different external conditions or user intent.",
    },
  },
  failure_class: {
    type: "choice",
    instructions: "Classify the primary reason this coding step failed. Choose the narrowest class supported by the evidence.",
    criteria: {
      generated_code: "Generated implementation/code is invalid or incorrect and can plausibly be repaired.",
      missing_context: "Relevant technical context, dependency, scope, or evidence is missing.",
      environment: "The runtime/platform/environment is the primary source of failure.",
      user_clarification: "Progress depends on a behavior choice only the user can clarify.",
      transient: "The failure appears temporary and retryable.",
      resolved: "The previous failure no longer blocks progress.",
    },
  },
};

export interface JevFailurePolicy {
  repair: JevNoulBandPolicy;
  minimumClassConfidence: number;
}

export const DEFAULT_JEV_FAILURE_POLICY: JevFailurePolicy = Object.freeze({
  repair: { lowMax: 0.25, highMin: 0.75 },
  minimumClassConfidence: 0.65,
});

export type JevFailureAction = "repair" | "retry" | "clarify" | "stop" | "uncertain";

export interface JevFailureDecision {
  action: JevFailureAction;
  reason: string;
  failureClass: string;
  classConfidence: number;
  repairBand: ReturnType<typeof classifyNoulBand>;
}

export function decideJevFailure(
  result: Pick<JevDecisionResult, "answers">,
  policy: JevFailurePolicy = DEFAULT_JEV_FAILURE_POLICY,
): JevFailureDecision {
  const useful = result.answers.repair_likely_useful;
  const failureClass = result.answers.failure_class;
  if (useful?.type !== "noul" || failureClass?.type !== "choice") {
    throw new Error("Jev failure response omitted required Noul/Choice answers");
  }
  if (!Number.isFinite(policy.minimumClassConfidence) || policy.minimumClassConfidence < 0 || policy.minimumClassConfidence > 1) {
    throw new Error("Jev failure class confidence threshold must be between 0 and 1");
  }
  const repairBand = classifyNoulBand(useful.noul, policy.repair);
  const base = { failureClass: failureClass.choice, classConfidence: failureClass.confidence, repairBand };

  if (failureClass.confidence < policy.minimumClassConfidence) {
    return { action: "uncertain", reason: "failure-class-uncertain", ...base };
  }
  if (failureClass.choice === "user_clarification") {
    return { action: "clarify", reason: "user-clarification-needed", ...base };
  }
  if (failureClass.choice === "environment") {
    return { action: "stop", reason: "environment-or-platform-failure", ...base };
  }
  if (failureClass.choice === "transient" || failureClass.choice === "resolved") {
    return { action: "retry", reason: failureClass.choice === "transient" ? "transient-retry" : "failure-appears-resolved", ...base };
  }
  if (repairBand === "high") {
    return { action: "repair", reason: failureClass.choice === "missing_context" ? "repair-with-missing-context-warning" : "focused-code-repair", ...base };
  }
  if (repairBand === "low") {
    return { action: "stop", reason: "another-repair-unlikely-to-help", ...base };
  }
  return { action: "uncertain", reason: "repair-usefulness-uncertain", ...base };
}
