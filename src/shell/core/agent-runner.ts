import { buildModelContext, type TokenCounter } from "./context";
import { appendHistory } from "./history";
import type { ShellDatabase } from "./database";
import type { Credential, ModelConfig, ToolSummary } from "./types";
import type { ProviderRegistry } from "./providers";

export interface ExecutionResult {
  value?: unknown;
  error?: { message: string; stack?: string; logs?: unknown[] };
  done?: boolean;
  message?: string;
  screenshot?: string;
}

export interface AppExecutor {
  execute(appSlug: string, code: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<ExecutionResult>;
}

export interface RunOptions {
  appSlug: string;
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
}

export interface RunResult { status: "done" | "turn-limit"; message?: string; turns: number }

export class AgentRunner {
  constructor(private readonly db: ShellDatabase, private readonly providers: ProviderRegistry, private readonly executor: AppExecutor) {}

  async run(options: RunOptions): Promise<RunResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => controller.abort(new DOMException("Agent run timed out", "TimeoutError")), options.maxDurationMs ?? 120_000);
    const maxTurns = options.maxTurns ?? 12;
    let observation: string | undefined;
    try {
      await appendHistory(this.db, { appSlug: options.appSlug, role: "user", kind: "chat", content: options.trigger });
      for (let turn = 1; turn <= maxTurns; turn++) {
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
        const history = await this.db.history.forApp(options.appSlug);
        const context = buildModelContext({ model: options.model, appPrompt: options.appPrompt, trigger: options.trigger, tools: options.tools, summary: options.summary, observation, history, countTokens: options.countTokens });
        const generated = await this.providers.generate({ model: options.model, system: context.system, messages: context.messages, maxOutputTokens: options.model.maxOutputTokens, signal: controller.signal }, options.credential);
        const code = stripAccidentalFence(generated.text);
        await appendHistory(this.db, { appSlug: options.appSlug, role: "agent", kind: "javascript", content: code });
        const result = await this.executor.execute(options.appSlug, code, { signal: controller.signal, timeoutMs: options.executionTimeoutMs ?? 30_000 });
        observation = boundObservation(result, options.maxObservationCharacters ?? 16_000);
        await appendHistory(this.db, { appSlug: options.appSlug, role: "observation", kind: result.error ? "error" : "execution", content: observation });
        if (result.done) {
          if (result.message) await appendHistory(this.db, { appSlug: options.appSlug, role: "assistant", kind: "chat", content: result.message });
          return { status: "done", message: result.message, turns: turn };
        }
      }
      return { status: "turn-limit", turns: maxTurns };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
    }
  }
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
