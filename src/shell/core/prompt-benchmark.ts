import { buildModelContext, conservativeTokenEstimate, type BuiltContext, type TokenCounter } from "./context";
import { CODING_WORKER_SYSTEM_PROMPT } from "./prompts";
import type { HistoryEntry, ModelConfig } from "./types";

export type PromptBenchmarkVariantId = "production-worker" | "minimal-console";
export const PROMPT_ROBUSTNESS_COMPUTE = "low" as const;

export interface PromptBenchmarkVariant {
  id: PromptBenchmarkVariantId;
  systemPrompt: string;
  intent: string;
}

export interface PromptBenchmarkScenario {
  id:
    | "simple-build"
    | "multi-component-build"
    | "runtime-repair"
    | "existing-app-change"
    | "runtime-llm";
  appPrompt: string;
  technicalIntent: string;
  observation?: string;
  history: HistoryEntry[];
}

export interface PromptBenchmarkMeasurement {
  variant: PromptBenchmarkVariantId;
  scenario: PromptBenchmarkScenario["id"];
  estimatedInputTokens: number;
  systemTokens: number;
  mandatoryTokens: number;
  observationTokens: number;
  environmentObservationTokens: number;
  evidenceTokens: number;
  historyTokens: number;
  includedHistoryCount: number;
  omittedHistoryCount: number;
}

const MINIMAL_CONSOLE_PROMPT = `You edit one assigned live-browser component through a JavaScript console.
Return one complete JavaScript program per turn. The full response executes once; use returned value, console output, or error on the next turn when inspection is needed.
Modify only component and descendants. Durable data belongs in application.store; durable behavior must be reconstructable after reload. Do not mutate fake user data to verify.
Do not edit shell-owned lifecycle state. Use supplied API help; do not invent APIs.
Finish only after acceptance criteria work: return agent.done(JSON.stringify(handoff)).`;

export const PROMPT_BENCHMARK_VARIANTS: readonly PromptBenchmarkVariant[] = Object.freeze([
  {
    id: "production-worker",
    systemPrompt: CODING_WORKER_SYSTEM_PROMPT,
    intent: "Current production component-worker console contract.",
  },
  {
    id: "minimal-console",
    systemPrompt: MINIMAL_CONSOLE_PROMPT,
    intent: "Experimental minimal console contract; compare quality under Low compute before adopting further compression.",
  },
]);

const appId = "benchmark-app";

function technicalHistory(...contents: string[]): HistoryEntry[] {
  return contents.map((content, index) => ({
    id: index + 1,
    appId,
    timestamp: index + 1,
    role: index % 2 === 0 ? "agent" : "observation",
    kind: index % 2 === 0 ? "javascript" : "execution",
    content,
  }));
}

export const PROMPT_BENCHMARK_SCENARIOS: readonly PromptBenchmarkScenario[] = Object.freeze([
  {
    id: "simple-build",
    appPrompt: "A stopwatch with start, pause, reset, and lap controls.",
    technicalIntent: [
      "TECHNICAL INTENT",
      "GOAL",
      "Build the first usable stopwatch.",
      "ACCEPTANCE CRITERIA",
      "- Start advances elapsed time.",
      "- Pause freezes elapsed time.",
      "- Reset returns elapsed time to zero.",
    ].join("\n"),
    history: [],
  },
  {
    id: "multi-component-build",
    appPrompt: "A chord practice app with exercise controls, progress, settings, and a responsive visual fretboard.",
    technicalIntent: [
      "TECHNICAL INTENT",
      "GOAL",
      "Build the first usable chord practice workflow.",
      "CONSTRAINTS",
      "- Keep shared tempo and exercise state consistent across components.",
      "- Make each visible control functional before completion.",
    ].join("\n"),
    history: technicalHistory(
      "Created semantic page scaffold with exercise, fretboard, and progress regions.",
      "Observed all three regions; fretboard still has no exercise state.",
      "Added shared durable exercise state and wired the exercise controls.",
      "Observed progress region rendering but missing completion update.",
    ),
  },
  {
    id: "runtime-repair",
    appPrompt: "A stopwatch.",
    technicalIntent: [
      "TECHNICAL INTENT",
      "GOAL",
      "Repair the restored stopwatch so Start works again.",
      "CONSTRAINTS",
      "- Preserve elapsed time and existing laps.",
    ].join("\n"),
    observation: "ReferenceError: stopwatchApp is not defined while restored setup initializes.",
    history: technicalHistory(
      "return document.querySelector('#itsalive-root');",
      "The root contains stopwatch bindings but setup state is missing.",
      "return document.querySelector('#itsalive-root');",
    ),
  },
  {
    id: "existing-app-change",
    appPrompt: "A reading tracker with books, progress, and notes.",
    technicalIntent: [
      "TECHNICAL INTENT",
      "GOAL",
      "Add a compact filter for unread books.",
      "CONSTRAINTS",
      "- Do not alter existing notes or progress.",
      "- Preserve the current visual hierarchy.",
    ].join("\n"),
    history: technicalHistory(
      "Existing app has book cards and a shared application store.",
      "Latest verification confirms note editing and progress controls work.",
    ),
  },
  {
    id: "runtime-llm",
    appPrompt: "A button that generates a new short poem on click.",
    technicalIntent: [
      "TECHNICAL INTENT",
      "GOAL",
      "Use the native runtime LLM capability to generate a fresh poem after each click.",
      "SELECTED PLATFORM API HELP",
      "application.ai.text / choose / score / decide / probability",
    ].join("\n"),
    history: [],
  },
]);

const BENCHMARK_MODEL: ModelConfig = {
  provider: "benchmark",
  model: "benchmark",
  maxContextTokens: 128_000,
  outputHeadroomTokens: 8_192,
  historyContextTokens: 12_000,
  observationHeadroomTokens: 1_024,
};

export function measurePromptBenchmark(
  variant: PromptBenchmarkVariant,
  scenario: PromptBenchmarkScenario,
  countTokens: TokenCounter = conservativeTokenEstimate,
): PromptBenchmarkMeasurement {
  const context = buildModelContext({
    model: BENCHMARK_MODEL,
    appPrompt: scenario.appPrompt,
    trigger: scenario.technicalIntent,
    observation: scenario.observation,
    history: scenario.history,
    systemPrompt: variant.systemPrompt,
    countTokens,
  });
  return measurement(variant.id, scenario.id, context);
}

export function measurePromptBenchmarkMatrix(
  countTokens: TokenCounter = conservativeTokenEstimate,
): PromptBenchmarkMeasurement[] {
  return PROMPT_BENCHMARK_SCENARIOS.flatMap(scenario =>
    PROMPT_BENCHMARK_VARIANTS.map(variant => measurePromptBenchmark(variant, scenario, countTokens)),
  );
}

function measurement(
  variant: PromptBenchmarkVariantId,
  scenario: PromptBenchmarkScenario["id"],
  context: BuiltContext,
): PromptBenchmarkMeasurement {
  return {
    variant,
    scenario,
    estimatedInputTokens: context.estimatedInputTokens,
    systemTokens: context.tokenBreakdown.system,
    mandatoryTokens: context.tokenBreakdown.mandatory,
    observationTokens: context.tokenBreakdown.observation,
    environmentObservationTokens: context.tokenBreakdown.environmentObservation,
    evidenceTokens: context.tokenBreakdown.evidence,
    historyTokens: context.tokenBreakdown.history,
    includedHistoryCount: context.includedHistoryIds.length,
    omittedHistoryCount: context.omittedHistoryCount,
  };
}
