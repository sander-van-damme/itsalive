import { buildModelContext, type TokenCounter } from "./context";
import { databaseAgentHistory, type AgentHistoryStore } from "./agent-history";
import type { ShellDatabase } from "./database";
import type { Credential, LlmContextTrace, LlmTraceIdentity, ModelConfig } from "./types";
import type { ProviderRegistry } from "./providers";
import { sanitizeDiagnostic } from './diagnostics';
import { createAgentTimeout } from "./run-lifecycle";
import { RunBudgetController, runBudgetMessage, type RunBudgetLimits, type RunBudgetStopKind } from "./run-budget";

export interface ExecutionResult {
  value?: unknown;
  error?: { message: string; stack?: string; logs?: unknown[] };
  done?: boolean;
  message?: string;
}

export interface AppExecutor {
  execute(appId: string, code: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<ExecutionResult>;
}

export type AgentProgressPhase = "generating" | "executing" | "repairing" | "verifying" | "finishing";
export interface AgentProgress { phase: AgentProgressPhase; turn: number; step?: number; }

export interface AgentContextDiagnostic extends LlmContextTrace {
  estimatedInputTokens: number;
  maxContextTokens: number;
}

export interface RunOptions {
  appId: string;
  appPrompt: string;
  behaviorSummary?: string;
  trigger: string;
  model: ModelConfig;
  /** Optional role-specific stable prompt. Defaults to the production coding system prompt. */
  systemPrompt?: string;
  /** Optional isolated history store. Defaults to durable shell history. */
  history?: AgentHistoryStore;
  /** Simple CSS selector for a worker-owned component scope. */
  scopeSelector?: string;
  /** Hierarchical identity used to attribute every provider request in this run. */
  trace?: LlmTraceIdentity;
  credential?: Credential;
  /** Run policy. Turns are telemetry; emergencyTurnCeiling is only a runaway guard. */
  budget?: Partial<RunBudgetLimits>;
  /** Future manager/workers may pass a child controller sharing the parent spend ledger. */
  budgetController?: RunBudgetController;
  executionTimeoutMs?: number;
  maxObservationCharacters?: number;
  countTokens?: TokenCounter;
  signal?: AbortSignal;
  persistTrigger?: boolean;
  /** Consumed automatically immediately before each model turn. */
  consumeEnvironmentObservations?: () => string[];
  /** Safe lifecycle signal for shell UI. Never contains model reasoning or generated text. */
  onProgress?: (progress: AgentProgress) => void;
  /** Latest input composition for user-facing and exported context diagnostics. */
  onContext?: (context: AgentContextDiagnostic) => void;
}

export interface RunResult {
  status: "done" | RunBudgetStopKind;
  message?: string;
  /** Unsanitized done() payload for structured worker handoff parsing. */
  rawMessage?: string;
  turns: number;
}

export const DEFAULT_AGENT_RUN_BUDGET: RunBudgetLimits = Object.freeze({
  idleTimeoutMs: 120_000,
  maxDurationMs: 10 * 60_000,
  maxCostUsd: null,
  maxConsecutiveFailures: 3,
  stallRepeatLimit: 2,
  emergencyTurnCeiling: 1_000,
});
const PROGRESS_INSPECTION = 'return document.getElementById("itsalive-root")?.outerHTML ?? document.body.innerHTML;';

function progressInspection(options: RunOptions): string {
  if (!options.scopeSelector) return PROGRESS_INSPECTION;
  return `return document.querySelector(${JSON.stringify(options.scopeSelector)})?.outerHTML ?? null;`;
}
const COMPLETION_INSPECTION = `
const root = document.getElementById("itsalive-root");
const durabilityAudit = window["__itsaliveRuntimeDurabilityAuditV1"];
const durability = typeof durabilityAudit === "function" ? durabilityAudit() : undefined;
const outsideUiCount = Array.from(document.body.childNodes).filter(node => {
  if (node === root || node.nodeType === Node.COMMENT_NODE) return false;
  if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent?.trim());
  if (!(node instanceof Element)) return false;
  return !node.matches('[data-app-runtime], script, style, link, template, noscript');
}).length;
return {
  rootHtml: root?.innerHTML ?? null,
  rootCount: document.querySelectorAll('[id="itsalive-root"]').length,
  outsideUiCount,
  buildingCount: root ? root.querySelectorAll('[data-itsalive-building]').length + (root.matches('[data-itsalive-building]') ? 1 : 0) : 0,
  runtimeOnlyEventListenerCount: durability?.runtimeOnlyEventListenerCount ?? 0,
};
`;

class GeneratedCodeError extends Error {
  constructor(readonly phase: "format" | "compile", message: string) {
    super(message);
    this.name = "GeneratedCodeError";
  }
}

export class AgentRunner {
  constructor(private readonly db: ShellDatabase, private readonly providers: ProviderRegistry, private readonly executor: AppExecutor) {}

  async run(options: RunOptions): Promise<RunResult> {
    const historyStore = options.history ?? databaseAgentHistory(this.db);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const startedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - startedAt);
    let lastProgressAt = startedAt;
    let firstProviderActivityMs: number | undefined;
    let firstStreamTextMs: number | undefined;
    let firstCompleteCommandMs: number | undefined;
    let firstExecutionMs: number | undefined;
    const recordMilestone = (milestone: string): number => {
      const elapsed = elapsedMs();
      console.info('Timing milestone', { milestone, elapsedMs: elapsed });
      return elapsed;
    };
    if (options.budget && options.budgetController) throw new Error("Provide either budget or budgetController, not both");
    const budget = options.budgetController ?? new RunBudgetController({ ...DEFAULT_AGENT_RUN_BUDGET, ...options.budget });
    const { idleTimeoutMs, maxDurationMs } = budget.limits;
    let idleDeadline: ReturnType<typeof setTimeout> | undefined;
    const touchProgress = () => {
      if (controller.signal.aborted) return;
      lastProgressAt = performance.now();
      if (idleDeadline) clearTimeout(idleDeadline);
      idleDeadline = setTimeout(() => controller.abort(createAgentTimeout("idle-timeout")), idleTimeoutMs);
    };
    touchProgress();
    const timeBudgetDeadline = setTimeout(() => controller.abort(createAgentTimeout("time-budget")), maxDurationMs);
    let observation: string | undefined;
    let environmentObservation: string | undefined;
    let repeatedLowSignalObservation: string | undefined;
    let repeatedLowSignalState: string | undefined;
    console.groupCollapsed(`[itsalive:agent] Run · ${options.appId}`);
    console.info('Run start', {
      trigger: sanitizeDiagnostic(options.trigger),
      provider: options.model.provider,
      model: options.model.model,
      budget: budget.snapshot(),
      trace: options.trace,
    });
    recordMilestone('request-started');
    try {
      if (options.persistTrigger !== false) await historyStore.append({ appId: options.appId, role: "user", kind: "chat", content: options.trigger });
      for (let turn = 1; ; turn++) {
        const turnStop = budget.startTurn(turn);
        if (turnStop) return budgetStopResult(turnStop, turn - 1, budget);
        console.groupCollapsed(`[itsalive:agent] Turn ${turn}`);
        try {
          if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
          touchProgress();
          reportProgress(options, "generating", turn);
          const pushed = options.consumeEnvironmentObservations?.() ?? [];
          if (pushed.length) environmentObservation = [environmentObservation, ...pushed].filter(Boolean).join("\n\n");
          const history = await historyStore.list(options.appId);
          const context = buildModelContext({
            model: options.model,
            appPrompt: options.appPrompt,
            behaviorSummary: options.behaviorSummary,
            trigger: options.trigger,
            observation,
            environmentObservation,
            history,
            ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
            countTokens: options.countTokens,
          });
          environmentObservation = undefined;
          const traceContext: AgentContextDiagnostic = {
            turn,
            configuredHistoryTokens: options.model.historyContextTokens,
            effectiveHistoryBudget: context.historyTokenBudget,
            selectedHistoryTokens: context.historyTokens,
            estimatedInputTokens: context.estimatedInputTokens,
            includedHistoryCount: context.includedHistoryIds.length,
            omittedHistoryCount: context.omittedHistoryCount,
            modelContextTokens: options.model.maxContextTokens,
            sources: context.tokenBreakdown,
            maxContextTokens: options.model.maxContextTokens,
          };
          options.onContext?.(traceContext);
          console.info('Context', {
            provider: options.model.provider,
            model: options.model.model,
            modelContextTokens: options.model.maxContextTokens,
            configuredHistoryTokens: options.model.historyContextTokens,
            selectedHistoryTokens: context.historyTokens,
            effectiveHistoryBudget: context.historyTokenBudget,
            estimatedInputTokens: context.estimatedInputTokens,
            messageCount: context.messages.length,
            includedHistoryCount: context.includedHistoryIds.length,
            omittedHistoryCount: context.omittedHistoryCount,
            hasObservation: Boolean(observation),
          });
          const commandParser = new StreamedCommandParser();
          let streamedResult: ExecutionResult | undefined;
          let streamedObservation: string | undefined;
          let streamedCodeError: GeneratedCodeError | undefined;
          let streamedRuntimeError: unknown;
          let streamedCommands = 0;
          let executionQueue = Promise.resolve();

          const enqueueCommand = (code: string) => {
            streamedCommands++;
            const commandNumber = streamedCommands;
            executionQueue = executionQueue.then(async () => {
              if (streamedCodeError || streamedRuntimeError || streamedResult?.done || streamedResult?.error) return;
              try {
                validateExecutableJavaScript(code);
              } catch (error) {
                streamedCodeError = error instanceof GeneratedCodeError
                  ? error
                  : new GeneratedCodeError("compile", error instanceof Error ? error.message : String(error));
                return;
              }
              try {
                touchProgress();
                if (firstExecutionMs == null) firstExecutionMs = recordMilestone('first-runtime-execution');
                reportProgress(options, "executing", turn, commandNumber);
                const executed = await executeGeneratedCommand(historyStore, this.executor, options, controller.signal, code);
                touchProgress();
                streamedResult = executed.result;
                streamedObservation = executed.observation;
              } catch (error) {
                streamedRuntimeError = error;
              }
            });
          };

          let generated;
          let pendingCostStop: RunBudgetStopKind | undefined;
          try {
            generated = await generateWithStreaming(
              this.providers,
              {
                purpose: `agent turn ${turn}`,
                model: options.model,
                system: context.system,
                messages: context.messages,
                ...(options.trace ? { trace: { ...options.trace, turn, context: traceContext } } : {}),
                signal: controller.signal,
              },
              options.credential,
              delta => {
                if (delta) {
                  touchProgress();
                  if (firstStreamTextMs == null) firstStreamTextMs = recordMilestone('first-stream-text');
                }
                const commands = commandParser.push(delta);
                if (commands.length && firstCompleteCommandMs == null) firstCompleteCommandMs = recordMilestone('first-complete-command');
                for (const code of commands) enqueueCommand(code);
              },
              () => {
                touchProgress();
                if (firstProviderActivityMs == null) firstProviderActivityMs = recordMilestone('first-provider-activity');
              },
            );
            await executionQueue;
            touchProgress();
            pendingCostStop = budget.recordUsage(generated.usage?.cost);
          } catch (error) {
            console.error('Model request failed', diagnosticError(error));
            if (controller.signal.aborted) throw controller.signal.reason ?? error;
            throw error;
          }
          if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
          if (streamedRuntimeError) throw streamedRuntimeError;

          let result: ExecutionResult;
          if (commandParser.usesProtocol) {
            try {
              commandParser.finish();
              if (streamedCodeError) throw streamedCodeError;
              if (!streamedCommands || !streamedResult) throw new GeneratedCodeError("format", "Model returned no complete streamed commands");
              budget.recordSuccess("generation");
            } catch (error) {
              const generatedError = error instanceof GeneratedCodeError
                ? error
                : new GeneratedCodeError("format", error instanceof Error ? error.message : String(error));
              observation = generatedCodeObservation(generatedError);
              const failureStop = budget.recordFailure("generation");
              console.warn('Generated command stream rejected', sanitizeDiagnostic({
                phase: generatedError.phase,
                message: generatedError.message,
                consecutiveFailures: budget.snapshot().consecutiveFailures.generation,
              }));
              await historyStore.append({ appId: options.appId, role: "observation", kind: "error", content: observation });
              if (pendingCostStop) return budgetStopResult(pendingCostStop, turn, budget);
              if (failureStop) return budgetStopResult(failureStop, turn, budget);
              repeatedLowSignalObservation = undefined;
              repeatedLowSignalState = undefined;
              reportProgress(options, "repairing", turn);
              console.info('Turn outcome', { kind: 'generation-repair', phase: generatedError.phase });
              console.info('Continuing to next turn for streamed command repair');
              continue;
            }
            result = streamedResult!;
            observation = streamedObservation;
          } else {
            let code: string;
            try {
              code = extractExecutableJavaScript(generated.text);
              validateExecutableJavaScript(code);
              budget.recordSuccess("generation");
            } catch (error) {
              const generatedError = error instanceof GeneratedCodeError
                ? error
                : new GeneratedCodeError("compile", error instanceof Error ? error.message : String(error));
              observation = generatedCodeObservation(generatedError);
              const failureStop = budget.recordFailure("generation");
              console.warn('Generated code rejected before execution', sanitizeDiagnostic({
                phase: generatedError.phase,
                message: generatedError.message,
                consecutiveFailures: budget.snapshot().consecutiveFailures.generation,
              }));
              await historyStore.append({ appId: options.appId, role: "observation", kind: "error", content: observation });
              if (pendingCostStop) return budgetStopResult(pendingCostStop, turn, budget);
              if (failureStop) return budgetStopResult(failureStop, turn, budget);
              repeatedLowSignalObservation = undefined;
              repeatedLowSignalState = undefined;
              reportProgress(options, "repairing", turn);
              console.info('Turn outcome', { kind: 'generation-repair', phase: generatedError.phase });
              console.info('Continuing to next turn for code repair');
              continue;
            }
            touchProgress();
            if (firstCompleteCommandMs == null) firstCompleteCommandMs = recordMilestone('first-complete-command');
            if (firstExecutionMs == null) firstExecutionMs = recordMilestone('first-runtime-execution');
            reportProgress(options, "executing", turn, 1);
            const executed = await executeGeneratedCommand(historyStore, this.executor, options, controller.signal, code);
            touchProgress();
            result = executed.result;
            observation = executed.observation;
          }

          if (result.error) {
            if (pendingCostStop) return budgetStopResult(pendingCostStop, turn, budget);
            const failureStop = budget.recordFailure("runtime");
            reportProgress(options, "repairing", turn);
            repeatedLowSignalObservation = undefined;
            repeatedLowSignalState = undefined;
            budget.clearStall();
            console.info('Turn outcome', {
              kind: 'runtime-repair',
              consecutiveFailures: budget.snapshot().consecutiveFailures.runtime,
            });
            if (failureStop) return budgetStopResult(failureStop, turn, budget);
            console.info('A command failed; continuing to next turn for repair');
            continue;
          }
          budget.recordSuccess("runtime");

          if (result.done) {
            reportProgress(options, "verifying", turn);
            const arrivedBeforeCompletion = options.consumeEnvironmentObservations?.() ?? [];
            if (arrivedBeforeCompletion.length) {
              environmentObservation = arrivedBeforeCompletion.join("\n\n");
              console.info("Environmental observation arrived before completion; continuing");
              continue;
            }
            const completion = await verifyCompletion(this.executor, options, controller.signal);
            if (!completion.ok) {
              observation = JSON.stringify({ completionCheck: { ok: false, reason: completion.reason } });
              repeatedLowSignalObservation = undefined;
              repeatedLowSignalState = undefined;
              reportProgress(options, "repairing", turn);
              console.warn('Completion check rejected', sanitizeDiagnostic(completion));
              await historyStore.append({ appId: options.appId, role: "observation", kind: "error", content: observation });
              if (pendingCostStop) return budgetStopResult(pendingCostStop, turn, budget);
              const failureStop = budget.recordFailure("verification");
              console.info('Turn outcome', {
                kind: 'verification-repair',
                consecutiveFailures: budget.snapshot().consecutiveFailures.verification,
              });
              if (failureStop) return budgetStopResult(failureStop, turn, budget);
              console.info('Continuing to next turn after incomplete done()');
              continue;
            }
            budget.recordSuccess("verification");
            const completionMessage = userFacingCompletionMessage(result.message);
            if (completionMessage) await historyStore.append({ appId: options.appId, role: "assistant", kind: "chat", content: completionMessage });
            reportProgress(options, "finishing", turn);
            console.info('Turn outcome', { kind: 'done' });
            console.info('Run done', sanitizeDiagnostic({ turn, message: completionMessage }));
            return { status: "done", message: completionMessage, ...(result.message ? { rawMessage: result.message } : {}), turns: turn };
          }

          if (pendingCostStop) return budgetStopResult(pendingCostStop, turn, budget);

          const rawObservation = observation;
          if (rawObservation && isLowSignalObservation(rawObservation)) {
            if (rawObservation === repeatedLowSignalObservation) {
              const runtimeState = await inspectRuntimeProgress(this.executor, options, controller.signal);
              if (runtimeState && repeatedLowSignalState && runtimeState === repeatedLowSignalState) {
                const stop = budget.recordStall();
                if (stop) {
                  const message = 'Repeated verification produced the same low-signal result without changing #itsalive-root.';
                  observation = `${rawObservation}\n\nPlatform diagnostic: ${message}`;
                  await historyStore.append({ appId: options.appId, role: "observation", kind: "error", content: observation });
                  console.warn('Verification stalled', { turn, kind: 'verification-stall', budget: budget.snapshot() });
                  return budgetStopResult(stop, turn, budget, message);
                }
              } else if (repeatedLowSignalState && runtimeState !== repeatedLowSignalState) {
                budget.clearStall();
              }
              if (!repeatedLowSignalState) budget.recordStall();
              repeatedLowSignalState = runtimeState;
              const diagnostic = 'Platform diagnostic: this verification returned the same low-signal result again. Do not repeat the same probe. Inspect #itsalive-root or use a different selector/diagnostic before continuing.';
              observation = `${rawObservation}\n\n${diagnostic}`;
              await historyStore.append({ appId: options.appId, role: "observation", kind: "error", content: observation });
              console.warn('Repeated low-signal verification', { turn, kind: 'verification-repair' });
            } else {
              repeatedLowSignalObservation = rawObservation;
              repeatedLowSignalState = undefined;
              budget.clearStall();
            }
          } else {
            repeatedLowSignalObservation = undefined;
            repeatedLowSignalState = undefined;
            budget.clearStall();
          }
          console.info('Turn outcome', { kind: 'construction' });
          console.info('Continuing to next turn');
        } finally {
          console.groupEnd();
        }
      }
    } catch (error) {
      console.error('Agent run failed', diagnosticError(error));
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw error;
    } finally {
      if (idleDeadline) clearTimeout(idleDeadline);
      clearTimeout(timeBudgetDeadline);
      options.signal?.removeEventListener("abort", abort);
      const totalMs = elapsedMs();
      console.info('Timing summary', {
        trace: options.trace,
        totalMs,
        firstProviderActivityMs,
        firstStreamTextMs,
        firstCompleteCommandMs,
        firstExecutionMs,
        lastProgressMs: Math.round(lastProgressAt - startedAt),
        budget: budget.snapshot(),
      });
      console.info(`Run finished (${totalMs}ms)`, { aborted: controller.signal.aborted, budget: budget.snapshot() });
      console.groupEnd();
    }
  }
}

function budgetStopResult(
  status: RunBudgetStopKind,
  turns: number,
  budget: RunBudgetController,
  message = runBudgetMessage(status),
): RunResult {
  console.warn('Run budget stop', { status, turns, budget: budget.snapshot() });
  return { status, message, turns };
}

const TECHNICAL_COMPLETION = /(?:\b(?:AudioContext|DOM|API|JavaScript|Alpine|Tailwind|IndexedDB|localStorage|event listener|browser API|CSS|HTML)\b|prefers-reduced-motion|confirmation toast|aria-[\w-]+|x-[\w-]+)/i;

function userFacingCompletionMessage(message: string | undefined): string | undefined {
  const normalized = message?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length > 240 || TECHNICAL_COMPLETION.test(normalized)) return 'Done — it’s ready.';
  return normalized;
}

function reportProgress(options: RunOptions, phase: AgentProgressPhase, turn: number, step?: number): void {
  try { options.onProgress?.({ phase, turn, ...(step == null ? {} : { step }) }); }
  catch (error) { console.warn("Agent progress callback failed", diagnosticError(error)); }
}

const COMMAND_START = "/* itsalive:command */";
const COMMAND_END = "/* itsalive:end */";

class StreamedCommandParser {
  private buffer = "";
  private protocol = false;

  get usesProtocol(): boolean { return this.protocol; }

  push(delta: string): string[] {
    this.buffer += delta;
    const commands: string[] = [];
    while (true) {
      const start = this.buffer.indexOf(COMMAND_START);
      if (start < 0) return commands;
      this.protocol = true;
      if (start > 0) this.buffer = this.buffer.slice(start);
      const end = this.buffer.indexOf(COMMAND_END, COMMAND_START.length);
      if (end < 0) return commands;
      const code = this.buffer.slice(COMMAND_START.length, end).trim();
      this.buffer = this.buffer.slice(end + COMMAND_END.length);
      if (code) commands.push(code);
    }
  }

  finish(): void {
    if (!this.protocol) return;
    if (this.buffer.trim()) throw new GeneratedCodeError("format", "Model stream ended with an incomplete command or trailing content");
  }
}

async function generateWithStreaming(
  providers: ProviderRegistry,
  request: Parameters<ProviderRegistry["generate"]>[0],
  credential: Credential | undefined,
  onText: (delta: string) => void,
  onActivity?: () => void,
) {
  const streaming = (providers as ProviderRegistry & {
    generateStreaming?: (request: Parameters<ProviderRegistry["generate"]>[0], onText: (delta: string) => void, credential?: Credential, onActivity?: () => void) => ReturnType<ProviderRegistry["generate"]>;
  }).generateStreaming;
  if (typeof streaming === "function") return streaming.call(providers, request, onText, credential, onActivity);
  const result = await providers.generate(request, credential);
  onActivity?.();
  if (result.text) onText(result.text);
  return result;
}

async function executeGeneratedCommand(
  history: AgentHistoryStore,
  executor: AppExecutor,
  options: RunOptions,
  signal: AbortSignal,
  code: string,
): Promise<{ result: ExecutionResult; observation: string }> {
  console.info('Executable JavaScript', sanitizeDiagnostic(code));
  await history.append({ appId: options.appId, role: "agent", kind: "javascript", content: code });
  const executable = options.scopeSelector ? scopeCommand(code, options.scopeSelector) : code;
  const executionStartedAt = performance.now();
  let result: ExecutionResult;
  try {
    result = await executor.execute(options.appId, executable, { signal, timeoutMs: options.executionTimeoutMs ?? 30_000 });
  } catch (error) {
    console.error(`Runtime execution failed (${Math.round(performance.now() - executionStartedAt)}ms)`, diagnosticError(error));
    throw error;
  }
  console.info(`Runtime result (${Math.round(performance.now() - executionStartedAt)}ms)`, sanitizeDiagnostic(result));
  if (result.error) console.error('Runtime execution error', sanitizeDiagnostic(result.error));
  const observation = boundObservation(result, options.maxObservationCharacters ?? 16_000);
  console.info('Observation', sanitizeDiagnostic(observation));
  await history.append({ appId: options.appId, role: "observation", kind: result.error ? "error" : "execution", content: observation });
  return { result, observation };
}

function scopeCommand(code: string, selector: string): string {
  const encoded = JSON.stringify(selector);
  return `
const component = document.querySelector(${encoded});
if (!(component instanceof Element)) throw new Error("Assigned component scope not found: " + ${encoded});
return await (async (component) => {
${code}
})(component);
`;
}

function extractExecutableJavaScript(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new GeneratedCodeError("format", "Model returned an empty response");

  const fences = [...trimmed.matchAll(/```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)```/gi)];
  if (fences.length === 1) {
    const code = fences[0]![1]!.trim();
    if (!code) throw new GeneratedCodeError("format", "Model returned an empty JavaScript code block");
    return code;
  }
  if (fences.length > 1) throw new GeneratedCodeError("format", "Model returned multiple code blocks; expected one executable JavaScript program");
  if (trimmed.includes("```")) throw new GeneratedCodeError("format", "Model returned a fenced response that was not a single JavaScript code block");
  return trimmed;
}

function validateExecutableJavaScript(code: string): void {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction(`"use strict";\n${code}`);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new GeneratedCodeError("compile", message);
  }
}

function generatedCodeObservation(error: GeneratedCodeError): string {
  const label = error.phase === "format" ? "Generated response was not usable JavaScript" : "Generated JavaScript did not parse";
  return `${label}:\n${error.message}\nReturn complete executable JavaScript commands wrapped with /* itsalive:command */ and /* itsalive:end */. Do not add prose or Markdown fences.`;
}

async function inspectRuntimeProgress(executor: AppExecutor, options: RunOptions, signal: AbortSignal): Promise<string | undefined> {
  try {
    const inspection = await executor.execute(options.appId, progressInspection(options), {
      signal,
      timeoutMs: Math.min(options.executionTimeoutMs ?? 30_000, 5_000),
    });
    return !inspection.error && typeof inspection.value === "string" ? inspection.value : undefined;
  } catch (error) {
    console.warn('Progress inspection failed; continuing without stall detection', diagnosticError(error));
    return undefined;
  }
}

async function verifyCompletion(executor: AppExecutor, options: RunOptions, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (options.scopeSelector) return verifyScopedCompletion(executor, options, signal);
    const inspection = await executor.execute(options.appId, COMPLETION_INSPECTION, {
      signal,
      timeoutMs: Math.min(options.executionTimeoutMs ?? 30_000, 5_000),
    });
    if (inspection.error) return { ok: true };
    if (isCompletionSnapshot(inspection.value)) {
      if (inspection.value.rootCount !== 1 || inspection.value.rootHtml === null) {
        return { ok: false, reason: "the app must preserve exactly one canonical #itsalive-root" };
      }
      if (inspection.value.outsideUiCount > 0) {
        return { ok: false, reason: "user-visible UI exists outside the canonical #itsalive-root" };
      }
      if ((inspection.value.buildingCount ?? 0) > 0) {
        return { ok: false, reason: "the app still contains a data-itsalive-building scaffold; activate it before calling done()" };
      }
      if ((inspection.value.runtimeOnlyEventListenerCount ?? 0) > 0) {
        const count = inspection.value.runtimeOnlyEventListenerCount ?? 0;
        return { ok: false, reason: `the app still depends on ${count} runtime-only event listener${count === 1 ? "" : "s"} installed by an agent command; move that behavior into Alpine directives or persisted <script> setup that runs again after restore` };
      }
      return assessCompletionTree(inspection.value.rootHtml);
    }
    if (typeof inspection.value === "string") return assessCompletionTree(inspection.value);
    return { ok: true };
  } catch (error) {
    console.warn('Completion inspection failed; accepting done()', diagnosticError(error));
    return { ok: true };
  }
}


async function verifyScopedCompletion(
  executor: AppExecutor,
  options: RunOptions,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const selector = options.scopeSelector!;
  const inspection = await executor.execute(options.appId, `
const component = document.querySelector(${JSON.stringify(selector)});
return component ? {
  html: component.innerHTML,
  buildingCount: component.querySelectorAll('[data-itsalive-building]').length + (component.matches('[data-itsalive-building]') ? 1 : 0),
  inert: component.hasAttribute('inert'),
  ariaBusy: component.getAttribute('aria-busy'),
} : null;
`, {
    signal,
    timeoutMs: Math.min(options.executionTimeoutMs ?? 30_000, 5_000),
  });
  if (inspection.error) return { ok: false, reason: `could not inspect assigned component ${selector}` };
  if (!inspection.value || typeof inspection.value !== "object") return { ok: false, reason: `assigned component ${selector} no longer exists` };
  const value = inspection.value as Record<string, unknown>;
  if ((value.buildingCount as number | undefined ?? 0) > 0 || value.inert === true || value.ariaBusy === "true") {
    return { ok: false, reason: `assigned component ${selector} is still marked as building/busy` };
  }
  return assessCompletionTree(typeof value.html === "string" ? value.html : "");
}

function isCompletionSnapshot(value: unknown): value is { rootHtml: string | null; rootCount: number; outsideUiCount: number; buildingCount?: number; runtimeOnlyEventListenerCount?: number } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (typeof candidate.rootHtml === "string" || candidate.rootHtml === null)
    && typeof candidate.rootCount === "number"
    && typeof candidate.outsideUiCount === "number"
    && (candidate.buildingCount === undefined || typeof candidate.buildingCount === "number")
    && (candidate.runtimeOnlyEventListenerCount === undefined || typeof candidate.runtimeOnlyEventListenerCount === "number");
}

function isLowSignalObservation(observation: string): boolean {
  try {
    const parsed = JSON.parse(observation) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    const candidate = parsed as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(candidate, "value") && isLowSignalValue(candidate.value);
  } catch {
    return false;
  }
}

function isLowSignalValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return false;
  const values = Object.values(value as Record<string, unknown>);
  return values.length > 0 && values.every(isLowSignalValue);
}

function assessCompletionTree(html: string): { ok: true } | { ok: false; reason: string } {
  const withoutImplementation = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const text = withoutImplementation.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  const hasInteractive = /<(?:button|input|textarea|select|a)\b/i.test(withoutImplementation);
  const hasVisual = /<(?:canvas|svg|img|video|audio)\b/i.test(withoutImplementation);
  const hasStructure = /<(?:main|section|article|header|nav|form|div|ul|ol|table)\b/i.test(withoutImplementation);
  const placeholderOnly = Boolean(text) && /^(?:[\w .'-]+\s+)?(?:loading|starting|initializing|preparing|please wait)[.…! ]*$/i.test(text);

  if (placeholderOnly && !hasInteractive && !hasVisual) {
    return { ok: false, reason: "the rendered app still appears to be only a loading/initializing placeholder" };
  }
  if (!text && !hasInteractive && !hasVisual && !hasStructure) {
    return { ok: false, reason: "the app contains no meaningful rendered UI yet" };
  }
  return { ok: true };
}

function diagnosticError(error: unknown): unknown {
  return sanitizeDiagnostic(error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack, ...('diagnostic' in error ? { diagnostic: sanitizeDiagnostic(error.diagnostic) } : {}) }
    : error);
}

function boundObservation(result: ExecutionResult, max: number): string {
  let serialized: string;
  try { serialized = JSON.stringify(result, replacer); } catch { serialized = JSON.stringify({ error: { message: "Execution result was not serializable" } }); }
  if (serialized.length <= max) return serialized;
  return `${serialized.slice(0, Math.max(0, max - 31))}\n…[observation truncated]`;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("data:image/") && value.length > 1_000) return `${value.slice(0, 80)}…[image omitted]`;
  return value;
}
