import { describe, expect, it } from "vitest";
import { codingLifecycleLabel } from "../src/shell/progress";
import type { CodingLifecycleSummary } from "../src/shell/core/coding-orchestrator";

const summary = (overrides: Partial<CodingLifecycleSummary>): CodingLifecycleSummary => ({
  phase: "working",
  total: 3,
  queued: 0,
  building: 0,
  repairing: 0,
  verifying: 0,
  ready: 0,
  failed: 0,
  blocked: 0,
  ...overrides,
});

describe("component lifecycle progress copy", () => {
  it("uses non-technical planning language", () => {
    expect(codingLifecycleLabel(summary({ phase: "planning", total: 0 }), true)).toBe("Planning the first version…");
    expect(codingLifecycleLabel(summary({ phase: "planning", total: 0 }), false)).toBe("Planning the change…");
  });

  it("reports completed, active, and queued parts in one consistent summary", () => {
    expect(codingLifecycleLabel(summary({ queued: 2, building: 1 }), true))
      .toBe("Building app · 0 of 3 parts complete · 1 in progress · 2 waiting…");
    expect(codingLifecycleLabel(summary({ ready: 2, building: 1 }), true))
      .toBe("Building app · 2 of 3 parts complete · 1 in progress…");
  });

  it("localizes failed or blocked parts without presenting the whole app as blocked", () => {
    expect(codingLifecycleLabel(summary({ total: 2, ready: 1, failed: 1 }), false))
      .toBe("Building app · 1 of 2 parts complete · 1 part needs attention…");
    expect(codingLifecycleLabel(summary({ total: 3, ready: 1, failed: 1, blocked: 1 }), false))
      .toBe("Building app · 1 of 3 parts complete · 2 parts need attention…");
  });

  it("uses simple user-facing copy while the app is being checked", () => {
    expect(codingLifecycleLabel(summary({ phase: "integration-verification", ready: 3 }), true))
      .toBe("Checking the app · 3 of 3 parts complete…");
    expect(codingLifecycleLabel(summary({ phase: "integration-verification", ready: 1, failed: 1, blocked: 1 }), false))
      .toBe("Checking the app · 1 of 3 parts complete · 2 parts need attention…");
  });

  it("never exposes orchestration jargon in user-facing lifecycle labels", () => {
    const labels = [
      codingLifecycleLabel(summary({ queued: 2, building: 1 }), true),
      codingLifecycleLabel(summary({ ready: 2, repairing: 1 }), false),
      codingLifecycleLabel(summary({ phase: "integration-verification", ready: 3 }), true),
      codingLifecycleLabel(summary({ total: 2, ready: 1, blocked: 1 }), false),
    ].join("\n").toLowerCase();

    for (const internal of ["region", "worker", "handoff", "final verification", "integration verification"]) {
      expect(labels).not.toContain(internal);
    }
  });
});
