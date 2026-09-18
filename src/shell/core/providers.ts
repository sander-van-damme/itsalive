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
  generate(request: GenerateRequest, credential?: Credential): Promise<GenerateResult> {
    return this.get(request.model.provider).generate(request, credential);
  }
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
  if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? `Provider request failed (${response.status})`);
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
        console.error(`[itsalive:provider] ${options.id} returned no text in the expected ${format} response location`, diagnostic);
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
    .register(createHttpAdapter({ id: "openai", endpoint: "https://api.openai.com/v1/chat/completions" }))
    .register(createHttpAdapter({ id: "anthropic", endpoint: "https://api.anthropic.com/v1/messages", format: "anthropic", headers: { "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } }))
    .register(createHttpAdapter({ id: "deepseek", endpoint: "https://api.deepseek.com/chat/completions" }))
    .register(createHttpAdapter({ id: "openrouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" }));
}

export function openAiCompatible(id: string, baseUrl: string, headers?: Record<string, string>): LlmAdapter {
  return createHttpAdapter({ id, endpoint: `${baseUrl.replace(/\/$/, "")}/chat/completions`, headers });
}
