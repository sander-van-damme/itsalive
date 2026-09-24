import type { AppDocumentSnapshot, InteractionPattern } from "../../shared";
import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION = "adaptation-outcome-v1";
export const MAX_ADAPTATION_HISTORY = 8;
export const MAX_ADAPTATION_ASSESSMENTS = 3;
export const ADAPTATION_SUPPRESSION_FAILURES = 2;
export const ADAPTATION_SUPPRESSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export type AdaptationOutcome = "successful" | "neutral" | "rejected" | "harmful" | "failed" | "reverted";
export type AdaptationAssessmentAction = "successful" | "neutral" | "rejected" | "harmful" | "uncertain";

export interface AdaptationAssessment {
  action: AdaptationAssessmentAction;
  reason: string;
  helpedProbability: number;
  classificationConfidence: number;
}

export interface ActiveAdaptation {
  id: string;
  source: "interaction";
  createdAt: number;
  appliedAt?: number;
  fingerprint: string;
  hypothesis: string;
  intendedOutcome: string;
  beforeDocument: AppDocumentSnapshot;
  status: "pending" | "applied";
  assessmentCount: number;
  lastAssessment?: AdaptationAssessment;
}

export interface AdaptationHistoryEntry {
  id: string;
  createdAt: number;
  completedAt: number;
  fingerprint: string;
  hypothesis: string;
  intendedOutcome: string;
  outcome: AdaptationOutcome;
  reason: string;
  assessments: number;
}

export interface AdaptationOutcomeContext {
  adaptationId: string;
  hypothesis: string;
  intendedOutcome: string;
  ageMs: number;
  assessmentCount: number;
  successSignals: string[];
  frictionSignal: boolean;
  documentChangedDuringInteraction: boolean;
}

export const JEV_ADAPTATION_OUTCOME_QUESTIONS: JevQuestions = {
  adaptation_helped: {
    type: "noul",
    instructions: "Given the active interaction-driven adaptation and the new bounded interaction evidence, did the adaptation plausibly help the user reach its intended outcome?",
    criteria: {
      true: "The supplied evidence supports improvement toward the intended outcome, reduced friction, or a matching app-specific success signal.",
      false: "The evidence shows no improvement, continued/repeated failure, rejection, new friction, or harm.",
    },
  },
  adaptation_outcome: {
    type: "choice",
    instructions: "Classify the strongest supported outcome of the active adaptation from the supplied evidence.",
    criteria: {
      successful: "The intended outcome appears to be working and the new interaction evidence supports that the adaptation helped.",
      neutral: "The evidence is meaningful but does not show a clear benefit or harm.",
      rejected: "The user behavior indicates rejection, reversal, or immediate continued use of the old expected path.",
      harmful: "The adaptation appears to have introduced new friction, errors, loss of access, or a worse user-visible outcome.",
      uncertain: "The supplied evidence is too weak or ambiguous to judge.",
    },
  },
};

function compact(value: string, max = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

export function adaptationFingerprint(interactionKey: string, technicalGoal: string): string {
  return hash(interactionKey + "\u001f" + compact(technicalGoal, 1_000).toLowerCase());
}

export function createActiveAdaptation(input: {
  id: string;
  interactionKey: string;
  hypothesis: string;
  technicalGoal: string;
  intendedOutcome: string;
  beforeDocument: AppDocumentSnapshot;
  now?: number;
}): ActiveAdaptation {
  return {
    id: input.id,
    source: "interaction",
    createdAt: input.now ?? Date.now(),
    fingerprint: adaptationFingerprint(input.interactionKey, input.technicalGoal),
    hypothesis: compact(input.hypothesis, 1_000),
    intendedOutcome: compact(input.intendedOutcome, 1_500),
    beforeDocument: structuredClone(input.beforeDocument),
    status: "pending",
    assessmentCount: 0,
  };
}

export function markAdaptationApplied(adaptation: ActiveAdaptation, now = Date.now()): ActiveAdaptation {
  return {
    ...adaptation,
    status: "applied",
    appliedAt: now,
  };
}

export function adaptationOutcomeContext(
  adaptation: ActiveAdaptation,
  pattern: InteractionPattern | undefined,
  successSignals: readonly string[] = [],
  now = Date.now(),
): AdaptationOutcomeContext {
  return {
    adaptationId: adaptation.id,
    hypothesis: compact(adaptation.hypothesis),
    intendedOutcome: compact(adaptation.intendedOutcome),
    ageMs: Math.max(0, now - (adaptation.appliedAt ?? adaptation.createdAt)),
    assessmentCount: adaptation.assessmentCount,
    successSignals: successSignals.map(item => compact(item, 240)).filter(Boolean).slice(0, 6),
    frictionSignal: Boolean(pattern?.frustrationSignal),
    documentChangedDuringInteraction: Boolean(pattern && pattern.documentChangeCount > 0),
  };
}

export function decideAdaptationOutcome(
  result: Pick<JevDecisionResult, "answers">,
  minimumClassificationConfidence = 0.65,
  successThreshold = 0.7,
): AdaptationAssessment {
  const helped = result.answers.adaptation_helped;
  const outcome = result.answers.adaptation_outcome;
  if (helped?.type !== "noul" || outcome?.type !== "choice") {
    throw new Error("Jev adaptation outcome response omitted required answers");
  }

  const helpedProbability = helped.noul;
  const classificationConfidence = outcome.confidence;
  if (classificationConfidence < minimumClassificationConfidence || outcome.choice === "uncertain") {
    return { action: "uncertain", reason: "outcome-uncertain", helpedProbability, classificationConfidence };
  }
  if (outcome.choice === "harmful") {
    return { action: "harmful", reason: "harmful-outcome-evidence", helpedProbability, classificationConfidence };
  }
  if (outcome.choice === "rejected") {
    return { action: "rejected", reason: "rejection-evidence", helpedProbability, classificationConfidence };
  }
  if (outcome.choice === "successful" && helpedProbability >= successThreshold) {
    return { action: "successful", reason: "success-evidence", helpedProbability, classificationConfidence };
  }
  if (outcome.choice === "neutral") {
    return { action: "neutral", reason: "neutral-outcome-evidence", helpedProbability, classificationConfidence };
  }
  return { action: "uncertain", reason: "success-not-supported", helpedProbability, classificationConfidence };
}

export function recordAdaptationAssessment(
  adaptation: ActiveAdaptation,
  assessment: AdaptationAssessment,
): ActiveAdaptation {
  return {
    ...adaptation,
    assessmentCount: adaptation.assessmentCount + 1,
    lastAssessment: { ...assessment },
  };
}

export function finalizeAdaptation(
  adaptation: ActiveAdaptation,
  outcome: AdaptationOutcome,
  reason: string,
  now = Date.now(),
): AdaptationHistoryEntry {
  return {
    id: adaptation.id,
    createdAt: adaptation.createdAt,
    completedAt: now,
    fingerprint: adaptation.fingerprint,
    hypothesis: adaptation.hypothesis,
    intendedOutcome: adaptation.intendedOutcome,
    outcome,
    reason: compact(reason, 500),
    assessments: adaptation.assessmentCount,
  };
}

export function appendAdaptationHistory(
  history: readonly AdaptationHistoryEntry[] | undefined,
  entry: AdaptationHistoryEntry,
  max = MAX_ADAPTATION_HISTORY,
): AdaptationHistoryEntry[] {
  return [entry, ...(history ?? []).filter(item => item.id !== entry.id)]
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, Math.max(0, max));
}

export function shouldSuppressAdaptation(
  history: readonly AdaptationHistoryEntry[] | undefined,
  fingerprint: string,
  now = Date.now(),
): boolean {
  const failed = (history ?? []).filter(item =>
    item.fingerprint === fingerprint
    && now - item.completedAt <= ADAPTATION_SUPPRESSION_WINDOW_MS
    && ["rejected", "harmful", "failed", "reverted"].includes(item.outcome)
  );
  return failed.length >= ADAPTATION_SUPPRESSION_FAILURES;
}
