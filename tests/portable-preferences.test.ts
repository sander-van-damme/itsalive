import { describe, expect, it } from "vitest";
import {
  decidePortablePreference,
  eligiblePortablePreferenceCandidate,
  mergePortablePreference,
  parsePortablePreferences,
  removePortablePreferenceProvenance,
  selectPortablePreferencesForApp,
  setPortablePreferenceEnabled,
  type PortablePreferenceCandidate,
  type PortablePreferenceRecord,
} from "../src/shell/core/portable-preferences";
import type { JevDecisionResult } from "../src/shell/core/jev";

function candidate(overrides: Partial<PortablePreferenceCandidate> = {}): PortablePreferenceCandidate {
  return {
    source: "explicit-input",
    sourceAppId: "app-a",
    sourceRef: "intent-1",
    observedAt: 100,
    evidence: "Please keep explanations concise.",
    occurrences: 1,
    ...overrides,
  };
}

function result(portable: number, choice: string, confidence = 0.95): JevDecisionResult {
  return {
    probability: portable,
    answers: {
      portable_preference: { type: "noul", noul: portable },
      portable_preference_value: {
        type: "choice",
        choice,
        probabilities: { [choice]: confidence },
        confidence,
      },
    },
    diagnostics: { elapsedMs: 1 },
  };
}

function record(
  id: string,
  value: PortablePreferenceRecord["value"],
  appId: string,
  enabled = true,
): PortablePreferenceRecord {
  const category = value === "reduced-motion" ? "motion"
    : value === "compact-layout" || value === "spacious-layout" ? "layout-density"
      : value === "keyboard-first" ? "input-mode"
        : value === "concise-explanations" || value === "detailed-explanations" ? "explanation-detail"
          : "proactive-assistance";
  return {
    id,
    category,
    value,
    createdAt: 1,
    updatedAt: 2,
    enabled,
    portabilityProbability: 0.96,
    classificationConfidence: 0.94,
    provenance: [{ source: "explicit-input", appId, ref: "ref-" + id, observedAt: 1, occurrences: 1 }],
  };
}

describe("portable cross-app preferences", () => {
  it("requires repeated evidence for behavioral promotion but allows explicit preference text", () => {
    expect(eligiblePortablePreferenceCandidate(candidate())).toBe(true);
    expect(eligiblePortablePreferenceCandidate(candidate({
      source: "behavior-episode",
      sourceRef: "episode-1",
      occurrences: 1,
    }))).toBe(false);
    expect(eligiblePortablePreferenceCandidate(candidate({
      source: "behavior-episode",
      sourceRef: "episode-1",
      occurrences: 2,
    }))).toBe(true);
  });

  it("promotes only high-confidence allowlisted values and keeps uncertainty non-durable", () => {
    expect(decidePortablePreference(result(0.96, "keyboard_first", 0.93))).toMatchObject({
      action: "promote",
      value: "keyboard-first",
      category: "input-mode",
    });
    expect(decidePortablePreference(result(0.7, "keyboard_first", 0.95))).toMatchObject({
      action: "ignore",
      reason: "portability-below-threshold",
    });
    expect(decidePortablePreference(result(0.97, "keyboard_first", 0.5))).toMatchObject({
      action: "uncertain",
    });
    expect(decidePortablePreference(result(0.99, "none", 0.99))).toMatchObject({
      action: "ignore",
      reason: "no-allowlisted-preference",
    });
  });

  it("stores normalized preference state and provenance without raw evidence", () => {
    const decision = decidePortablePreference(result(0.97, "concise_explanations", 0.96));
    const merged = mergePortablePreference([], candidate(), decision, "pref-1", 200);
    expect(merged[0]).toMatchObject({
      id: "pref-1",
      category: "explanation-detail",
      value: "concise-explanations",
      enabled: true,
    });
    expect(JSON.stringify(merged)).not.toContain("Please keep explanations concise.");
    expect(merged[0]!.provenance[0]).toMatchObject({ appId: "app-a", ref: "intent-1" });
  });

  it("preserves a user's disabled state when new evidence reinforces the same preference", () => {
    const initial = setPortablePreferenceEnabled([record("pref-1", "keyboard-first", "app-a")], "pref-1", false, 10);
    const decision = decidePortablePreference(result(0.98, "keyboard_first", 0.97));
    const merged = mergePortablePreference(
      initial,
      candidate({ sourceAppId: "app-b", sourceRef: "intent-2", evidence: "I prefer keyboard shortcuts." }),
      decision,
      "unused",
      20,
    );
    expect(merged[0]!.enabled).toBe(false);
    expect(merged[0]!.provenance.map(item => item.appId)).toEqual(expect.arrayContaining(["app-a", "app-b"]));
  });

  it("applies only enabled cross-app preferences and respects global/per-app isolation", () => {
    const records = [
      record("keyboard", "keyboard-first", "app-a"),
      record("motion", "reduced-motion", "app-b"),
    ];
    expect(selectPortablePreferencesForApp(records, "app-c", false, false)).toEqual([]);
    expect(selectPortablePreferencesForApp(records, "app-c", true, true)).toEqual([]);

    const selected = selectPortablePreferencesForApp(records, "app-c", true, false);
    expect(selected.map(item => item.value)).toEqual(["keyboard-first", "reduced-motion"]);
    expect(selected[0]!.context).not.toContain("app-a");
    expect(selected[0]!.context).not.toContain("history");
    expect(selectPortablePreferencesForApp([record("same", "keyboard-first", "app-c")], "app-c", true, false)).toEqual([]);
  });

  it("drops conflicted categories instead of guessing which cross-app preference wins", () => {
    const selected = selectPortablePreferencesForApp([
      record("compact", "compact-layout", "app-a"),
      record("spacious", "spacious-layout", "app-b"),
      record("keyboard", "keyboard-first", "app-a"),
    ], "app-c", true, false);
    expect(selected.map(item => item.value)).toEqual(["keyboard-first"]);
  });

  it("removes deleted-app provenance and drops preferences with no remaining source", () => {
    const shared = record("shared", "reduced-motion", "app-a");
    shared.provenance.push({ source: "explicit-input", appId: "app-b", ref: "ref-b", observedAt: 2, occurrences: 1 });
    const cleaned = removePortablePreferenceProvenance([
      record("only-a", "keyboard-first", "app-a"),
      shared,
    ], "app-a");
    expect(cleaned.map(item => item.id)).toEqual(["shared"]);
    expect(cleaned[0]!.provenance.map(item => item.appId)).toEqual(["app-b"]);
  });

  it("rejects malformed stored preferences and never accepts arbitrary trait values", () => {
    const parsed = parsePortablePreferences([
      record("ok", "keyboard-first", "app-a"),
      {
        ...record("bad", "keyboard-first", "app-a"),
        category: "identity",
        value: "medical-condition",
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.value).toBe("keyboard-first");
    expect(JSON.stringify(parsed)).not.toMatch(/medical-condition|identity/);
  });
});
