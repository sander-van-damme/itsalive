import type {
  AIResponse,
  GenerateInput,
  ModelRoute,
  Provider,
  ToolCall,
} from "./types";

const ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
} as const;
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Credentials are supplied by the shell immediately before fetch; never part of serializable configuration. */
export class HTTPProvider implements Provider {
  constructor(
    private readonly provider: "openai" | "openrouter",
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async generate(
    route: ModelRoute,
    input: GenerateInput,
    credential: string,
    signal?: AbortSignal,
  ): Promise<AIResponse> {
    if (!credential.trim())
      throw new Error(
        `Add a ${this.provider === "openai" ? "OpenAI" : "OpenRouter"} key in Settings.`,
      );
    const messages = input.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    }));
    let response: Response;
    // Invoke fetch as a function, not a method with this adapter as its receiver.
    // Browser-native fetch rejects that receiver with "Illegal invocation".
    const fetcher = this.fetcher;
    try {
      response = await fetcher(ENDPOINTS[this.provider], {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          ...(this.provider === "openrouter"
            ? { "X-Title": "It's Alive" }
            : {}),
        },
        body: JSON.stringify({
          model: route.model,
          messages,
          max_completion_tokens: route.maxOutputTokens,
          ...(input.tools?.length
            ? {
                tools: input.tools.map((tool) => ({
                  type: "function",
                  function: tool,
                })),
                tool_choice: "auto",
                parallel_tool_calls: false,
              }
            : {}),
          ...(input.jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { ...input.jsonSchema, strict: true },
                },
              }
            : {}),
          ...(this.provider === "openrouter"
            ? {
                provider: { require_parameters: true },
                usage: { include: true },
              }
            : {}),
        }),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new Error(
        "Couldn't reach your AI provider. Check your connection and try again.",
      );
    }
    // Never echo provider bodies: they can contain prompts or credentials.
    if (!response.ok) {
      const name = this.provider === "openai" ? "OpenAI" : "OpenRouter";
      const recovery =
        response.status === 401
          ? "The API key was not accepted. Check it or create a new key."
          : response.status === 403
            ? "This key cannot use the selected model. Check model access or choose another model."
            : response.status === 402
              ? "Add credit to your provider account, then try again."
              : response.status === 429
                ? "The provider's usage or rate limit was reached. Check your account limits and credit, or try again shortly."
                : response.status === 400 || response.status === 404
                  ? "Check the model name and whether it supports text, structured responses and tools."
                  : response.status >= 500
                    ? "The provider is temporarily unavailable. Try again shortly."
                    : "Check your key, model access and network, then try again.";
      throw new Error(`${name} (${response.status}): ${recovery}`);
    }
    const data = record(await response.json());
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = record(choices[0]);
    const message = record(first.message);
    if (typeof message.refusal === "string" && message.refusal)
      throw new Error("The model declined this request.");
    if (!choices.length) throw new Error("Provider returned no completion.");
    const toolCalls: ToolCall[] = (
      Array.isArray(message.tool_calls) ? message.tool_calls : []
    ).map((value) => {
      const call = record(value);
      const fn = record(call.function);
      if (
        typeof call.id !== "string" ||
        typeof fn.name !== "string" ||
        typeof fn.arguments !== "string"
      )
        throw new Error("Provider returned an invalid tool call.");
      return { id: call.id, name: fn.name, arguments: fn.arguments };
    });
    if (first.finish_reason === "length")
      throw new Error(
        "Model output reached its token limit; increase the configured output limit or narrow the task.",
      );
    if (typeof message.content !== "string" && !toolCalls.length)
      throw new Error("Provider returned neither text nor tool calls.");
    const usage = record(data.usage);
    const validUsage = ["prompt_tokens", "completion_tokens"].every(
      (key) =>
        typeof usage[key] === "number" &&
        Number.isFinite(usage[key]) &&
        Number(usage[key]) >= 0,
    );
    const details = record(usage.prompt_tokens_details);
    return {
      text: typeof message.content === "string" ? message.content : "",
      toolCalls,
      requestId:
        typeof data.id === "string"
          ? data.id
          : (response.headers.get("x-request-id") ?? undefined),
      ...(validUsage
        ? {
            usage: {
              inputTokens: finite(usage.prompt_tokens),
              outputTokens: finite(usage.completion_tokens),
              cachedTokens: finite(details.cached_tokens),
              ...(typeof usage.cost === "number" &&
              Number.isFinite(usage.cost) &&
              usage.cost >= 0
                ? { costUSD: usage.cost }
                : {}),
            },
          }
        : {}),
    };
  }
}

/** A test provider uses the same service, tools, compiler and verification path as an external provider. */
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
