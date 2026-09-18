import { buildModelContext, type TokenCounter } from "./context";
import { appendHistory } from "./history";
import type { ShellDatabase } from "./database";
import type { Credential, ModelConfig, ToolSummary } from "./types";
import type { ProviderRegistry } from "./providers";
import { sanitizeDiagnostic } from './diagnostics';

export interface ExecutionResult {
  value?: unknown;
  error?: { message: string; stack?: string; logs?: unknown[] };
  done?: boolean;
  message?: string;
  screenshot?: string;
}

export interface AppExecutor {
  execute(appId: string, code: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<ExecutionResult>;
}

export interface RunOptions {
  appId: string;
  appPrompt: string;
  trigger: string;
  model: ModelConfig;
  credential?: Credential;
  tools: ToolSummary[];
  summary?: string;
  maxTurns?: number;
  maxDurationMs?: number;
  executionTimeoutMs?: number;
  maxObservationCharacters?: number;
  countTokens?: TokenCounter;
  signal?: AbortSignal;
  persistTrigger?: boolean;
  /** Consumed automatically immediately before each model turn. */
  consumeEnvironmentObservations?: () => string[];
}

export interface RunResult { status: "done" | "turn-limit"; message?: string; turns: number }

const MAX_CONSECUTIVE_GENERATION_FAILURES = 3;
const COMPLETION_INSPECTION = 'return await itsalive.dom.inspect({ maxDepth: 4, maxNodes: 80 });';

class GeneratedCodeError extends Error {
  constructor(readonly phase: "format" | "compile", message: string) {
    super(message);
    this.name = "GeneratedCodeError";
  }
}

export class AgentRunner {
  constructor(private readonly db: ShellDatabase, private readonly providers: ProviderRegistry, private readonly executor: AppExecutor) {}

  async run(options: RunOptions): Promise<RunResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => controller.abort(new DOMException("Agent run timed out", "TimeoutError")), options.maxDurationMs ?? 120_000);
    const maxTurns = options.maxTurns ?? 12;
    let observation: string | undefined;
    let environmentObservation: string | undefined;
    let consecutiveGenerationFailures = 0;
    const startedAt = performance.now();
    console.groupCollapsed(`[itsalive:agent] Run · ${options.appId}`);
    console.info('Run start', { trigger: sanitizeDiagnostic(options.trigger), provider: options.model.provider, model: options.model.model, maxTurns });
    try {
      if (options.persistTrigger !== false) await appendHistory(this.db, { appId: options.appId, role: "user", kind: "chat", content: options.trigger });
      for (let turn = 1; turn <= maxTurns; turn++) {
        console.groupCollapsed(`[itsalive:agent] Turn ${turn}/${maxTurns}`);
        try {
          if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
          const pushed = options.consumeEnvironmentObservations?.() ?? [];
          if (pushed.length) environmentObservation = [environmentObservation, ...pushed].filter(Boolean).join("\n\n");
          const history = await this.db.history.forApp(options.appId);
          const context = buildModelContext({ model: options.model, appPrompt: options.appPrompt, trigger: options.trigger, tools: options.tools, summary: options.summary, observation, environmentObservation, history, countTokens: options.countTokens });
          environmentObservation = undefined;
          console.info('Context', { provider: options.model.provider, model: options.model.model, estimatedInputTokens: context.estimatedInputTokens, messageCount: context.messages.length, includedHistoryCount: context.includedHistoryIds.length, omittedHistoryCount: context.omittedHistoryCount, toolCount: options.tools.length, hasObservation: Boolean(observation) });
          let generated;
          try {
            generated = await this.providers.generate({ purpose: `agent turn ${turn}`, model: options.model, system: context.system, messages: context.messages, maxOutputTokens: options.model.maxOutputTokens, signal: controller.signal }, options.credential);
          } catch (error) {
            console.error('Model request failed', diagnosticError(error));
            throw error;
          }

          let code: string;
          try {
            code = extractExecutableJavaScript(generated.text);
            validateExecutableJavaScript(code);
            consecutiveGenerationFailures = 0;
          } catch (error) {
            const generatedError = error instanceof GeneratedCodeError
              ? error
              : new GeneratedCodeError("compile", error instanceof Error ? error.message : String(error));
            consecutiveGenerationFailures++;
            observation = generatedCodeObservation(generatedError);
            console.warn('Generated code rejected before execution', sanitizeDiagnostic({
              phase: generatedError.phase,
              message: generatedError.message,
              consecutiveFailures: consecutiveGenerationFailures,
            }));
            await appendHistory(this.db, { appId: options.appId, role: "observation", kind: "error", content: observation });
            if (consecutiveGenerationFailures >= MAX_CONSECUTIVE_GENERATION_FAILURES) {
              throw new Error(`Agent produced invalid JavaScript ${consecutiveGenerationFailures} times in a row; stopping to avoid wasting turns. Last error: ${generatedError.message}`);
            }
            console.info('Continuing to next turn for code repair');
            continue;
          }

          console.info('Executable JavaScript', sanitizeDiagnostic(code));
          await appendHistory(this.db, { appId: options.appId, role: "agent", kind: "javascript", content: code });
          const executionStartedAt = performance.now();
          let result;
          try {
            result = await this.executor.execute(options.appId, code, { signal: controller.signal, timeoutMs: options.executionTimeoutMs ?? 30_000 });
          } catch (error) {
            console.error(`Runtime execution failed (${Math.round(performance.now() - executionStartedAt)}ms)`, diagnosticError(error));
            throw error;
          }
          console.info(`Runtime result (${Math.round(performance.now() - executionStartedAt)}ms)`, sanitizeDiagnostic(result));
          if (result.error) console.error('Runtime execution error', sanitizeDiagnostic(result.error));
          observation = boundObservation(result, options.maxObservationCharacters ?? 16_000);
          console.info('Observation', sanitizeDiagnostic(observation));
          await appendHistory(this.db, { appId: options.appId, role: "observation", kind: result.error ? "error" : "execution", content: observation });
          if (result.done) {
            const arrivedBeforeCompletion = options.consumeEnvironmentObservations?.() ?? [];
            if (arrivedBeforeCompletion.length) {
              environmentObservation = arrivedBeforeCompletion.join("\n\n");
              console.info("Environmental observation arrived before completion; continuing");
              continue;
            }
            const completion = await verifyCompletion(this.executor, options, controller.signal);
            if (!completion.ok) {
              observation = JSON.stringify({ completionCheck: { ok: false, reason: completion.reason } });
              console.warn('Completion check rejected', sanitizeDiagnostic(completion));
              await appendHistory(this.db, { appId: options.appId, role: "observation", kind: "error", content: observation });
              console.info('Continuing to next turn after incomplete done()');
              continue;
            }
            if (result.message) await appendHistory(this.db, { appId: options.appId, role: "assistant", kind: "chat", content: result.message });
            console.info('Run done', sanitizeDiagnostic({ turn, message: result.message }));
            return { status: "done", message: result.message, turns: turn };
          }
          console.info('Continuing to next turn');
        } finally {
          console.groupEnd();
        }
      }
      console.warn('Agent turn limit reached', { maxTurns });
      return { status: "turn-limit", turns: maxTurns };
    } catch (error) {
      console.error('Agent run failed', diagnosticError(error));
      throw error;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      console.info(`Run finished (${Math.round(performance.now() - startedAt)}ms)`, { aborted: controller.signal.aborted });
      console.groupEnd();
    }
  }
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
  return `${label}:\n${error.message}\nReturn exactly one complete executable JavaScript program with no prose or Markdown fences.`;
}

async function verifyCompletion(executor: AppExecutor, options: RunOptions, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const inspection = await executor.execute(options.appId, COMPLETION_INSPECTION, {
      signal,
      timeoutMs: Math.min(options.executionTimeoutMs ?? 30_000, 5_000),
    });
    if (inspection.error || typeof inspection.value !== "string") return { ok: true };
    return assessCompletionTree(inspection.value);
  } catch (error) {
    console.warn('Completion inspection failed; accepting done()', diagnosticError(error));
    return { ok: true };
  }
}

function assessCompletionTree(tree: string): { ok: true } | { ok: false; reason: string } {
  const lines = tree.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .filter(line => !/\b(?:script|style)\b/.test(line));
  const contentLines = lines.slice(1);
  const text = [...tree.matchAll(/"([^"]+)"/g)].map(match => match[1]!.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const hasInteractive = contentLines.some(line => /\b(?:button|input|textarea|select|a)(?:[#.\s"]|$)/i.test(line));
  const hasVisual = contentLines.some(line => /\b(?:canvas|svg|img|video|audio)(?:[#.\s"]|$)/i.test(line));
  const placeholderOnly = Boolean(text) && /^(?:[\w .'-]+\s+)?(?:loading|starting|initializing|preparing|please wait)[.…! ]*$/i.test(text);

  if (placeholderOnly && !hasInteractive && !hasVisual) {
    return { ok: false, reason: "the rendered app still appears to be only a loading/initializing placeholder" };
  }
  if (!text && !hasInteractive && !hasVisual && contentLines.length < 2) {
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
