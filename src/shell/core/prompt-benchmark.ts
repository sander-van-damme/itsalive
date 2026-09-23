import { buildModelContext, conservativeTokenEstimate, type BuiltContext, type TokenCounter } from "./context";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { HistoryEntry, ModelConfig } from "./types";

export type PromptBenchmarkVariantId = "baseline" | "concise-natural" | "telegraphic";

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
  historyTokens: number;
  includedHistoryCount: number;
  omittedHistoryCount: number;
}

const CONCISE_NATURAL_SYSTEM_PROMPT = `You are a coding agent editing one live browser app.

OUTPUT
Return only independently executable JavaScript commands between /* itsalive:command */ and /* itsalive:end */. Commands run as they stream and in separate AsyncFunction calls. Inspect first when needed. Only the final command may return itsalive.done(...) after verification.

APP BOUNDARY
Keep all visible UI inside the existing #itsalive-root. Do not replace that root or touch shell/runtime-owned elements. Treat the app as a persistent drawing board, not a repository.

DURABILITY
Persist behavior in app-authored setup or Alpine state/directives; transient listeners, closures, timers, and object references may disappear on restore. Setup must be idempotent. Create state/setup before dependent reactive markup when practical.

IMPLEMENTATION
Prefer semantic HTML, Tailwind, Alpine for ordinary local interaction, and native DOM APIs for focused inspection/mutation. Make targeted changes instead of regenerating the whole document. Keep responsive behavior and existing user data unless the task says otherwise.

PROGRESS
For substantial unfinished regions use data-itsalive-building + inert + aria-busy. Remove them only when the visible controls work. Verify the requested acceptance criteria before done().

CONTEXT
The technical intent is authoritative. Raw chat is intentionally absent. Detailed platform capability help is supplied only when relevant; do not invent APIs.`;

const TELEGRAPHIC_SYSTEM_PROMPT = `Live app coder. JS commands only:
/* itsalive:command */
...JS...
/* itsalive:end */
No prose/fences. Commands self-contained AsyncFunction calls. Inspect at end of response if next turn needs result. done() final command only after verify.

One app. Existing #itsalive-root = only visible root. Never replace root/touch shell runtime. Persistent drawing board.

Durability: transient listeners/closures/timers die on restore. Use Alpine/app setup; idempotent. Setup/state before dependent bindings when practical.

Build: semantic HTML; Tailwind; Alpine for local UI; native DOM for focused inspect/edit. Targeted edits, preserve unrelated UI/data, responsive.

Unfinished substantial region: data-itsalive-building + inert + aria-busy. Remove only when working. Technical intent authoritative. Raw chat absent. Use only supplied platform APIs.`;

export const PROMPT_BENCHMARK_VARIANTS: readonly PromptBenchmarkVariant[] = Object.freeze([
  {
    id: "baseline",
    systemPrompt: SYSTEM_PROMPT,
    intent: "Current production prompt; full stable platform guidance.",
  },
  {
    id: "concise-natural",
    systemPrompt: CONCISE_NATURAL_SYSTEM_PROMPT,
    intent: "Candidate: concise structured natural language while preserving core invariants.",
  },
  {
    id: "telegraphic",
    systemPrompt: TELEGRAPHIC_SYSTEM_PROMPT,
    intent: "Experimental compression candidate; token savings must not be treated as quality evidence.",
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
      "Added shared Alpine exercise state and wired the exercise controls.",
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
    observation: "ReferenceError: stopwatchApp is not defined while Alpine evaluates x-data.",
    history: technicalHistory(
      "return document.querySelector('#itsalive-root');",
      "The root contains stopwatch bindings but setup state is missing.",
      "return await itsalive.logs.get({ level: 'error', limit: 10 });",
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
      "Existing app has book cards and a shared Alpine store.",
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
      "RELEVANT PLATFORM CAPABILITIES",
      "llm.ask — await itsalive.llm.ask(prompt)",
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
    historyTokens: context.tokenBreakdown.history,
    includedHistoryCount: context.includedHistoryIds.length,
    omittedHistoryCount: context.omittedHistoryCount,
  };
}
