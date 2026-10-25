import type {
  AIResponse,
  GenerateInput,
  ModelRoute,
  Provider,
  ServiceTier,
} from "./types";
import { companionFetch } from "./connection";
import { OpenAIDecisionsProvider } from "./decisions";

export type AIErrorKind =
  | "connection"
  | "credentials"
  | "access"
  | "limit"
  | "model"
  | "response"
  | "timeout"
  | "cancelled"
  | "context"
  | "accounting";
export class AIError extends Error {
  constructor(
    message: string,
    readonly kind: AIErrorKind,
    readonly detail: Record<string, unknown> = {},
    /** Safe continuation and exact usage, separate from content-free diagnostics. */
    readonly response?: AIResponse,
  ) {
    super(message);
    this.name = "AIError";
  }
}
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, any>)
    : {};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function responseRequest(
  route: ModelRoute,
  input: GenerateInput,
): Record<string, unknown> {
  const items = input.messages.flatMap((message): Record<string, unknown>[] => {
    if (message.role === "assistant" && message.responseItems?.length)
      return message.responseItems;
    if (message.role === "tool")
      return [
        {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        },
      ];
    const result: Record<string, unknown>[] = [];
    if (message.content)
      result.push({
        role: message.role === "system" ? "developer" : message.role,
        content: message.content,
      });
    for (const call of message.toolCalls ?? [])
      result.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    return result;
  });
  const functions = input.tools?.map((tool) => ({
    type: "function",
    ...tool,
    strict: false,
  }));
  return {
    model: route.model,
    input: items,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    // The provider owns model capacity. Never turn a spending policy into a token cap.
    truncation: "disabled",
    reasoning: { effort: route.reasoningEffort ?? "medium" },
    service_tier: route.serviceTier ?? "default",
    ...(functions?.length
      ? {
          tools:
            route.provider === "chatgpt"
              ? [
                  {
                    type: "namespace",
                    name: "itsalive",
                    description: "Application tools",
                    tools: functions,
                  },
                ]
              : functions,
          tool_choice: input.toolChoice ?? "auto",
          // Independent file operations can arrive together; the harness still executes them in order.
          parallel_tool_calls: true,
        }
      : {}),
    ...(input.jsonSchema
      ? {
          text: {
            format: { type: "json_schema", ...input.jsonSchema, strict: true },
          },
        }
      : {}),
  };
}
export function httpFailure(status: number, requestId?: string): AIError {
  const detail = { status, requestId };
  if (status === 401)
    return new AIError(
      "Your AI connection has expired or the key was not accepted. Reconnect in Settings.",
      "credentials",
      detail,
    );
  if (status === 403)
    return new AIError(
      "This account cannot use the selected model or speed. Check your access or choose another option in Settings.",
      "access",
      detail,
    );
  if (status === 429 || status === 402)
    return new AIError(
      "Your AI account has reached a usage limit. Check your allowance or credit, then try again.",
      "limit",
      detail,
    );
  if (status === 400 || status === 404)
    return new AIError(
      "The selected AI model or speed could not handle this request. Check the AI choices in Settings.",
      "model",
      detail,
    );
  return new AIError(
    "OpenAI is temporarily unavailable. Your working app is safe; please try again shortly.",
    "connection",
    detail,
  );
}
export function parseResponse(value: unknown): AIResponse {
  const data = object(value);
  const output = Array.isArray(data.output) ? data.output.map(object) : [];
  const status =
    data.status === "incomplete" || data.status === "failed"
      ? data.status
      : "completed";
  const reason =
    typeof object(data.incomplete_details).reason === "string"
      ? object(data.incomplete_details).reason
      : undefined;
  const code =
    typeof object(data.error).code === "string"
      ? object(data.error).code
      : undefined;
  // Incomplete tool arguments are never executable and never replayed in continuation.
  const validCalls = output.filter((item) => {
    if (
      item.type !== "function_call" ||
      (item.status && item.status !== "completed")
    )
      return false;
    if (
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    )
      return false;
    try {
      const args = JSON.parse(item.arguments);
      return args !== null && typeof args === "object" && !Array.isArray(args);
    } catch {
      return false;
    }
  });
  const safeOutput = output.filter(
    (item) =>
      (item.type === "reasoning" &&
        (!item.status || item.status === "completed")) ||
      (item.type === "message" &&
        (!item.status || item.status === "completed")) ||
      validCalls.includes(item),
  );
  const content = safeOutput
    .filter((item) => item.type === "message")
    .flatMap((item) =>
      Array.isArray(item.content) ? item.content.map(object) : [],
    );
  const usage = object(data.usage);
  const result: AIResponse = {
    endpoint: "responses",
    text: content
      .filter(
        (item) => item.type === "output_text" && typeof item.text === "string",
      )
      .map((item) => item.text)
      .join(""),
    toolCalls: validCalls.map((item) => ({
      id: item.call_id,
      name: item.name.replace(/^itsalive\./, ""),
      arguments: item.arguments,
    })),
    responseItems: safeOutput,
    requestId: typeof data.id === "string" ? data.id : undefined,
    completion: {
      status,
      reason: reason ?? code,
      recoverable: status === "incomplete" && reason === "max_output_tokens",
    },
    serviceTier:
      data.service_tier === "fast"
        ? "priority"
        : ["default", "priority", "ultrafast"].includes(data.service_tier)
          ? (data.service_tier as ServiceTier)
          : undefined,
    ...(count(usage.input_tokens) &&
    count(usage.output_tokens) &&
    (object(usage.input_tokens_details).cached_tokens === undefined ||
      count(object(usage.input_tokens_details).cached_tokens)) &&
    (object(usage.input_tokens_details).cache_write_tokens === undefined ||
      count(object(usage.input_tokens_details).cache_write_tokens)) &&
    (object(usage.input_tokens_details).cached_tokens ?? 0) +
      (object(usage.input_tokens_details).cache_write_tokens ?? 0) <=
      usage.input_tokens
      ? {
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedTokens: object(usage.input_tokens_details).cached_tokens ?? 0,
            cacheWriteTokens:
              object(usage.input_tokens_details).cache_write_tokens ?? 0,
          },
        }
      : {}),
  };
  const detail = {
    reason: reason ?? code,
    status,
    requestId: result.requestId,
    recoverable: result.completion!.recoverable,
  };
  if (status === "incomplete")
    throw new AIError(
      reason === "content_filter"
        ? "The provider stopped this response. Your progress is saved; try describing a different approach."
        : "The provider ended its response before finishing. Your progress is saved and can be continued.",
      "response",
      detail,
      result,
    );
  if (status === "failed" || data.error) {
    if (code && /context_length|context_window|too_many_tokens/.test(code))
      throw new AIError(
        "This request reached the selected model's context capacity. Your progress is saved; choose a model with a larger context or start a focused continuation.",
        "context",
        detail,
        result,
      );
    if (code && /usage_limit|usage_unavailable|quota/.test(code))
      throw new AIError(
        "Your AI allowance is unavailable or has been used up. Check your account usage, then try again.",
        "limit",
        detail,
        result,
      );
    throw new AIError(
      "The AI request could not finish. Your progress is saved; try again or download diagnostic logs.",
      "response",
      detail,
      result,
    );
  }
  if (content.some((item) => item.type === "refusal"))
    throw new AIError(
      "The AI could not help with that request. Try describing a different approach.",
      "response",
      { ...detail, reason: "refusal" },
      result,
    );
  if (
    output.some(
      (item) => item.type === "function_call" && !validCalls.includes(item),
    )
  )
    throw new AIError(
      "The AI returned an incomplete action. Your progress is saved; please try again.",
      "response",
      { ...detail, reason: "invalid_tool_arguments" },
      result,
    );
  if (!result.text && !result.toolCalls.length)
    throw new AIError(
      "The AI returned an empty response. Please try again.",
      "response",
      { ...detail, reason: "empty_response" },
      result,
    );
  return result;
}
/** Consume through the terminal event: early text does not establish success. */
export async function readResponseStream(
  response: Response,
): Promise<AIResponse> {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return parseResponse(await response.json());
  if (!response.body)
    throw new AIError(
      "The AI response was interrupted. Please try again.",
      "connection",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!payload || payload === "[DONE]") continue;
        const data = object(JSON.parse(payload));
        if (
          [
            "response.completed",
            "response.failed",
            "response.incomplete",
          ].includes(data.type)
        )
          return parseResponse(data.response);
        if (data.type === "error") {
          if (data.response || data.usage)
            parseResponse({
              ...object(data.response ?? data),
              status: "failed",
              error: object(data.response).error ?? { code: data.code },
            });
          throw new AIError(
            "The AI stream failed. Please try again.",
            "response",
            { code: data.code },
          );
        }
      }
      if (done) break;
    }
    throw new AIError(
      "The AI connection ended before the response finished. Please try again.",
      "connection",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class HTTPProvider implements Provider {
  constructor(
    private readonly provider: "openai" | "chatgpt",
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async generate(
    route: ModelRoute,
    input: GenerateInput,
    credential: string,
    signal?: AbortSignal,
  ): Promise<AIResponse> {
    if (!credential.trim())
      throw new AIError(
        "Connect OpenAI or your ChatGPT account in Settings.",
        "credentials",
      );
    if (input.decisions) {
      if (this.provider !== "openai")
        throw new AIError(
          "This provider does not support OpenAI Decisions.",
          "model",
        );
      return new OpenAIDecisionsProvider(this.fetcher).decide(
        route,
        input.decisions,
        credential,
        signal,
      );
    }
    let response: Response;
    try {
      const fetcher = this.fetcher;
      const init = {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.provider === "openai"
            ? { Authorization: `Bearer ${credential}` }
            : {}),
        },
        body: JSON.stringify(responseRequest(route, input)),
      };
      response =
        this.provider === "chatgpt"
          ? await companionFetch("/responses", init)
          : await fetcher(
              typeof window === "undefined"
                ? "https://api.openai.com/v1/responses"
                : "/api/ai/responses",
              init,
            );
    } catch (error) {
      if (signal?.aborted)
        throw new AIError(
          signal.reason?.name === "TimeoutError"
            ? "The AI connection timed out. Your progress is saved; please try again."
            : "The AI request was cancelled. Your progress is saved.",
          signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
        );
      if (error instanceof AIError) throw error;
      throw new AIError(
        "Couldn't reach OpenAI. Check your connection, then try again. You can download diagnostic logs in Settings.",
        "connection",
        { cause: error instanceof Error ? error.name : "unknown" },
      );
    }
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const body = await response.json().catch(() => null);
      const code = object(object(body).error).code;
      // Even context failures can include billed usage; parse it before classifying.
      if (object(body).usage)
        parseResponse({ ...object(body), status: "failed", id: requestId });
      if (
        typeof code === "string" &&
        /context_length|context_window|too_many_tokens/.test(code)
      )
        throw new AIError(
          "This request reached the selected model's context capacity. Your progress is saved; choose a model with a larger context or start a focused continuation.",
          "context",
          { status: response.status, requestId, reason: code },
        );
      throw httpFailure(response.status, requestId);
    }
    try {
      return await readResponseStream(response);
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (signal?.aborted)
        throw new AIError(
          signal.reason?.name === "TimeoutError"
            ? "The AI connection timed out. Your progress is saved; please try again."
            : "The AI request was cancelled. Your progress is saved.",
          signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
          { requestId: response.headers.get("x-request-id") },
        );
      throw new AIError(
        error instanceof SyntaxError
          ? "The AI returned an unreadable response. Try again or download diagnostic logs in Settings."
          : "The AI connection was interrupted before the response finished. Please try again.",
        error instanceof SyntaxError ? "response" : "connection",
        {
          requestId: response.headers.get("x-request-id"),
          cause: error instanceof Error ? error.name : "unknown",
        },
      );
    }
  }
}
export class ScriptedProvider implements Provider {
  readonly requests: Array<{ route: ModelRoute; input: GenerateInput }> = [];
  constructor(
    private readonly responses: Array<
      | AIResponse
      | Error
      | ((input: GenerateInput) => AIResponse | Promise<AIResponse>)
    >,
  ) {}
  async generate(
    route: ModelRoute,
    input: GenerateInput,
    _credential: string,
    signal?: AbortSignal,
  ): Promise<AIResponse> {
    signal?.throwIfAborted();
    this.requests.push(structuredClone({ route, input }));
    const response = this.responses.shift();
    if (!response)
      throw new Error("Scripted provider has no remaining response.");
    if (response instanceof Error) throw response;
    return typeof response === "function"
      ? response(input)
      : structuredClone(response);
  }
}
