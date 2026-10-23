import type {
  AIResponse,
  GenerateInput,
  ModelRoute,
  Provider,
  ServiceTier,
} from "./types";
import { companionFetch } from "./connection";

export type AIErrorKind =
  | "connection"
  | "credentials"
  | "access"
  | "limit"
  | "model"
  | "response"
  | "timeout";
export class AIError extends Error {
  constructor(
    message: string,
    readonly kind: AIErrorKind,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AIError";
  }
}
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, any>)
    : {};
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

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
    ...(route.provider === "chatgpt"
      ? {}
      : { max_output_tokens: route.maxOutputTokens }),
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
          parallel_tool_calls: false,
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
  if (data.status === "incomplete")
    throw new AIError(
      "The AI response ended before it finished. Your working app is safe; try a smaller change.",
      "response",
      { reason: object(data.incomplete_details).reason },
    );
  if (data.status === "failed" || data.error) {
    const code = object(data.error).code;
    if (
      typeof code === "string" &&
      /usage_limit|usage_unavailable|quota/.test(code)
    )
      throw new AIError(
        "Your ChatGPT allowance is unavailable or has been used up. Check usage in ChatGPT, then try again.",
        "limit",
        { code },
      );
    throw new AIError(
      "The AI request could not finish. Try again or download the diagnostic logs.",
      "response",
      { code },
    );
  }
  const output = Array.isArray(data.output) ? data.output.map(object) : [];
  const content = output
    .filter((item) => item.type === "message")
    .flatMap((item) =>
      Array.isArray(item.content) ? item.content.map(object) : [],
    );
  if (content.some((item) => item.type === "refusal"))
    throw new AIError(
      "The AI could not help with that request. Try describing a different approach.",
      "response",
    );
  const text = content
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
  const toolCalls = output
    .filter((item) => item.type === "function_call")
    .map((item) => {
      if (
        typeof item.call_id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.arguments !== "string"
      )
        throw new AIError(
          "The AI returned an incomplete action. Please try again.",
          "response",
        );
      return {
        id: item.call_id,
        name: item.name.replace(/^itsalive\./, ""),
        arguments: item.arguments,
      };
    });
  if (!text && !toolCalls.length)
    throw new AIError(
      "The AI returned an empty response. Please try again.",
      "response",
    );
  const usage = object(data.usage);
  return {
    text,
    toolCalls,
    responseItems: output.filter((item) =>
      ["reasoning", "message", "function_call"].includes(item.type),
    ),
    requestId: typeof data.id === "string" ? data.id : undefined,
    serviceTier:
      data.service_tier === "fast"
        ? "priority"
        : ["default", "priority", "ultrafast"].includes(data.service_tier)
          ? (data.service_tier as ServiceTier)
          : undefined,
    ...(typeof usage.input_tokens === "number" &&
    typeof usage.output_tokens === "number"
      ? {
          usage: {
            inputTokens: finite(usage.input_tokens),
            outputTokens: finite(usage.output_tokens),
            cachedTokens: finite(
              object(usage.input_tokens_details).cached_tokens,
            ),
          },
        }
      : {}),
  };
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
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      bytes += value?.length ?? 0;
      if (bytes > 8_000_000)
        throw new AIError(
          "The AI response was too large. Please try a smaller change.",
          "response",
        );
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
        if (data.type === "error")
          throw new AIError(
            "The AI stream failed. Please try again.",
            "response",
            { code: data.code },
          );
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
          "The AI request took too long or was cancelled. Please try again.",
          "timeout",
        );
      if (error instanceof AIError) throw error;
      throw new AIError(
        "Couldn't reach OpenAI. Check your connection, then try again. You can download diagnostic logs in Settings.",
        "connection",
        { cause: error instanceof Error ? error.name : "unknown" },
      );
    }
    if (!response.ok)
      throw httpFailure(
        response.status,
        response.headers.get("x-request-id") ?? undefined,
      );
    try {
      return await readResponseStream(response);
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (signal?.aborted)
        throw new AIError(
          "The AI request took too long or was cancelled. Please try again.",
          "timeout",
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
