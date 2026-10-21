import type {
  AIConfig,
  AIContext,
  AIEvent,
  AIResponse,
  AIRole,
  ApplicationAIRequest,
  GenerateInput,
  Provider,
  ProviderId,
  UsageRecord,
  ProviderCredentials,
} from "./types";
import { HTTPProvider } from "./providers";
import { DemoProvider } from "./demo";

export interface AIServiceOptions {
  beforeRequest?: () => void;
  credentials?: () => Partial<Record<"openai" | "openrouter", string>>;
  providers?: Partial<Record<ProviderId, Provider>>;
  log?: (event: AIEvent) => void;
  onUsage?: (record: UsageRecord) => void;
  now?: () => number;
}

export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") {
    let output = value.replace(
      /\b(?:sk-[\w-]{8,}|Bearer\s+[^\s"']+)/gi,
      "[REDACTED]",
    );
    for (const secret of secrets)
      if (secret.length > 3) output = output.split(secret).join("[REDACTED]");
    return output.slice(0, 32_000);
  }
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          key,
          /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|credential(?:s)?|authorization|password|secret(?:s)?)$/i.test(
            key,
          )
            ? "[REDACTED]"
            : redact(item, secrets),
        ]),
    );
  return value;
}
function checkConfig(config: AIConfig): void {
  const { limits } = config;
  if (
    !Number.isInteger(limits.requestsPerMinute) ||
    limits.requestsPerMinute < 1 ||
    limits.requestsPerMinute > 1_000 ||
    !Number.isInteger(limits.concurrency) ||
    limits.concurrency < 1 ||
    limits.concurrency > 20 ||
    !Number.isFinite(limits.budgetUSD) ||
    limits.budgetUSD < 0
  )
    throw new Error(
      "AI limits must be valid nonnegative amounts and bounded positive integer rates.",
    );
  for (const route of Object.values(config.routes)) {
    if (
      !["demo", "openai", "openrouter"].includes(route.provider) ||
      !route.model ||
      route.model.length > 160 ||
      !Number.isInteger(route.maxOutputTokens) ||
      route.maxOutputTokens < 1 ||
      route.maxOutputTokens > 32_768 ||
      !Number.isFinite(route.inputPerMillion) ||
      !Number.isFinite(route.outputPerMillion) ||
      route.inputPerMillion < 0 ||
      route.outputPerMillion < 0
    )
      throw new Error("Invalid AI model configuration.");
    if (
      route.provider !== "demo" &&
      (route.inputPerMillion === 0 || route.outputPerMillion === 0)
    )
      throw new Error(
        "Set nonzero input and output prices for external models so the spending limit can reserve costs.",
      );
  }
}

export class AIService {
  private configuration: AIConfig;
  private active = 0;
  private testingConfiguration = false;
  private records: UsageRecord[] = [];
  private readonly providers: Record<ProviderId, Provider>;
  private readonly now: () => number;
  constructor(
    config: AIConfig,
    private readonly options: AIServiceOptions = {},
  ) {
    checkConfig(config);
    this.configuration = structuredClone(config);
    this.providers = {
      demo: new DemoProvider(),
      openai: new HTTPProvider("openai"),
      openrouter: new HTTPProvider("openrouter"),
      ...options.providers,
    };
    this.now = options.now ?? Date.now;
  }
  get config(): AIConfig {
    return structuredClone(this.configuration);
  }
  get usage(): UsageRecord[] {
    return structuredClone(this.records);
  }
  get activeRequestCount(): number {
    return this.active + (this.testingConfiguration ? 1 : 0);
  }
  get spentUSD(): number {
    return this.records.reduce((sum, record) => sum + record.costUSD, 0);
  }
  configure(config: AIConfig): void {
    checkConfig(config);
    this.configuration = structuredClone(config);
  }
  importUsage(records: UsageRecord[]): void {
    if (this.active)
      throw new Error("Cannot replace accounting during an active request.");
    if (
      !Array.isArray(records) ||
      records.some(
        (record) =>
          !Number.isFinite(record.costUSD) ||
          record.costUSD < 0 ||
          !Number.isFinite(record.timestamp),
      )
    )
      throw new Error("Invalid accounting records.");
    this.records = structuredClone(records);
  }
  private event(
    context: AIContext,
    event: string,
    data: Record<string, unknown>,
    level: "INFO" | "DEBUG" = "INFO",
  ): void {
    const secrets = Object.values(this.options.credentials?.() ?? {}).filter(
      (value): value is string => !!value,
    );
    try {
      this.options.log?.({
        event,
        level,
        appId: context.appId,
        correlationId: context.correlationId,
        data: redact(data, secrets) as Record<string, unknown>,
      });
    } catch {
      /* Diagnostics cannot veto provider work. */
    }
  }
  async generate(
    role: AIRole,
    input: GenerateInput,
    context: AIContext,
  ): Promise<AIResponse> {
    this.options.beforeRequest?.();
    context.signal?.throwIfAborted();
    if (this.testingConfiguration)
      throw new Error("Wait for the AI connection check to finish.");
    const route = this.configuration.routes[role];
    if (!route || role === "speech")
      throw new Error(
        "Speech input uses the browser recognition path; text generation cannot use the speech route.",
      );
    if (!context.appId || !context.correlationId)
      throw new Error(
        "AI calls require application and correlation identities.",
      );
    if (route.provider === "demo" && !this.configuration.testProviderEnabled)
      throw new Error(
        "Connect an AI provider in Settings, or explicitly enable the scripted test provider in Advanced.",
      );
    const encoded = JSON.stringify(input);
    if (
      encoded.length > 160_000 ||
      input.messages.length > 80 ||
      (input.tools && input.tools.length > 16)
    )
      throw new Error(
        "AI context exceeds the bounded request size. Read fewer files or narrow the task.",
      );
    const credential =
      route.provider === "demo"
        ? ""
        : (this.options.credentials?.()[route.provider] ?? "");
    if (route.provider !== "demo" && !credential)
      throw new Error(`Add a ${route.provider} key in Settings.`);
    const now = this.now();
    const limits = this.configuration.limits;
    if (this.active >= limits.concurrency)
      throw new Error(
        "AI concurrency limit reached. Wait for the current request.",
      );
    if (
      this.records.filter((record) => record.timestamp > now - 60_000).length >=
      limits.requestsPerMinute
    )
      throw new Error("AI request limit reached. Try again in a minute.");
    // UTF-8 bytes + framing is deliberately conservative for tokenizers. Model prices are user-configured estimates.
    const reservedInput =
      new TextEncoder().encode(encoded).length +
      input.messages.length * 32 +
      256;
    const reserved =
      route.provider === "demo"
        ? 0
        : (reservedInput * route.inputPerMillion +
            route.maxOutputTokens * route.outputPerMillion) /
          1_000_000;
    if (this.spentUSD + reserved > limits.budgetUSD)
      throw new Error(
        "AI spending limit would be exceeded. Narrow the request or adjust the limit.",
      );
    const record: UsageRecord = {
      id: crypto.randomUUID(),
      timestamp: now,
      role,
      provider: route.provider,
      model: route.model,
      appId: context.appId,
      correlationId: context.correlationId,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUSD: reserved,
      estimated: true,
      latencyMs: 0,
      status: "pending",
    };
    this.records.push(record);
    this.active++;
    try {
      this.options.onUsage?.(structuredClone(record));
    } catch {
      this.active--;
      this.records.pop();
      throw new Error("Could not reserve AI accounting before request.");
    }
    this.event(context, "ai.request", {
      role,
      provider: route.provider,
      model: route.model,
      requestId: record.id,
      reservedUSD: reserved,
      inputCharacters: encoded.length,
    });
    if (this.configuration.captureContent)
      this.event(
        context,
        "ai.request.content",
        { messages: input.messages },
        "DEBUG",
      );
    try {
      const signals = [
        AbortSignal.timeout(90_000),
        ...(context.signal ? [context.signal] : []),
      ];
      const result = await this.providers[route.provider].generate(
        route,
        input,
        credential,
        AbortSignal.any(signals),
      );
      const usage = result.usage;
      if (
        usage &&
        [usage.inputTokens, usage.outputTokens, usage.cachedTokens].every(
          (value) => Number.isFinite(value) && value >= 0,
        ) &&
        (usage.costUSD === undefined ||
          (Number.isFinite(usage.costUSD) && usage.costUSD >= 0))
      ) {
        record.inputTokens = usage.inputTokens;
        record.outputTokens = usage.outputTokens;
        record.cachedTokens = usage.cachedTokens;
        record.costUSD =
          route.provider === "demo"
            ? 0
            : (usage.costUSD ??
              (usage.inputTokens * route.inputPerMillion +
                usage.outputTokens * route.outputPerMillion) /
                1_000_000);
        record.estimated =
          usage.costUSD === undefined && route.provider !== "demo";
      }
      record.status = "success";
      this.event(context, "ai.response", {
        role,
        requestId: result.requestId ?? record.id,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costUSD: record.costUSD,
        estimated: record.estimated,
        toolCalls: result.toolCalls.map((call) => call.name),
      });
      if (this.configuration.captureContent)
        this.event(
          context,
          "ai.response.content",
          { text: result.text, calls: result.toolCalls },
          "DEBUG",
        );
      return result;
    } catch (error) {
      record.status = "failed";
      // An interrupted request may still be billed. Retain its reservation instead of falsely reporting zero.
      this.event(context, "ai.failure", {
        role,
        requestId: record.id,
        error:
          error instanceof Error ? error.message : "Unknown provider failure",
        reservedUSD: reserved,
      });
      throw error;
    } finally {
      record.latencyMs = this.now() - now;
      this.active--;
      try {
        this.options.onUsage?.(structuredClone(record));
      } catch {
        this.event(context, "ai.accounting.persist.failure", {
          requestId: record.id,
        });
      }
    }
  }
  /** Probe actual configured models without committing credentials or routing on failure.
   * Probe requests share the durable accounting ledger and block competing requests.
   */
  async testConfiguration(
    config: AIConfig,
    credentials: ProviderCredentials,
    context: AIContext,
  ): Promise<void> {
    if (this.active || this.testingConfiguration)
      throw new Error(
        "Wait for the current AI request before changing the connection.",
      );
    checkConfig(config);
    const candidate = structuredClone(config);
    for (const route of Object.values(candidate.routes))
      route.maxOutputTokens = 32;
    const probe = new AIService(candidate, {
      providers: this.providers,
      credentials: () => credentials,
      beforeRequest: this.options.beforeRequest,
      log: this.options.log,
      now: this.now,
      onUsage: (record) => {
        const index = this.records.findIndex((item) => item.id === record.id);
        if (index === -1) this.records.push(record);
        else this.records[index] = record;
        this.options.onUsage?.(record);
      },
    });
    probe.importUsage(this.usage);
    this.testingConfiguration = true;
    try {
      const checked = new Set<string>();
      for (const [role, route] of Object.entries(candidate.routes)) {
        if (role === "speech" || route.provider === "demo") continue;
        const key = `${route.provider}:${route.model}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const result = await probe.generate(
          role as AIRole,
          {
            messages: [
              {
                role: "user",
                content: "Reply with OK to confirm the connection.",
              },
            ],
          },
          context,
        );
        if (!result.text.trim())
          throw new Error(
            "The AI connection returned an empty response. Try another model.",
          );
      }
    } finally {
      this.testingConfiguration = false;
    }
  }
  async application(
    request: ApplicationAIRequest,
    context: AIContext,
  ): Promise<string | boolean | number> {
    if (
      !request ||
      typeof request.prompt !== "string" ||
      request.prompt.length > 16_000 ||
      !["text", "decide", "choose", "score"].includes(request.method)
    )
      throw new Error("Invalid application AI request.");
    const prompt = `${request.prompt}${request.context === undefined ? "" : `\nContext: ${JSON.stringify(request.context)}`}`;
    if (request.method === "text")
      return (
        await this.generate(
          "application",
          { messages: [{ role: "user", content: prompt }] },
          context,
        )
      ).text;
    let valueSchema: Record<string, unknown>;
    if (request.method === "decide") valueSchema = { type: "boolean" };
    else if (request.method === "choose") {
      if (
        !Array.isArray(request.options) ||
        request.options.length < 2 ||
        request.options.length > 30 ||
        request.options.some(
          (option) => typeof option !== "string" || option.length > 200,
        ) ||
        new Set(request.options).size !== request.options.length
      )
        throw new Error("Choose requires 2–30 distinct text options.");
      valueSchema = { type: "string", enum: request.options };
    } else {
      if (
        !Array.isArray(request.levels) ||
        request.levels.length < 2 ||
        request.levels.length > 20 ||
        request.levels.some(
          (level) => typeof level !== "string" || level.length > 200,
        )
      )
        throw new Error("Score requires 2–20 named levels.");
      valueSchema = {
        type: "number",
        minimum: 0,
        maximum: request.levels.length - 1,
      };
    }
    const response = await this.generate(
      "application",
      {
        messages: [
          {
            role: "system",
            content: `Return a bounded ${request.method} as JSON {"value":...}. ${request.levels ? `Score levels from zero: ${JSON.stringify(request.levels)}` : ""}`,
          },
          { role: "user", content: prompt },
        ],
        jsonSchema: {
          name: "application_decision",
          schema: {
            type: "object",
            properties: { value: valueSchema },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
      context,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error("Model returned invalid decision JSON.");
    }
    const value =
      parsed && typeof parsed === "object" && "value" in parsed
        ? parsed.value
        : undefined;
    if (request.method === "decide" && typeof value === "boolean") return value;
    if (
      request.method === "choose" &&
      typeof value === "string" &&
      request.options?.includes(value)
    )
      return value;
    if (
      request.method === "score" &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= (request.levels?.length ?? 0) - 1
    )
      return value;
    throw new Error("Model decision did not match the allowed result.");
  }
}
