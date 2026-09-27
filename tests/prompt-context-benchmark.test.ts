import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_CONTRACTS, compactWorkerHandoff } from "../src/shell/core/agent-context";
import {
  PROMPT_BENCHMARK_SCENARIOS,
  PROMPT_BENCHMARK_VARIANTS,
  PROMPT_ROBUSTNESS_COMPUTE,
  measurePromptBenchmarkMatrix,
} from "../src/shell/core/prompt-benchmark";
import { agentProfile } from "../src/shell/core/agent-profiles";

describe("agent prompt/context benchmark contract", () => {
  it("covers the five required benchmark scenarios", () => {
    expect(PROMPT_BENCHMARK_SCENARIOS.map(scenario => scenario.id)).toEqual([
      "simple-build",
      "multi-component-build",
      "runtime-repair",
      "existing-app-change",
      "runtime-llm",
    ]);
  });

  it("compares the production worker contract with one minimal console candidate on identical scenarios", () => {
    expect(PROMPT_BENCHMARK_VARIANTS.map(variant => variant.id)).toEqual([
      "production-worker",
      "minimal-console",
    ]);

    const matrix = measurePromptBenchmarkMatrix(value => value.length);
    expect(matrix).toHaveLength(PROMPT_BENCHMARK_SCENARIOS.length * 2);

    for (const scenario of PROMPT_BENCHMARK_SCENARIOS) {
      const rows = matrix.filter(row => row.scenario === scenario.id);
      const production = rows.find(row => row.variant === "production-worker")!;
      const minimal = rows.find(row => row.variant === "minimal-console")!;

      expect(production.mandatoryTokens).toBe(minimal.mandatoryTokens);
      expect(production.historyTokens).toBe(minimal.historyTokens);
      expect(minimal.systemTokens).toBeLessThan(production.systemTokens);

      for (const row of rows) {
        expect(row.estimatedInputTokens).toBe(
          row.systemTokens
          + row.mandatoryTokens
          + row.observationTokens
          + row.environmentObservationTokens
          + row.evidenceTokens
          + row.historyTokens,
        );
      }
    }
  });

  it("benchmarks the same atomic console architecture rather than the removed streamed protocol", () => {
    const production = PROMPT_BENCHMARK_VARIANTS.find(variant => variant.id === "production-worker")!;
    const minimal = PROMPT_BENCHMARK_VARIANTS.find(variant => variant.id === "minimal-console")!;
    expect(production.systemPrompt).toContain("JavaScript console");
    expect(production.systemPrompt).toContain("executes it once");
    expect(minimal.systemPrompt).toContain("JavaScript console");
    expect(minimal.systemPrompt).toContain("full response executes once");
    for (const variant of PROMPT_BENCHMARK_VARIANTS) {
      expect(variant.systemPrompt).not.toContain("/* itsalive:command */");
      expect(variant.systemPrompt).not.toContain("/* itsalive:end */");
    }
  });

  it("uses Low compute as the explicit robustness probe for component workers", () => {
    expect(PROMPT_ROBUSTNESS_COMPUTE).toBe("low");
    expect(agentProfile("component-worker").compute).toBe("low");
  });

  it("defines role-specific context boundaries before orchestration exists", () => {
    expect(Object.keys(AGENT_CONTEXT_CONTRACTS).sort()).toEqual([
      "coding-manager",
      "component-worker",
      "repair-worker",
      "runtime-llm",
      "user-intent",
    ]);

    const worker = AGENT_CONTEXT_CONTRACTS["component-worker"];
    expect(worker.dynamic).toContain("Assigned component/scope.");
    expect(worker.justInTime).toContain("Selected platform API help.");
    expect(worker.neverRepeat).toContain("Raw user conversation.");
    expect(worker.neverRepeat).toContain("Whole-app HTML by default.");

    const runtime = AGENT_CONTEXT_CONTRACTS["runtime-llm"];
    expect(runtime.dynamic).toEqual(["The runtime prompt supplied by the app."]);
    expect(runtime.neverRepeat).toContain("Coding transcript.");
  });

  it("hands durable coordination state back without replaying a worker transcript", () => {
    const handoff = compactWorkerHandoff({
      status: "blocked",
      scope: "#timer-controls",
      changed: ["Added reset control"],
      verified: ["Existing start/pause controls still work"],
      unresolved: ["Shared timer store needs a reset() method"],
      sharedContractChanges: [{
        kind: "state",
        path: "application.store.timer.reset",
        description: "Manager must expose a durable reset contract",
      }],
    });

    expect(JSON.parse(handoff)).toEqual({
      status: "blocked",
      scope: "#timer-controls",
      changed: ["Added reset control"],
      verified: ["Existing start/pause controls still work"],
      unresolved: ["Shared timer store needs a reset() method"],
      sharedContractChanges: [{
        kind: "state",
        path: "application.store.timer.reset",
        description: "Manager must expose a durable reset contract",
      }],
    });
    expect(handoff).not.toContain("transcript");
  });
});
