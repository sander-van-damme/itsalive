import type { ApplicationAiDecisionRequest, ApplicationAiDecisionResult } from "../../shared";
import type { JevDecisionResult, JevQuestions } from "./jev";

export const APPLICATION_AI_CONFIDENCE_THRESHOLD = 0.8;
export const APPLICATION_AI_DECIDE_TRUE_THRESHOLD = 0.8;
export const APPLICATION_AI_DECIDE_FALSE_THRESHOLD = 0.2;
export const APPLICATION_AI_QUESTION_ID = "result";

export interface ApplicationAiJevRequest {
  state: unknown;
  questions: JevQuestions;
}

export function applicationAiJevRequest(decision: ApplicationAiDecisionRequest): ApplicationAiJevRequest {
  const state = decision.contextJson === undefined ? {} : JSON.parse(decision.contextJson) as unknown;

  if (decision.kind === "choose") {
    return {
      state,
      questions: {
        [APPLICATION_AI_QUESTION_ID]: {
          type: "choice",
          instructions: decision.question,
          criteria: decision.options,
        },
      },
    };
  }

  if (decision.kind === "score") {
    return {
      state,
      questions: {
        [APPLICATION_AI_QUESTION_ID]: {
          type: "score",
          instructions: decision.question,
          criteria: decision.levels,
        },
      },
    };
  }

  return {
    state,
    questions: {
      [APPLICATION_AI_QUESTION_ID]: {
        type: "noul",
        instructions: decision.question,
      },
    },
  };
}

export function resolveApplicationAiDecision(
  decision: ApplicationAiDecisionRequest,
  result: Pick<JevDecisionResult, "answers">,
): ApplicationAiDecisionResult {
  const answer = result.answers[APPLICATION_AI_QUESTION_ID];

  if (decision.kind === "choose") {
    if (answer?.type !== "choice") throw new Error("Jev application AI response omitted the Choice answer");
    return answer.confidence >= APPLICATION_AI_CONFIDENCE_THRESHOLD ? answer.choice : null;
  }

  if (decision.kind === "score") {
    if (answer?.type !== "score") throw new Error("Jev application AI response omitted the Score answer");
    return answer.confidence >= APPLICATION_AI_CONFIDENCE_THRESHOLD ? answer.score : null;
  }

  if (answer?.type !== "noul") throw new Error("Jev application AI response omitted the Noul answer");
  if (decision.kind === "probability") return answer.noul;
  if (answer.noul >= APPLICATION_AI_DECIDE_TRUE_THRESHOLD) return true;
  if (answer.noul <= APPLICATION_AI_DECIDE_FALSE_THRESHOLD) return false;
  return null;
}
