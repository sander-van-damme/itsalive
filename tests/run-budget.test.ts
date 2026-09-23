import { describe, expect, it } from "vitest";
import { RunBudgetController, runBudgetMessage, type RunBudgetLimits } from "../src/shell/core/run-budget";

const limits = (overrides: Partial<RunBudgetLimits> = {}): RunBudgetLimits => ({
  maxDurationMs: 60_000,
  idleTimeoutMs: 10_000,
  maxCostUsd: null,
  maxConsecutiveFailures: 3,
  stallRepeatLimit: 2,
  emergencyTurnCeiling: 1_000,
  ...overrides,
});

describe("RunBudgetController", () => {
  it("treats turn count as telemetry until the emergency runaway ceiling", () => {
    const budget = new RunBudgetController(limits({ emergencyTurnCeiling: 1_000 }));
    for (let turn = 1; turn <= 1_000; turn++) expect(budget.startTurn(turn)).toBeUndefined();
    expect(budget.startTurn(1_001)).toBe("emergency-ceiling");
    expect(budget.snapshot().turns).toBe(1_000);
  });

  it("stops at a known dollar budget", () => {
    const budget = new RunBudgetController(limits({ maxCostUsd: 0.05 }));
    expect(budget.recordUsage(0.02)).toBeUndefined();
    expect(budget.recordUsage(0.03)).toBe("cost-budget");
    expect(budget.snapshot()).toMatchObject({
      localKnownCostUsd: 0.05,
      rootKnownCostUsd: 0.05,
      localUnknownCostRequests: 0,
    });
  });

  it("never treats unknown provider cost as zero when a cost cap is active", () => {
    const budget = new RunBudgetController(limits({ maxCostUsd: 0.05 }));
    expect(budget.recordUsage(undefined)).toBe("cost-unknown");
    expect(budget.snapshot()).toMatchObject({
      localKnownCostUsd: 0,
      localUnknownCostRequests: 1,
    });
  });

  it("allows unknown cost under time/failure budgets when dollar enforcement is disabled", () => {
    const budget = new RunBudgetController(limits({ maxCostUsd: null }));
    expect(budget.recordUsage(undefined)).toBeUndefined();
    expect(budget.snapshot().localUnknownCostRequests).toBe(1);
  });

  it("shares root spend across child workers while preserving child caps", () => {
    const root = new RunBudgetController(limits({ maxCostUsd: 0.10 }));
    const a = root.fork(limits({ maxCostUsd: 0.08 }));
    const b = root.fork(limits({ maxCostUsd: 0.08 }));

    expect(a.recordUsage(0.06)).toBeUndefined();
    expect(b.recordUsage(0.03)).toBeUndefined();
    expect(b.recordUsage(0.01)).toBe("cost-budget");

    expect(a.snapshot().rootKnownCostUsd).toBeCloseTo(0.10);
    expect(b.snapshot().rootKnownCostUsd).toBeCloseTo(0.10);
    expect(a.snapshot().localKnownCostUsd).toBeCloseTo(0.06);
    expect(b.snapshot().localKnownCostUsd).toBeCloseTo(0.04);
  });

  it("tracks repeated failures independently and resets after success", () => {
    const budget = new RunBudgetController(limits({ maxConsecutiveFailures: 2 }));
    expect(budget.recordFailure("runtime")).toBeUndefined();
    budget.recordSuccess("runtime");
    expect(budget.recordFailure("runtime")).toBeUndefined();
    expect(budget.recordFailure("runtime")).toBe("runtime-failure");
    expect(budget.recordFailure("generation")).toBeUndefined();
  });

  it("uses an explicit stall budget", () => {
    const budget = new RunBudgetController(limits({ stallRepeatLimit: 2 }));
    expect(budget.recordStall()).toBeUndefined();
    expect(budget.recordStall()).toBe("stalled");
    budget.clearStall();
    expect(budget.snapshot().stallRepeats).toBe(0);
  });

  it("provides meaningful user-facing stop messages", () => {
    expect(runBudgetMessage("cost-budget")).toContain("cost budget");
    expect(runBudgetMessage("generation-failure")).toContain("repeated invalid model output");
    expect(runBudgetMessage("emergency-ceiling")).toContain("emergency runaway guard");
  });
});
