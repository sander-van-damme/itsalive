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

  it("describes partial readiness instead of treating the whole app as blocked", () => {
    expect(codingLifecycleLabel(summary({ ready: 2, building: 1 }), true))
      .toBe("2/3 regions ready · 1 still taking shape…");
  });

  it("localizes failed or blocked regions in the aggregate message", () => {
    expect(codingLifecycleLabel(summary({ total: 2, ready: 1, failed: 1 }), false))
      .toBe("1/2 regions ready · 1 needs attention…");
  });

  it("keeps final integration verification distinct from component readiness", () => {
    expect(codingLifecycleLabel(summary({
      phase: "integration-verification",
      ready: 3,
    }), true)).toBe("3/3 regions ready · checking everything together…");
  });
});
