import { describe, expect, it } from "vitest";
import { AGENT_PROFILES, agentProfile, resolveAgentProfile } from "../src/shell/core/agent-profiles";

describe("agent profile registry", () => {
  it("defines distinct role profiles with centralized compute and context policies", () => {
    expect(Object.keys(AGENT_PROFILES).sort()).toEqual([
      "behavior-summary",
      "coding-manager",
      "component-worker",
      "repair-worker",
      "runtime-llm",
      "user-intent",
    ]);
    expect(agentProfile("coding-manager")).toMatchObject({
      role: "coding-manager",
      compute: "high",
      contextPolicy: "manager-technical",
      capabilityExposure: "selected",
    });
    expect(agentProfile("component-worker")).toMatchObject({
      role: "component-worker",
      compute: "low",
      contextPolicy: "component-scoped",
    });
    expect(agentProfile("repair-worker")).toMatchObject({
      role: "repair-worker",
      compute: "medium",
      contextPolicy: "repair-evidence",
    });
    expect(agentProfile("runtime-llm")).toMatchObject({
      role: "runtime-llm",
      compute: "low",
      contextPolicy: "runtime-minimal",
      capabilityExposure: "none",
    });
  });

  it("maps compute to provider options inside the profile layer", () => {
    const resolved = resolveAgentProfile("component-worker", {
      contextCapacity: 64_000,
      configuredHistoryTokens: 12_000,
    });
    expect(resolved.modelConfig).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
      options: { reasoning: { effort: "low" } },
      maxContextTokens: 64_000,
      historyContextTokens: 4_000,
    });
  });

  it("keeps manager history configurable while capping focused workers", () => {
    expect(resolveAgentProfile("coding-manager", {
      contextCapacity: 64_000,
      configuredHistoryTokens: 12_000,
    }).modelConfig.historyContextTokens).toBe(12_000);
    expect(resolveAgentProfile("component-worker", {
      contextCapacity: 64_000,
      configuredHistoryTokens: 12_000,
    }).modelConfig.historyContextTokens).toBe(4_000);
    expect(resolveAgentProfile("repair-worker", {
      contextCapacity: 64_000,
      configuredHistoryTokens: 12_000,
    }).modelConfig.historyContextTokens).toBe(6_000);
  });

  it("gives runtime callbacks a minimal zero-history context policy", () => {
    const resolved = resolveAgentProfile("runtime-llm", {
      contextCapacity: 128_000,
      configuredHistoryTokens: 50_000,
    });
    expect(resolved.modelConfig.historyContextTokens).toBe(0);
    expect(resolved.modelConfig.observationHeadroomTokens).toBe(0);
    expect(resolved.outputHeadroomTokens).toBe(2_048);
    expect(resolved.capabilityExposure).toBe("none");
  });

  it("keeps budget defaults explicit without enforcing an arbitrary dollar cap yet", () => {
    for (const profile of Object.values(AGENT_PROFILES)) {
      expect(profile.budgets.maxDurationMs).toBeGreaterThan(0);
      expect(profile.budgets.idleTimeoutMs).toBeGreaterThan(0);
      expect(profile.budgets.maxConsecutiveFailures).toBeGreaterThan(0);
      expect(profile.budgets.stallRepeatLimit).toBeGreaterThan(0);
      expect(profile.budgets.emergencyTurnCeiling).toBeGreaterThan(12);
      expect(profile.budgets.maxCostUsd).toBeNull();
    }
  });
});
