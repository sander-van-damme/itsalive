import type { BehaviorEpisodeRecord } from "./behavior-episodes";
import { classifyNoulBand, type JevNoulBandPolicy } from "./jev-eval";
import type { JevDecisionResult, JevQuestions } from "./jev";
import type { HistoryEntry } from "./types";

export const JEV_CONTEXT_RELEVANCE_QUESTION_SET_VERSION = "context-relevance-v1";
export const MAX_CONTEXT_RELEVANCE_CANDIDATES = 12;
const MAX_HISTORY_CANDIDATES = 9;
const MAX_BEHAVIOR_CANDIDATES = 3;
const MAX_CANDIDATE_CHARACTERS = 1_600;

export type ContextEvidenceSource = "technical-history" | "behavior-episode";

export interface ContextEvidenceCandidate {
  id: string;
  source: ContextEvidenceSource;
  timestamp: number;
  content: string;
}

export interface ContextEvidenceCandidateSet {
  candidates: ContextEvidenceCandidate[];
  historyByCandidateId: Record<string, HistoryEntry>;
  behaviorByCandidateId: Record<string, BehaviorEpisodeRecord>;
  availableTechnicalHistoryCount: number;
  availableBehaviorEpisodeCount: number;
}

export interface ContextRelevanceState {
  task: string;
  candidates: ContextEvidenceCandidate[];
}

export interface ContextRelevanceDecision {
  selectedIds: string[];
  omittedIds: string[];
  uncertainIds: string[];
}

export type ContextRelevanceAssessor = (
  state: ContextRelevanceState,
  signal: AbortSignal,
) => Promise<ContextRelevanceDecision>;

function bound(value: string, max = MAX_CANDIDATE_CHARACTERS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : normalized.slice(0, Math.max(0, max - 16)) + " …[truncated]";
}

function technicalHistory(history: readonly HistoryEntry[], observation?: string): HistoryEntry[] {
  const filtered = history.filter(entry => {
    if (observation && entry.role === "observation" && entry.content === observation) return false;
    if (entry.role === "observation" || entry.role === "agent") return true;
    return entry.kind === "javascript" || entry.kind === "execution" || entry.kind === "error";
  });
  const newest = [...filtered].sort((a, b) => b.timestamp - a.timestamp);
  const selected = newest.slice(0, MAX_HISTORY_CANDIDATES);
  const newestError = newest.find(entry => entry.kind === "error");
  if (newestError && !selected.includes(newestError) && selected.length) selected[selected.length - 1] = newestError;
  return selected.sort((a, b) => b.timestamp - a.timestamp);
}

export function buildContextEvidenceCandidates(input: {
  history: readonly HistoryEntry[];
  behaviorEpisodes: readonly BehaviorEpisodeRecord[];
  observation?: string;
}): ContextEvidenceCandidateSet {
  const allTechnical = input.history.filter(entry =>
    (entry.role === "observation" || entry.role === "agent"
      || entry.kind === "javascript" || entry.kind === "execution" || entry.kind === "error")
    && !(input.observation && entry.role === "observation" && entry.content === input.observation)
  );
  const selectedHistory = technicalHistory(input.history, input.observation);
  const selectedBehavior = [...input.behaviorEpisodes]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_BEHAVIOR_CANDIDATES);

  const historyByCandidateId: Record<string, HistoryEntry> = {};
  const behaviorByCandidateId: Record<string, BehaviorEpisodeRecord> = {};
  const candidates: ContextEvidenceCandidate[] = [];

  for (const [index, entry] of selectedHistory.entries()) {
    const id = `history:${entry.id ?? `${entry.timestamp}:${index}`}`;
    historyByCandidateId[id] = entry;
    candidates.push({
      id,
      source: "technical-history",
      timestamp: entry.timestamp,
      content: bound(entry.content),
    });
  }

  for (const episode of selectedBehavior) {
    const id = `behavior:${episode.id}`;
    behaviorByCandidateId[id] = episode;
    candidates.push({
      id,
      source: "behavior-episode",
      timestamp: episode.lastSeenAt,
      content: bound(`[${episode.kind}] ${episode.signal} (seen ${episode.occurrences}×)`, 800),
    });
  }

  candidates.sort((a, b) => b.timestamp - a.timestamp);
  return {
    candidates: candidates.slice(0, MAX_CONTEXT_RELEVANCE_CANDIDATES),
    historyByCandidateId,
    behaviorByCandidateId,
    availableTechnicalHistoryCount: allTechnical.length,
    availableBehaviorEpisodeCount: input.behaviorEpisodes.length,
  };
}

export function contextRelevanceQuestions(candidates: readonly ContextEvidenceCandidate[]): JevQuestions {
  return Object.fromEntries(candidates.map((candidate, index) => [
    `relevant_${index}`,
    {
      type: "noul" as const,
      instructions: `Is evidence candidate ${candidate.id} materially useful for completing the current task without adding unrelated context noise?`,
      criteria: {
        true: "The evidence may change implementation, diagnosis, constraints, regression safety, or task-specific user preference handling.",
        false: "The evidence is unrelated, already superseded, or adds historical/behavioral noise without helping the current task.",
      },
    },
  ]));
}

export const DEFAULT_CONTEXT_RELEVANCE_POLICY: JevNoulBandPolicy = Object.freeze({
  lowMax: 0.25,
  highMin: 0.65,
});

export function decideContextRelevance(
  result: Pick<JevDecisionResult, "answers">,
  candidates: readonly ContextEvidenceCandidate[],
  policy: JevNoulBandPolicy = DEFAULT_CONTEXT_RELEVANCE_POLICY,
): ContextRelevanceDecision {
  const selectedIds: string[] = [];
  const omittedIds: string[] = [];
  const uncertainIds: string[] = [];

  candidates.forEach((candidate, index) => {
    const answer = result.answers[`relevant_${index}`];
    if (answer?.type !== "noul") throw new Error(`Jev context relevance omitted answer for ${candidate.id}`);
    const band = classifyNoulBand(answer.noul, policy);
    if (band === "low") omittedIds.push(candidate.id);
    else {
      selectedIds.push(candidate.id);
      if (band === "uncertain") uncertainIds.push(candidate.id);
    }
  });
  return { selectedIds, omittedIds, uncertainIds };
}

export function deterministicContextFallback(candidates: readonly ContextEvidenceCandidate[]): ContextRelevanceDecision {
  return { selectedIds: candidates.map(item => item.id), omittedIds: [], uncertainIds: [] };
}

export function selectedContextEvidence(
  set: ContextEvidenceCandidateSet,
  decision: ContextRelevanceDecision,
): { history: HistoryEntry[]; behaviorEvidence: Array<{ id: string; content: string }> } {
  const selected = new Set(decision.selectedIds);
  const history = set.candidates
    .filter(candidate => selected.has(candidate.id) && candidate.source === "technical-history")
    .map(candidate => set.historyByCandidateId[candidate.id])
    .filter((entry): entry is HistoryEntry => Boolean(entry))
    .sort((a, b) => a.timestamp - b.timestamp);
  const behaviorEvidence = set.candidates
    .filter(candidate => selected.has(candidate.id) && candidate.source === "behavior-episode")
    .map(candidate => ({ id: candidate.id, content: candidate.content }));
  return { history, behaviorEvidence };
}
