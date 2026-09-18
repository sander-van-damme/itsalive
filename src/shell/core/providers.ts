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
  register(adapter: LlmAdapter): this { this.adapters.set(adapter.id, adapter); return this; }
  unregister(id: string): boolean { return this.adapters.delete(id); }
  list(): string[] { return [...this.adapters.keys()].sort(); }
  get(id: string): LlmAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown LLM provider: ${id}`);
    return adapter;
  }
  async generate(request: GenerateRequest, credential?: Credential): Promise<GenerateResult> {
    const startedAt = performance.now();
    const label = request.purpose ?? 'generation';
    console.groupCollapsed(`[itsalive:llm] ${label} · ${request.model.provider}/${request.model.model}`);
    console.info('Request', sanitizeDiagnostic({
      purpose: label,
      provider: request.model.provider,
      model: request.model.model,
      systemCharacters: request.system.length,
      messages: request.messages.map(message => ({ role: message.role, characters: message.content.length })),
      maxOutputTokens: request.maxOutputTokens,
      modelOptions: request.model.options,
    }));
    try {
      const result = await this.get(request.model.provider).generate(request, credential);
      console.info(`Response (${Math.round(performance.now() - startedAt)}ms)`, sanitizeDiagnostic({
        textPreview: result.text.slice(0, 500),
        textCharacters: result.text.length,
        usage: result.usage,
        provider: compactProviderMetadata(result.raw),
      }));
      return result;
    } catch (error) {
      console.error(`Request failed (${Math.round(performance.now() - startedAt)}ms)`, sanitizeDiagnostic(error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, ...('diagnostic' in error ? { diagnostic: error.diagnostic } : {}) } : error));
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
  message?: string;
  content?: Array<{ type?: string; text?: string }>;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}
interface HttpAdapterOptions {
  id: string;
  endpoint: string;
  headers?: Record<string, string>;
  format?: "openai" | "anthropic" | "google";
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

/** Browser adapters intentionally receive credentials only for the duration of one root-origin request. */
export function createHttpAdapter(options: HttpAdapterOptions): LlmAdapter {
  return {
    id: options.id,
    async generate(request, credential) {
      const format = options.format ?? "openai";
      const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
      if (credential?.value) {
        if (format === "anthropic") headers["x-api-key"] = credential.value;
        else if (format === "google") headers["x-goog-api-key"] = credential.value;
        else headers.authorization = `Bearer ${credential.value}`;
      }
      let body: Json;
      if (format === "anthropic") body = { model: request.model.model, system: request.system, messages: request.messages, max_tokens: request.maxOutputTokens, ...request.model.options };
      else if (format === "google") body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: request.messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: request.maxOutputTokens }, ...request.model.options,
      };
      else body = { model: request.model.model, messages: [{ role: "system", content: request.system }, ...request.messages], max_tokens: request.maxOutputTokens, ...request.model.options };
      const response = await fetch(options.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
      const json = await checkedJson(response);
      const text = format === "anthropic" ? json.content?.find(x => x.type === "text")?.text
        : format === "google" ? json.candidates?.[0]?.content?.parts?.map(x => x.text ?? "").join("")
        : json.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        const diagnostic = sanitizeDiagnostic(json);
        throw new ProviderResponseError("Provider returned no text response", diagnostic);
      }
      const usage = format === "anthropic" ? { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens }
        : format === "google" ? { inputTokens: json.usageMetadata?.promptTokenCount, outputTokens: json.usageMetadata?.candidatesTokenCount }
        : { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens };
      return { text, usage, raw: json };
    },
  };
}

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(createHttpAdapter({ id: "openrouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" }));
}

export function openAiCompatible(id: string, baseUrl: string, headers?: Record<string, string>): LlmAdapter {
  return createHttpAdapter({ id, endpoint: `${baseUrl.replace(/\/$/, "")}/chat/completions`, headers });
}
