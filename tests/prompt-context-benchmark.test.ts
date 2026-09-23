import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_CONTRACTS, compactWorkerHandoff } from "../src/shell/core/agent-context";
import {
  PROMPT_BENCHMARK_SCENARIOS,
  PROMPT_BENCHMARK_VARIANTS,
  measurePromptBenchmarkMatrix,
} from "../src/shell/core/prompt-benchmark";

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

  it("compares production, concise-natural, and telegraphic prompt candidates on identical scenarios", () => {
    expect(PROMPT_BENCHMARK_VARIANTS.map(variant => variant.id)).toEqual([
      "baseline",
      "concise-natural",
      "telegraphic",
    ]);

    const matrix = measurePromptBenchmarkMatrix(value => value.length);
    expect(matrix).toHaveLength(PROMPT_BENCHMARK_SCENARIOS.length * PROMPT_BENCHMARK_VARIANTS.length);

    for (const scenario of PROMPT_BENCHMARK_SCENARIOS) {
      const rows = matrix.filter(row => row.scenario === scenario.id);
      const baseline = rows.find(row => row.variant === "baseline")!;
      const concise = rows.find(row => row.variant === "concise-natural")!;
      const telegraphic = rows.find(row => row.variant === "telegraphic")!;

      // Only the stable system wording changes in this matrix; task context stays identical.
      expect(baseline.mandatoryTokens).toBe(concise.mandatoryTokens);
      expect(concise.mandatoryTokens).toBe(telegraphic.mandatoryTokens);
      expect(baseline.historyTokens).toBe(concise.historyTokens);
      expect(concise.historyTokens).toBe(telegraphic.historyTokens);

      expect(concise.systemTokens).toBeLessThan(baseline.systemTokens);
      expect(telegraphic.systemTokens).toBeLessThan(concise.systemTokens);

      for (const row of rows) {
        expect(row.estimatedInputTokens).toBe(
          row.systemTokens
          + row.mandatoryTokens
          + row.observationTokens
          + row.environmentObservationTokens
          + row.historyTokens,
        );
      }
    }
  });

  it("keeps telegraphic wording experimental rather than a production recommendation", () => {
    const telegraphic = PROMPT_BENCHMARK_VARIANTS.find(variant => variant.id === "telegraphic")!;
    expect(telegraphic.intent).toMatch(/Experimental compression candidate/);
    expect(telegraphic.intent).toMatch(/must not be treated as quality evidence/);
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
    expect(worker.justInTime).toContain("Selected capability help needed by this task.");
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
      sharedContractChanges: ["Manager must expose timer.reset()"],
    });

    expect(JSON.parse(handoff)).toEqual({
      status: "blocked",
      scope: "#timer-controls",
      changed: ["Added reset control"],
      verified: ["Existing start/pause controls still work"],
      unresolved: ["Shared timer store needs a reset() method"],
      sharedContractChanges: ["Manager must expose timer.reset()"],
    });
    expect(handoff).not.toContain("transcript");
  });
});
