import type { InteractionObservation, InteractionPattern, InteractionSnapshot } from "../../shared";
import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_BEHAVIOR_EPISODE_QUESTION_SET_VERSION = "behavior-episode-v1";
export const MAX_BEHAVIOR_EPISODES_PER_APP = 24;
export const MAX_BEHAVIOR_EPISODE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type BehaviorEvidenceKind =
  | "session-evidence"
  | "preference"
  | "unresolved-need"
  | "adaptation-outcome";

export interface BehaviorEpisodeCandidate {
  fingerprint: string;
  formedAt: number;
  interactionType: string;
  targetTag: string;
  targetHint?: string;
  actionCount: number;
  documentChangeCount: number;
  frustrationSignal: boolean;
  likelyBenign: boolean;
  signal: string;
}

export interface BehaviorEpisodeRecord {
  id: string;
  appId: string;
  createdAt: number;
  lastSeenAt: number;
  kind: BehaviorEvidenceKind;
  fingerprint: string;
  signal: string;
  interactionType: string;
  targetTag: string;
  actionCount: number;
  documentChangeCount: number;
  frustrationSignal: boolean;
  occurrences: number;
  retentionProbability: number;
  classificationConfidence: number;
}

export type BehaviorEpisodeLocalDecision =
  | { action: "drop"; reason: "ordinary-interaction" | "benign-repeat" | "successful-changing-repeat" | "insufficient-repeat-evidence" }
  | { action: "triage"; candidate: BehaviorEpisodeCandidate };

export interface BehaviorEpisodeTriageDecision {
  action: "retain" | "drop";
  reason: string;
  kind?: BehaviorEvidenceKind;
  retentionProbability: number;
  classificationConfidence: number;
}

export const JEV_BEHAVIOR_EPISODE_QUESTIONS: JevQuestions = {
  retain_behavior_episode: {
    type: "noul",
    instructions: "Does this compact interaction episode contain durable app-specific behavioral evidence worth retaining beyond the current session?",
    criteria: {
      true: "The episode supports a recurring preference, unresolved need, meaningful friction, adaptation outcome, or other evidence that may improve future app reasoning.",
      false: "The episode is routine use, incidental interaction noise, a successful repeatable action, or too weak/ambiguous to retain durably.",
    },
  },
  behavior_evidence_kind: {
    type: "choice",
    instructions: "Classify the strongest supported behavioral evidence category for this compact episode.",
    criteria: {
      session_evidence: "Useful evidence about the current interaction pattern, but not yet a stable preference or confirmed outcome.",
      preference: "Evidence of a recurring app-specific interaction or presentation preference.",
      unresolved_need: "Evidence that the user is repeatedly unable to reach an intended outcome or workflow.",
      adaptation_outcome: "Evidence about whether a prior adaptation or assistance helped, was rejected, or created new friction.",
      routine: "Ordinary usage that should not enter durable behavioral memory.",
    },
  },
};

function compactTargetHint(interaction: InteractionSnapshot): string | undefined {
  const target = interaction.actualTarget;
  const state = target.state ?? {};
  const value = [
    target.id,
    state.name,
    state["aria-label"],
    state.title,
    state.type,
  ].find(item => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) : undefined;
}

function fingerprint(interaction: InteractionSnapshot, hint: string | undefined): string {
  return [
    interaction.type,
    interaction.actualTarget.tag,
    interaction.actualTarget.id ?? "",
    hint ?? "",
  ].join("|").toLowerCase().slice(0, 320);
}

export function formBehaviorEpisode(
  observation: InteractionObservation,
  pattern: InteractionPattern | undefined,
  now = Date.now(),
): BehaviorEpisodeLocalDecision {
  if (!pattern) return { action: "drop", reason: "ordinary-interaction" };
  if (pattern.likelyBenign) {
    return {
      action: "drop",
      reason: pattern.documentChangeCount > 0 ? "successful-changing-repeat" : "benign-repeat",
    };
  }
  if (pattern.documentChangeCount > 0) return { action: "drop", reason: "successful-changing-repeat" };
  if (pattern.actionCount < 3) return { action: "drop", reason: "insufficient-repeat-evidence" };

  const hint = compactTargetHint(observation.interaction);
  const target = observation.interaction.actualTarget;
  const signal = [
    pattern.frustrationSignal ? "Repeated unchanged interaction with a frustration signal." : "Repeated unchanged interaction.",
    `type=${observation.interaction.type}`,
    `target=${target.tag}`,
    hint ? `hint=${hint}` : "",
    `actions=${pattern.actionCount}`,
    `documentChanges=${pattern.documentChangeCount}`,
  ].filter(Boolean).join(" ");

  return {
    action: "triage",
    candidate: {
      fingerprint: fingerprint(observation.interaction, hint),
      formedAt: now,
      interactionType: observation.interaction.type,
      targetTag: target.tag,
      ...(hint ? { targetHint: hint } : {}),
      actionCount: pattern.actionCount,
      documentChangeCount: pattern.documentChangeCount,
      frustrationSignal: Boolean(pattern.frustrationSignal),
      likelyBenign: Boolean(pattern.likelyBenign),
      signal,
    },
  };
}

export function decideBehaviorEpisodeRetention(
  result: Pick<JevDecisionResult, "answers">,
  minimumRetention = 0.7,
  minimumClassificationConfidence = 0.65,
): BehaviorEpisodeTriageDecision {
  const retain = result.answers.retain_behavior_episode;
  const kind = result.answers.behavior_evidence_kind;
  if (retain?.type !== "noul" || kind?.type !== "choice") {
    throw new Error("Jev behavioral episode response omitted required answers");
  }
  const retentionProbability = retain.noul;
  const classificationConfidence = kind.confidence;
  if (retentionProbability < minimumRetention) {
    return { action: "drop", reason: "retention-below-threshold", retentionProbability, classificationConfidence };
  }
  if (classificationConfidence < minimumClassificationConfidence) {
    return { action: "drop", reason: "classification-uncertain", retentionProbability, classificationConfidence };
  }
  if (kind.choice === "routine") {
    return { action: "drop", reason: "classified-routine", retentionProbability, classificationConfidence };
  }
  const normalizedKind = kind.choice === "preference"
    ? "preference"
    : kind.choice === "unresolved_need"
      ? "unresolved-need"
      : kind.choice === "adaptation_outcome"
        ? "adaptation-outcome"
        : "session-evidence";
  return {
    action: "retain",
    reason: "durable-evidence",
    kind: normalizedKind,
    retentionProbability,
    classificationConfidence,
  };
}

export function mergeBehaviorEpisode(
  appId: string,
  existing: readonly BehaviorEpisodeRecord[],
  candidate: BehaviorEpisodeCandidate,
  triage: BehaviorEpisodeTriageDecision,
  id: string,
  now = Date.now(),
): BehaviorEpisodeRecord | undefined {
  if (triage.action !== "retain" || !triage.kind) return undefined;
  const match = existing
    .filter(item => item.fingerprint === candidate.fingerprint && item.kind === triage.kind)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  if (match) {
    return {
      ...match,
      lastSeenAt: now,
      signal: candidate.signal,
      actionCount: Math.max(match.actionCount, candidate.actionCount),
      documentChangeCount: Math.max(match.documentChangeCount, candidate.documentChangeCount),
      frustrationSignal: match.frustrationSignal || candidate.frustrationSignal,
      occurrences: match.occurrences + 1,
      retentionProbability: Math.max(match.retentionProbability, triage.retentionProbability),
      classificationConfidence: Math.max(match.classificationConfidence, triage.classificationConfidence),
    };
  }
  return {
    id,
    appId,
    createdAt: now,
    lastSeenAt: now,
    kind: triage.kind,
    fingerprint: candidate.fingerprint,
    signal: candidate.signal,
    interactionType: candidate.interactionType,
    targetTag: candidate.targetTag,
    actionCount: candidate.actionCount,
    documentChangeCount: candidate.documentChangeCount,
    frustrationSignal: candidate.frustrationSignal,
    occurrences: 1,
    retentionProbability: triage.retentionProbability,
    classificationConfidence: triage.classificationConfidence,
  };
}

export function behaviorEpisodeRetentionPlan(
  episodes: readonly BehaviorEpisodeRecord[],
  now = Date.now(),
  maxCount = MAX_BEHAVIOR_EPISODES_PER_APP,
  maxAgeMs = MAX_BEHAVIOR_EPISODE_AGE_MS,
): { keep: BehaviorEpisodeRecord[]; deleteIds: string[] } {
  const fresh = episodes.filter(item => now - item.lastSeenAt <= maxAgeMs);
  fresh.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const keep = fresh.slice(0, Math.max(0, maxCount));
  const keepIds = new Set(keep.map(item => item.id));
  return { keep, deleteIds: episodes.filter(item => !keepIds.has(item.id)).map(item => item.id) };
}

export function behaviorSummaryFromEpisodes(
  episodes: readonly BehaviorEpisodeRecord[],
  maxCharacters = 8_000,
): string | undefined {
  const selected = [...episodes]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_BEHAVIOR_EPISODES_PER_APP);
  if (!selected.length) return undefined;
  const lines = selected.map(item =>
    `[${item.kind}] ${item.signal} (seen ${item.occurrences}×)`
  );
  const summary = lines.join("\n");
  return summary.length <= maxCharacters ? summary : summary.slice(0, Math.max(0, maxCharacters - 16)) + " …[truncated]";
}
