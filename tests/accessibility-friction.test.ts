import { describe, expect, it } from "vitest";
import {
  accessibilitySuggestionFromJev,
  ambiguousAccessibilityCandidate,
  decideAccessibilityFriction,
  deterministicAccessibilitySuggestion,
  recordAccessibilityDismissal,
  shouldSuppressAccessibilitySuggestion,
} from "../src/shell/core/accessibility-friction";
import type { InteractionObservation, InteractionPattern } from "../src/shared";
import type { JevDecisionResult } from "../src/shell/core/jev";

function observation(input: {
  type: string;
  tag: string;
  id?: string;
  key?: string;
  role?: string;
  label?: string;
}): InteractionObservation {
  return {
    interaction: {
      seq: 1,
      at: "2026-09-24T10:00:00.000Z",
      type: input.type,
      target: { tag: "main" },
      actualTarget: {
        tag: input.tag,
        ...(input.id ? { id: input.id } : {}),
        ...((input.role || input.label)
          ? { state: {
              ...(input.role ? { role: input.role } : {}),
              ...(input.label ? { "aria-label": input.label } : {}),
            } }
          : {}),
      },
      ...(input.key ? { key: input.key } : {}),
    },
    document: "<main></main>",
  };
}

function pattern(overrides: Partial<InteractionPattern> = {}): InteractionPattern {
  return {
    kind: "repeated-action",
    actionCount: 5,
    coalescedCount: 3,
    durationMs: 400,
    averageIntervalMs: 100,
    documentChangeCount: 0,
    likelyBenign: false,
    frustrationSignal: true,
    ...overrides,
  };
}

function jev(friction: number, kind: string, confidence = 0.9): JevDecisionResult {
  return {
    probability: friction,
    answers: {
      accessibility_friction: { type: "noul", noul: friction },
      accessibility_friction_kind: {
        type: "choice",
        choice: kind,
        probabilities: { [kind]: confidence },
        confidence,
      },
    },
    diagnostics: { elapsedMs: 1 },
  };
}

describe("accessibility friction assistance", () => {
  it("detects repeated keyboard activation on a non-semantic target deterministically", () => {
    const candidate = deterministicAccessibilitySuggestion(
      observation({ type: "keydown", tag: "div", id: "save-card", key: "Enter", label: "Save" }),
      pattern({ actionCount: 3 }),
    );
    expect(candidate).toMatchObject({
      kind: "keyboard-semantics",
      source: "deterministic",
      applyLabel: "Improve keyboard access",
    });
    expect(candidate?.requestText).toContain("native semantic interactive HTML");
    expect(candidate?.requestText).toContain("visible keyboard focus");
    expect(candidate?.requestText).toContain("reduced-motion");
    expect(JSON.stringify(candidate)).not.toMatch(/disab|diagnos|medical|health/i);
  });

  it("does not flag already-semantic keyboard controls or successful activation", () => {
    expect(deterministicAccessibilitySuggestion(
      observation({ type: "keydown", tag: "button", id: "save", key: "Enter" }),
      pattern(),
    )).toBeUndefined();
    expect(deterministicAccessibilitySuggestion(
      observation({ type: "keydown", tag: "div", id: "save", key: "Enter" }),
      pattern({ documentChangeCount: 1 }),
    )).toBeUndefined();
  });

  it("sends only ambiguous repeated pointer friction to JEV classification", () => {
    const candidate = ambiguousAccessibilityCandidate(
      observation({ type: "click", tag: "button", id: "tiny-next", label: "Next" }),
      pattern({ actionCount: 5, documentChangeCount: 0 }),
    );
    expect(candidate).toMatchObject({
      interactionType: "click",
      targetTag: "button",
      targetId: "tiny-next",
      actionCount: 5,
    });
    expect(ambiguousAccessibilityCandidate(
      observation({ type: "click", tag: "button", id: "next" }),
      pattern({ likelyBenign: true }),
    )).toBeUndefined();
  });

  it("turns high-confidence JEV friction into a concrete reversible adjustment", () => {
    const candidate = ambiguousAccessibilityCandidate(
      observation({ type: "click", tag: "button", id: "submit", label: "Submit" }),
      pattern(),
    )!;
    const decision = decideAccessibilityFriction(jev(0.91, "feedback", 0.92));
    expect(decision).toMatchObject({ action: "offer", kind: "feedback" });
    const suggestion = accessibilitySuggestionFromJev(candidate, decision)!;
    expect(suggestion.content).toContain("clearer success/error feedback");
    expect(suggestion.requestText).toContain("semantic status/error markup");
    expect(suggestion.requestText).toContain("preserve keyboard focus");
    expect(suggestion.requestText).toContain("reduced-motion");
    expect(JSON.stringify(suggestion)).not.toMatch(/disab|diagnos|medical|health/i);
  });

  it("ignores weak evidence and uncertain friction classes", () => {
    expect(decideAccessibilityFriction(jev(0.4, "targeting"))).toMatchObject({ action: "ignore" });
    expect(decideAccessibilityFriction(jev(0.9, "targeting", 0.4))).toMatchObject({ action: "uncertain" });
  });

  it("suppresses a dismissed hypothesis during its cooldown without storing user traits", () => {
    const now = 1_000;
    const dismissals = recordAccessibilityDismissal([], "pointer-friction:button:submit", now);
    expect(shouldSuppressAccessibilitySuggestion(dismissals, "pointer-friction:button:submit", now + 1)).toBe(true);
    expect(shouldSuppressAccessibilitySuggestion(dismissals, "other", now + 1)).toBe(false);
    expect(JSON.stringify(dismissals)).not.toMatch(/disab|diagnos|medical|health|preference|profile/i);
  });
});
