import type { Credential, GenerateRequest, GenerateResult, LlmAdapter } from "./types";
import { sanitizeDiagnostic } from './diagnostics';

export class ProviderResponseError extends Error {
  constructor(message: string, readonly diagnostic: unknown) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, LlmAdapter>();

  constructor(private readonly onUsage?: (usage: NonNullable<GenerateResult["usage"]>) => void) {}

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

  async generateStreaming(request: GenerateRequest, onText: (delta: string) => void, credential?: Credential): Promise<GenerateResult> {
    return this.trace(request, credential, true, onText);
  }

  private async trace(request: GenerateRequest, credential: Credential | undefined, streaming: boolean, onText?: (delta: string) => void): Promise<GenerateResult> {
    const startedAt = performance.now();
    const label = request.purpose ?? 'generation';
    console.groupCollapsed(`[itsalive:llm] ${label} · ${request.model.provider}/${request.model.model}${streaming ? ' · stream' : ''}`);
    console.info('Request', sanitizeDiagnostic({
      purpose: label,
      provider: request.model.provider,
      model: request.model.model,
      systemCharacters: request.system.length,
      messages: request.messages.map(message => ({ role: message.role, characters: message.content.length })),
      modelOptions: request.model.options,
      ...(streaming ? { streaming: true } : {}),
    }));
    try {
      const adapter = this.get(request.model.provider);
      const result = streaming && adapter.stream
        ? await adapter.stream(request, credential, onText!)
        : await adapter.generate(request, credential);
      if (streaming && !adapter.stream && result.text) onText?.(result.text);
      console.info(`Response (${Math.round(performance.now() - startedAt)}ms)`, sanitizeDiagnostic({
        textPreview: result.text.slice(0, 500),
        textCharacters: result.text.length,
        usage: result.usage,
        provider: compactProviderMetadata(result.raw),
        ...(streaming ? { streaming: Boolean(adapter.stream) } : {}),
      }));
      if (result.usage) this.onUsage?.(result.usage);
      return result;
    } catch (error) {
      console.error(`Request failed (${Math.round(performance.now() - startedAt)}ms)`, sanitizeDiagnostic(error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...('diagnostic' in error ? { diagnostic: error.diagnostic } : {}),
      } : error));
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

interface Json {
  [key: string]: unknown;
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string }; finish_reason?: string; native_finish_reason?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

interface HttpAdapterOptions {
  id: string;
  endpoint: string;
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
    throw new ProviderResponseError(`Provider request failed (${response.status}${statusText ? ` ${statusText}` : ''})`, diagnostic);
  }
  return body;
}

function headersFor(credential?: Credential): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(credential?.value ? { authorization: `Bearer ${credential.value}` } : {}),
  };
}

function bodyFor(request: GenerateRequest): Json {
  return {
    model: request.model.model,
    messages: [{ role: "system", content: request.system }, ...request.messages],
    usage: { include: true },
    ...request.model.options,
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
      return {
        text,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? json.usage?.input_tokens,
          outputTokens: json.usage?.completion_tokens ?? json.usage?.output_tokens,
          cost: json.usage?.cost,
        },
        raw: json,
      };
    },
    async stream(request, credential, onText) {
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: headersFor(credential),
        body: JSON.stringify({ ...bodyFor(request), stream: true }),
        signal: request.signal,
      });
      if (!response.ok) await checkedJson(response);
      if (!response.body) throw new ProviderResponseError("Provider returned no streaming body", { status: response.status });
      return readOpenAiStream(response.body, onText);
    },
  };
}

async function readOpenAiStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<GenerateResult> {
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
    if (json.usage) usage = {
      inputTokens: json.usage.prompt_tokens ?? json.usage.input_tokens,
      outputTokens: json.usage.completion_tokens ?? json.usage.output_tokens,
      cost: json.usage.cost,
    };
    return false;
  };

  let done = false;
  while (!done) {
    const chunk = await reader.read();
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

export function createDefaultRegistry(onUsage?: (usage: NonNullable<GenerateResult["usage"]>) => void): ProviderRegistry {
  return new ProviderRegistry(onUsage).register(
    createHttpAdapter({ id: "openrouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" }),
  );
}
