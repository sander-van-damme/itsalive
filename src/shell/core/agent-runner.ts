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
  onTriggerPersisted?: () => void | Promise<void>;
}

export interface RunResult { status: "done" | "turn-limit"; message?: string; turns: number }

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
    const startedAt = performance.now();
    console.groupCollapsed(`[itsalive:agent] Run · ${options.appId}`);
    console.info('Run start', { trigger: sanitizeDiagnostic(options.trigger), provider: options.model.provider, model: options.model.model, maxTurns });
    try {
      if (options.persistTrigger !== false) {
        await appendHistory(this.db, { appId: options.appId, role: "user", kind: "chat", content: options.trigger });
        await options.onTriggerPersisted?.();
      }
      for (let turn = 1; turn <= maxTurns; turn++) {
        console.groupCollapsed(`[itsalive:agent] Turn ${turn}/${maxTurns}`);
        try {
          if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
          const history = await this.db.history.forApp(options.appId);
          const context = buildModelContext({ model: options.model, appPrompt: options.appPrompt, trigger: options.trigger, tools: options.tools, summary: options.summary, observation, history, countTokens: options.countTokens });
          console.info('Context', { provider: options.model.provider, model: options.model.model, estimatedInputTokens: context.estimatedInputTokens, messageCount: context.messages.length, includedHistoryCount: context.includedHistoryIds.length, omittedHistoryCount: context.omittedHistoryCount, toolCount: options.tools.length, hasObservation: Boolean(observation) });
          let generated;
          try {
            generated = await this.providers.generate({ purpose: `agent turn ${turn}`, model: options.model, system: context.system, messages: context.messages, maxOutputTokens: options.model.maxOutputTokens, signal: controller.signal }, options.credential);
          } catch (error) {
            console.error('Model request failed', diagnosticError(error));
            throw error;
          }
          const code = stripAccidentalFence(generated.text);
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

function diagnosticError(error: unknown): unknown {
  return sanitizeDiagnostic(error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack, ...('diagnostic' in error ? { diagnostic: sanitizeDiagnostic(error.diagnostic) } : {}) }
    : error);
}

function stripAccidentalFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? trimmed;
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
