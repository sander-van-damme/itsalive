import { describe, expect, it } from "vitest";
import {
  buildContextEvidenceCandidates,
  contextRelevanceQuestions,
  decideContextRelevance,
  deterministicContextFallback,
  selectedContextEvidence,
  type ContextEvidenceCandidate,
} from "../src/shell/core/context-relevance";
import type { JevDecisionResult } from "../src/shell/core/jev";
import type { BehaviorEpisodeRecord } from "../src/shell/core/behavior-episodes";
import type { HistoryEntry } from "../src/shell/core/types";

function result(probabilities: number[]): JevDecisionResult {
  return {
    probability: 0,
    answers: Object.fromEntries(probabilities.map((noul, index) => [
      `relevant_${index}`,
      { type: "noul", noul },
    ])),
    diagnostics: { elapsedMs: 1 },
  };
}

describe("context relevance candidate pipeline", () => {
  it("builds a bounded deterministic shortlist before JEV", () => {
    const history: HistoryEntry[] = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      appId: "app",
      timestamp: index + 1,
      role: "agent",
      kind: "javascript",
      content: `command ${index}`,
    }));
    const episodes: BehaviorEpisodeRecord[] = Array.from({ length: 6 }, (_, index) => ({
      id: `episode-${index}`,
      appId: "app",
      createdAt: index,
      lastSeenAt: index + 100,
      kind: "preference",
      fingerprint: `f-${index}`,
      signal: `preference ${index}`,
      interactionType: "click",
      targetTag: "button",
      actionCount: 3,
      documentChangeCount: 0,
      frustrationSignal: false,
      occurrences: 1,
      retentionProbability: 0.9,
      classificationConfidence: 0.9,
    }));

    const set = buildContextEvidenceCandidates({ history, behaviorEpisodes: episodes });
    expect(set.candidates.length).toBeLessThanOrEqual(12);
    expect(set.candidates.filter(item => item.source === "technical-history")).toHaveLength(9);
    expect(set.candidates.filter(item => item.source === "behavior-episode")).toHaveLength(3);
    expect(set.availableTechnicalHistoryCount).toBe(20);
    expect(set.availableBehaviorEpisodeCount).toBe(6);
    expect(Object.keys(contextRelevanceQuestions(set.candidates))).toHaveLength(set.candidates.length);
  });

  it("removes confidently irrelevant context pollution", () => {
    const candidates: ContextEvidenceCandidate[] = [
      { id: "history:1", source: "technical-history", timestamp: 2, content: "ReferenceError in timer restore" },
      { id: "behavior:1", source: "behavior-episode", timestamp: 1, content: "Old unrelated color preference" },
    ];
    const decision = decideContextRelevance(result([0.94, 0.05]), candidates);
    expect(decision).toEqual({
      selectedIds: ["history:1"],
      omittedIds: ["behavior:1"],
      uncertainIds: [],
    });
  });

  it("keeps uncertain evidence to avoid context starvation", () => {
    const candidates: ContextEvidenceCandidate[] = [
      { id: "history:1", source: "technical-history", timestamp: 1, content: "Possible earlier repair constraint" },
    ];
    const decision = decideContextRelevance(result([0.45]), candidates);
    expect(decision.selectedIds).toEqual(["history:1"]);
    expect(decision.omittedIds).toEqual([]);
    expect(decision.uncertainIds).toEqual(["history:1"]);
  });

  it("falls back to the full deterministic shortlist when JEV is unavailable", () => {
    const candidates: ContextEvidenceCandidate[] = [
      { id: "history:1", source: "technical-history", timestamp: 2, content: "error" },
      { id: "behavior:1", source: "behavior-episode", timestamp: 1, content: "preference" },
    ];
    expect(deterministicContextFallback(candidates)).toEqual({
      selectedIds: ["history:1", "behavior:1"],
      omittedIds: [],
      uncertainIds: [],
    });
  });

  it("materializes only selected technical and behavioral evidence", () => {
    const history: HistoryEntry = {
      id: 7, appId: "app", timestamp: 7, role: "observation", kind: "error", content: "timer restore error",
    };
    const episode: BehaviorEpisodeRecord = {
      id: "episode-1",
      appId: "app",
      createdAt: 1,
      lastSeenAt: 8,
      kind: "preference",
      fingerprint: "f",
      signal: "Prefers compact controls",
      interactionType: "click",
      targetTag: "button",
      actionCount: 3,
      documentChangeCount: 0,
      frustrationSignal: false,
      occurrences: 2,
      retentionProbability: 0.9,
      classificationConfidence: 0.9,
    };
    const set = buildContextEvidenceCandidates({ history: [history], behaviorEpisodes: [episode] });
    const behaviorCandidate = set.candidates.find(item => item.source === "behavior-episode")!;
    const selected = selectedContextEvidence(set, {
      selectedIds: [behaviorCandidate.id],
      omittedIds: set.candidates.filter(item => item.id !== behaviorCandidate.id).map(item => item.id),
      uncertainIds: [],
    });
    expect(selected.history).toEqual([]);
    expect(selected.behaviorEvidence).toEqual([expect.objectContaining({
      id: behaviorCandidate.id,
      content: expect.stringContaining("Prefers compact controls"),
    })]);
  });
});
