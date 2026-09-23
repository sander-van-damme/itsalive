import { normalizeLlmUsage } from "./llm-trace";
import type { Credential, GenerateRequest, GenerateResult, LlmAdapter, LlmTraceEvent } from "./types";
import { sanitizeDiagnostic } from "./diagnostics";

export class ProviderResponseError extends Error {
  constructor(message: string, readonly diagnostic: unknown) {
    super(message);
    this.name = "ProviderResponseError";
  }
}

type UsageObserver = (usage: GenerateResult["usage"]) => void;
type TraceObserver = (event: LlmTraceEvent) => void;

function traceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function safeOptions(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const safe = sanitizeDiagnostic(value);
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safe as Record<string, unknown> : undefined;
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, LlmAdapter>();

  constructor(
    private readonly onUsage?: UsageObserver,
    private readonly onTrace?: TraceObserver,
  ) {}

  register(adapter: LlmAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): LlmAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown LLM provider: ${id}`);
    return adapter;
  }

  async generate(request: GenerateRequest, credential?: Credential): Promise<GenerateResult> {
    return this.trace(request, credential, false);
  }

  async generateStreaming(request: GenerateRequest, onText: (delta: string) => void, credential?: Credential, onActivity?: () => void): Promise<GenerateResult> {
    return this.trace(request, credential, true, onText, onActivity);
  }

  private emitTrace(event: LlmTraceEvent): void {
    console.info("Trace", sanitizeDiagnostic(event));
    try { this.onTrace?.(event); }
    catch (error) { console.warn("[itsalive:llm] Trace observer failed", sanitizeDiagnostic(error)); }
  }

  private async trace(
    request: GenerateRequest,
    credential: Credential | undefined,
    streaming: boolean,
    onText?: (delta: string) => void,
    onActivity?: () => void,
  ): Promise<GenerateResult> {
    const perfStartedAt = performance.now();
    const startedAt = Date.now();
    const requestId = traceId();
    const label = request.purpose ?? "generation";
    const identity = request.trace ?? {
      runId: requestId,
      agentId: requestId,
      role: "unattributed",
      profile: "unattributed",
    };
    const base = {
      ...identity,
      requestId,
      purpose: label,
      provider: request.model.provider,
      model: request.model.model,
      ...(request.model.options ? { modelOptions: safeOptions(request.model.options) } : {}),
      streaming,
      startedAt,
      ...(request.trace?.turn != null ? { turn: request.trace.turn } : {}),
      ...(request.trace?.context ? { context: request.trace.context } : {}),
    };

    console.groupCollapsed(`[itsalive:llm] ${label} · ${request.model.provider}/${request.model.model}${streaming ? " · stream" : ""}`);
    console.info("Request", sanitizeDiagnostic({
      ...base,
      systemCharacters: request.system.length,
      messages: request.messages.map(message => ({ role: message.role, characters: message.content.length })),
    }));

    try {
      const adapter = this.get(request.model.provider);
      const result = streaming && adapter.stream
        ? await adapter.stream(request, credential, onText!, onActivity)
        : await adapter.generate(request, credential);
      if (streaming && !adapter.stream && result.text) onText?.(result.text);
      const elapsedMs = Math.round(performance.now() - perfStartedAt);
      console.info(`Response (${elapsedMs}ms)`, sanitizeDiagnostic({
        textPreview: result.text.slice(0, 500),
        textCharacters: result.text.length,
        usage: result.usage,
        provider: compactProviderMetadata(result.raw),
        ...(streaming ? { streaming: Boolean(adapter.stream) } : {}),
      }));
      this.onUsage?.(result.usage);
      this.emitTrace({
        ...base,
        elapsedMs,
        status: "success",
        usage: normalizeLlmUsage(result.usage),
      });
      return result;
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - perfStartedAt);
      const diagnostic = error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...("diagnostic" in error ? { diagnostic: error.diagnostic } : {}),
      } : error;
      console.error(`Request failed (${elapsedMs}ms)`, sanitizeDiagnostic(diagnostic));
      this.emitTrace({
        ...base,
        elapsedMs,
        status: "error",
        usage: normalizeLlmUsage(undefined),
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: String(error) },
      });
      throw error;
    } finally {
      console.groupEnd();
    }
  }
}

function compactProviderMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const firstChoice = Array.isArray(record.choices) && record.choices[0] && typeof record.choices[0] === "object"
    ? record.choices[0] as Record<string, unknown>
    : undefined;
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.object === "string" ? { object: record.object } : {}),
    ...(typeof firstChoice?.finish_reason === "string" ? { finishReason: firstChoice.finish_reason } : {}),
    ...(typeof firstChoice?.native_finish_reason === "string" ? { nativeFinishReason: firstChoice.native_finish_reason } : {}),
  };
}

interface TokenDetails {
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
}

interface JsonUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  prompt_cache_write_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  prompt_tokens_details?: TokenDetails;
  input_tokens_details?: TokenDetails;
  completion_tokens_details?: TokenDetails;
  output_tokens_details?: TokenDetails;
}

interface Json {
  [key: string]: unknown;
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string }; finish_reason?: string; native_finish_reason?: string }>;
  usage?: JsonUsage;
}

interface ChatCompletionBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  usage: { include: true };
  [key: string]: unknown;
}

interface HttpAdapterOptions {
  id: string;
  endpoint: string;
}

function generationUsage(usage: JsonUsage | undefined): GenerateResult["usage"] {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    cachedInputTokens:
      usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cached_tokens,
    cacheWriteTokens:
      usage.prompt_tokens_details?.cache_write_tokens
      ?? usage.input_tokens_details?.cache_write_tokens
      ?? usage.prompt_tokens_details?.cache_creation_input_tokens
      ?? usage.input_tokens_details?.cache_creation_input_tokens
      ?? usage.cache_write_tokens
      ?? usage.prompt_cache_write_tokens
      ?? usage.cache_creation_input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
    reasoningTokens:
      usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? usage.reasoning_tokens,
    cost: usage.cost,
  };
}

async function checkedJson(response: Response): Promise<Json> {
  const body = await response.json().catch(() => ({})) as Json;
  if (!response.ok) {
    const statusText = response.statusText.trim();
    const diagnostic = sanitizeDiagnostic({
      status: response.status,
      ...(statusText ? { statusText } : {}),
      body,
    });
    throw new ProviderResponseError(`Provider request failed (${response.status}${statusText ? ` ${statusText}` : ""})`, diagnostic);
  }
  return body;
}

function headersFor(credential?: Credential): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(credential?.value ? { authorization: `Bearer ${credential.value}` } : {}),
  };
}

function bodyFor(request: GenerateRequest): ChatCompletionBody {
  return {
    model: request.model.model,
    messages: [{ role: "system", content: request.system }, ...request.messages],
    ...request.model.options,
    usage: { include: true },
  };
}

/** OpenRouter uses an OpenAI-style chat-completions and SSE contract. */
export function createHttpAdapter(options: HttpAdapterOptions): LlmAdapter {
  return {
    id: options.id,
    async generate(request, credential) {
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: headersFor(credential),
        body: JSON.stringify(bodyFor(request)),
        signal: request.signal,
      });
      const json = await checkedJson(response);
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new ProviderResponseError("Provider returned no text response", sanitizeDiagnostic(json));
      }
      return { text, usage: generationUsage(json.usage), raw: json };
    },
    async stream(request, credential, onText, onActivity) {
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: headersFor(credential),
        body: JSON.stringify({ ...bodyFor(request), stream: true }),
        signal: request.signal,
      });
      if (!response.ok) await checkedJson(response);
      if (!response.body) throw new ProviderResponseError("Provider returned no streaming body", { status: response.status });
      return readOpenAiStream(response.body, onText, onActivity);
    },
  };
}

async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onText: (delta: string) => void,
  onActivity?: () => void,
): Promise<GenerateResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: GenerateResult["usage"];
  let last: Json | undefined;

  const consumeEvent = (event: string): boolean => {
    const data = event.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    let json: Json;
    try { json = JSON.parse(data) as Json; }
    catch { return false; }
    last = json;
    if (json.error) throw new ProviderResponseError("Provider stream returned an error", sanitizeDiagnostic(json));
    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      onText(delta);
    }
    if (json.usage) usage = generationUsage(json.usage);
    return false;
  };

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.value?.byteLength) onActivity?.();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    let separator = buffer.match(/\r?\n\r?\n/);
    while (separator?.index !== undefined) {
      const event = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      if (consumeEvent(event)) { done = true; break; }
      separator = buffer.match(/\r?\n\r?\n/);
    }
    if (chunk.done) break;
  }
  if (!done && buffer.trim()) consumeEvent(buffer);
  if (!text) throw new ProviderResponseError("Provider returned no text response", sanitizeDiagnostic(last ?? {}));
  return { text, usage, raw: last };
}

export function createDefaultRegistry(
  onUsage?: UsageObserver,
  onTrace?: TraceObserver,
): ProviderRegistry {
  return new ProviderRegistry(onUsage, onTrace).register(
    createHttpAdapter({ id: "openrouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" }),
  );
}
