import type { AppDocumentSnapshot, InteractionPattern, InteractionSnapshot } from "../../shared";
import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_ADAPTATION_OUTCOME_QUESTION_SET_VERSION = "adaptation-outcome-v1";
export const MAX_ADAPTATION_EVIDENCE = 5;
export const MAX_ADAPTATIONS_PER_APP = 12;

export type AdaptationStatus =
  | "applying"
  | "observing"
  | "kept"
  | "neutral"
  | "failed"
  | "reverted"
  | "aborted";

export type AdaptationOutcome = "successful" | "neutral" | "rejected" | "harmful" | "uncertain";

export interface AdaptationRecord {
  id: string;
  appId: string;
  confirmationId: string;
  hypothesisKey: string;
  hypothesis: string;
  intendedOutcome: string;
  createdAt: number;
  updatedAt: number;
  status: AdaptationStatus;
  rollbackDocument?: AppDocumentSnapshot;
  appliedAt?: number;
  evidenceCount: number;
  lastEvidenceAt?: number;
  outcome?: AdaptationOutcome;
  helpedProbability?: number;
  outcomeConfidence?: number;
  suppressed: boolean;
}

export interface AdaptationAssessmentContext {
  id: string;
  hypothesis: string;
  intendedOutcome: string;
  appliedAt: number;
  evidenceCount: number;
  successSignals: string[];
  currentInteraction: {
    type: string;
    targetTag: string;
    targetId?: string;
  };
  pattern?: Pick<InteractionPattern, "actionCount" | "documentChangeCount" | "frustrationSignal" | "likelyBenign">;
}

export interface AdaptationOutcomeDecision {
  outcome: AdaptationOutcome;
  action: "keep" | "observe" | "suppress";
  reason: string;
  helpedProbability: number;
  confidence: number;
}

export const JEV_ADAPTATION_OUTCOME_QUESTIONS: JevQuestions = {
  adaptation_helped: {
    type: "noul",
    instructions: "Given the compact adaptation hypothesis, intended outcome, app success signals, and current post-change interaction evidence, is there evidence that this adaptation improved the intended user outcome?",
    criteria: {
      true: "The intended outcome is now succeeding or friction related to the hypothesis is clearly reduced.",
      false: "The intended outcome is still failing, the user appears to reject/undo the change, or new related friction appeared.",
    },
  },
  adaptation_outcome: {
    type: "choice",
    instructions: "Classify the strongest supported outcome of the adaptation from the current post-change evidence. Continued use by itself is weak evidence and should usually remain neutral/uncertain.",
    criteria: {
      successful: "The intended outcome is visibly succeeding and evidence supports keeping the change.",
      neutral: "There is usable post-change evidence but no strong proof of benefit or harm yet.",
      rejected: "The user behavior indicates rejection, reversal, or continued failure of the same intended outcome.",
      harmful: "The adaptation introduced clear new friction or broke an important outcome/invariant.",
      uncertain: "The evidence is too weak or ambiguous to classify safely.",
    },
  },
};

export function createAdaptationRecord(input: {
  id: string;
  appId: string;
  confirmationId: string;
  hypothesisKey: string;
  hypothesis: string;
  intendedOutcome: string;
  rollbackDocument?: AppDocumentSnapshot;
  now?: number;
}): AdaptationRecord {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    appId: input.appId,
    confirmationId: input.confirmationId,
    hypothesisKey: input.hypothesisKey,
    hypothesis: input.hypothesis.replace(/\s+/g, " ").trim().slice(0, 2_000),
    intendedOutcome: input.intendedOutcome.replace(/\s+/g, " ").trim().slice(0, 2_000),
    createdAt: now,
    updatedAt: now,
    status: "applying",
    ...(input.rollbackDocument ? { rollbackDocument: structuredClone(input.rollbackDocument) } : {}),
    evidenceCount: 0,
    suppressed: false,
  };
}

export function markAdaptationApplied(record: AdaptationRecord, now = Date.now()): AdaptationRecord {
  return { ...record, status: "observing", appliedAt: now, updatedAt: now };
}

export function markAdaptationAborted(record: AdaptationRecord, now = Date.now()): AdaptationRecord {
  return { ...record, status: "aborted", suppressed: true, updatedAt: now };
}

export function adaptationAssessmentContext(
  record: AdaptationRecord,
  interaction: InteractionSnapshot,
  pattern: InteractionPattern | undefined,
  successSignals: readonly string[] = [],
): AdaptationAssessmentContext | undefined {
  if (record.status !== "observing" || record.appliedAt == null) return undefined;
  return {
    id: record.id,
    hypothesis: record.hypothesis,
    intendedOutcome: record.intendedOutcome,
    appliedAt: record.appliedAt,
    evidenceCount: record.evidenceCount,
    successSignals: successSignals.slice(0, 6),
    currentInteraction: {
      type: interaction.type,
      targetTag: interaction.actualTarget.tag,
      ...(interaction.actualTarget.id ? { targetId: interaction.actualTarget.id } : {}),
    },
    ...(pattern ? {
      pattern: {
        actionCount: pattern.actionCount,
        documentChangeCount: pattern.documentChangeCount,
        frustrationSignal: pattern.frustrationSignal,
        likelyBenign: pattern.likelyBenign,
      },
    } : {}),
  };
}

export function decideAdaptationOutcome(
  result: Pick<JevDecisionResult, "answers">,
  evidenceCount: number,
): AdaptationOutcomeDecision {
  const helped = result.answers.adaptation_helped;
  const outcome = result.answers.adaptation_outcome;
  if (helped?.type !== "noul" || outcome?.type !== "choice") {
    throw new Error("Jev adaptation outcome response omitted required answers");
  }
  const confidence = outcome.confidence;
  const nextCount = evidenceCount + 1;
  if (confidence >= 0.7 && (outcome.choice === "rejected" || outcome.choice === "harmful")) {
    return {
      outcome: outcome.choice,
      action: "suppress",
      reason: outcome.choice === "harmful" ? "adaptation-caused-harm" : "adaptation-rejected",
      helpedProbability: helped.noul,
      confidence,
    };
  }
  if (confidence >= 0.7 && outcome.choice === "successful" && helped.noul >= 0.7) {
    return {
      outcome: "successful",
      action: "keep",
      reason: "intended-outcome-improved",
      helpedProbability: helped.noul,
      confidence,
    };
  }
  if (confidence >= 0.7 && outcome.choice === "neutral" && nextCount >= 3) {
    return {
      outcome: "neutral",
      action: "keep",
      reason: "bounded-neutral-observation-window-complete",
      helpedProbability: helped.noul,
      confidence,
    };
  }
  if (nextCount >= MAX_ADAPTATION_EVIDENCE) {
    return {
      outcome: "uncertain",
      action: "keep",
      reason: "bounded-uncertain-observation-window-complete",
      helpedProbability: helped.noul,
      confidence,
    };
  }
  return {
    outcome: outcome.choice === "successful" || outcome.choice === "neutral"
      || outcome.choice === "rejected" || outcome.choice === "harmful"
      ? outcome.choice
      : "uncertain",
    action: "observe",
    reason: "more-post-change-evidence-needed",
    helpedProbability: helped.noul,
    confidence,
  };
}

export function applyAdaptationOutcome(
  record: AdaptationRecord,
  decision: AdaptationOutcomeDecision,
  now = Date.now(),
): AdaptationRecord {
  const evidenceCount = record.evidenceCount + 1;
  const common = {
    ...record,
    evidenceCount,
    lastEvidenceAt: now,
    updatedAt: now,
    outcome: decision.outcome,
    helpedProbability: decision.helpedProbability,
    outcomeConfidence: decision.confidence,
  };
  if (decision.action === "suppress") return { ...common, status: "failed", suppressed: true };
  if (decision.action === "keep") {
    return {
      ...common,
      status: decision.outcome === "neutral" || decision.outcome === "uncertain" ? "neutral" : "kept",
      suppressed: false,
    };
  }
  return { ...common, status: "observing" };
}

export function markAdaptationReverted(record: AdaptationRecord, now = Date.now()): AdaptationRecord {
  return {
    ...record,
    status: "reverted",
    outcome: "rejected",
    suppressed: true,
    updatedAt: now,
    lastEvidenceAt: now,
  };
}

export function hypothesisSuppressed(
  records: readonly AdaptationRecord[],
  key: string,
): boolean {
  return records.some(record =>
    record.hypothesisKey === key
    && record.suppressed
    && (record.status === "failed" || record.status === "reverted" || record.status === "aborted")
  );
}

export function adaptationRetentionPlan(
  records: readonly AdaptationRecord[],
  maxCount = MAX_ADAPTATIONS_PER_APP,
): { keep: AdaptationRecord[]; deleteIds: string[] } {
  const keep = [...records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, maxCount));
  const ids = new Set(keep.map(item => item.id));
  return { keep, deleteIds: records.filter(item => !ids.has(item.id)).map(item => item.id) };
}

export function latestReversibleAdaptation(records: readonly AdaptationRecord[]): AdaptationRecord | undefined {
  return [...records]
    .filter(record => Boolean(record.rollbackDocument) && record.status !== "reverted" && record.status !== "aborted")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
