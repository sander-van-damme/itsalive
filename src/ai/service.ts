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
import { AIError, HTTPProvider } from "./providers";
import { tierMultiplier } from "./types";
import { RequestQueue } from "./queue";
import { DemoProvider } from "./demo";

export interface AIServiceOptions {
  beforeRequest?: () => void;
  credentials?: () => ProviderCredentials;
  onHealth?: (health: ConnectionHealth) => void;
  providers?: Partial<Record<ProviderId, Provider>>;
  log?: (event: AIEvent) => void;
  onUsage?: (record: UsageRecord) => void;
  now?: () => number;
}
export interface ConnectionHealth {
  state: "unchecked" | "checking" | "ready" | "error";
  message?: string;
  checkedAt?: number;
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
    limits.requestsPerMinute > 6_000 ||
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
      !["demo", "openai", "chatgpt"].includes(route.provider) ||
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
  private readonly queue: RequestQueue;
  private validated = "";
  health: ConnectionHealth = { state: "unchecked" };
  private updateHealth(health: ConnectionHealth) {
    this.health = health;
    this.options.onHealth?.(health);
  }
  constructor(
    config: AIConfig,
    private readonly options: AIServiceOptions = {},
  ) {
    checkConfig(config);
    this.configuration = structuredClone(config);
    this.providers = {
      demo: new DemoProvider(),
      openai: new HTTPProvider("openai"),
      chatgpt: new HTTPProvider("chatgpt"),
      ...options.providers,
    };
    this.now = options.now ?? Date.now;
    this.queue = new RequestQueue(() => this.configuration.limits, this.now);
  }
  get config(): AIConfig {
    return structuredClone(this.configuration);
  }
  get usage(): UsageRecord[] {
    return structuredClone(this.records);
  }
  get activeRequestCount(): number {
    return this.queue.size + (this.testingConfiguration ? 1 : 0);
  }
  get spentUSD(): number {
    return this.records.reduce((sum, record) => sum + record.costUSD, 0);
  }
  get periodSpentUSD(): number {
    const date = new Date(this.now());
    const start =
      this.configuration.limits.budgetPeriod === "month"
        ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
        : 0;
    return this.records
      .filter((record) => record.timestamp >= start)
      .reduce((sum, record) => sum + record.costUSD, 0);
  }
  private checkBudget(cost: number) {
    if (
      this.configuration.limits.budgetEnabled !== false &&
      this.periodSpentUSD + cost > this.configuration.limits.budgetUSD
    )
      throw new AIError(
        "Your spending limit would be exceeded. You can change it in Settings → Usage.",
        "limit",
      );
  }
  resetHealth(): void {
    this.validated = "";
    this.updateHealth({ state: "unchecked" });
  }
  configure(config: AIConfig): void {
    checkConfig(config);
    const changed =
      JSON.stringify(config.routes) !==
      JSON.stringify(this.configuration.routes);
    this.configuration = structuredClone(config);
    if (changed)
      this.updateHealth(
        JSON.stringify(config.routes) === this.validated
          ? { state: "ready", checkedAt: this.now() }
          : { state: "unchecked" },
      );
  }
  startVoice(context: AIContext): {
    update(seconds: number, final?: boolean, confirmed?: boolean): void;
  } {
    // Reserve the initialization minimum, then a small rolling allowance while live.
    const rate = 0.05 / 60;
    this.checkBudget(15 * rate);
    const record: UsageRecord = {
      id: crypto.randomUUID(),
      timestamp: this.now(),
      role: "speech",
      provider: "openai",
      model: "gpt-live-1",
      appId: context.appId,
      correlationId: context.correlationId,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUSD: 15 * rate,
      estimated: true,
      latencyMs: 0,
      status: "pending",
      seconds: 0,
    };
    this.records.push(record);
    this.options.onUsage?.(structuredClone(record));
    return {
      update: (seconds, final = false, confirmed = false) => {
        const cost =
          final && seconds === 0
            ? 0
            : Math.max(15, seconds + (final ? 0 : 5)) * rate;
        if (!final) this.checkBudget(Math.max(0, cost - record.costUSD));
        record.seconds = seconds;
        record.costUSD = cost;
        record.latencyMs = seconds * 1000;
        record.status = final ? (confirmed ? "success" : "failed") : "pending";
        record.estimated = true;
        this.options.onUsage?.(structuredClone(record));
      },
    };
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
    if (this.testingConfiguration)
      throw new Error("Wait for the AI connection check to finish.");
    return this.queue.run(
      () => this.perform(role, input, context),
      role === "conversation" ? 2 : role === "decision" ? 0 : 1,
      context.signal,
    );
  }
  private async perform(
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
        "Start a voice conversation to use the live voice model.",
      );
    if (!context.appId || !context.correlationId)
      throw new Error(
        "AI calls require application and correlation identities.",
      );
    if (route.provider === "demo" && !this.configuration.testProviderEnabled)
      throw new Error(
        "Connect AI in Settings. Scripted responses require the explicit test URL.",
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
    // UTF-8 bytes + framing is deliberately conservative for tokenizers. Catalog prices are conservative estimates; cached-token discounts are not assumed.
    const reservedInput =
      new TextEncoder().encode(encoded).length +
      input.messages.length * 32 +
      256;
    const reserved =
      route.provider === "demo" || route.provider === "chatgpt"
        ? 0
        : ((reservedInput * route.inputPerMillion +
            route.maxOutputTokens * route.outputPerMillion) /
            1_000_000) *
          tierMultiplier(route.serviceTier);
    this.checkBudget(reserved);
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
      serviceTier: route.serviceTier,
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
        AbortSignal.timeout(180_000),
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
          route.provider === "demo" || route.provider === "chatgpt"
            ? 0
            : (usage.costUSD ??
              ((usage.inputTokens * route.inputPerMillion +
                usage.outputTokens * route.outputPerMillion) /
                1_000_000) *
                tierMultiplier(result.serviceTier ?? route.serviceTier));
        record.serviceTier = result.serviceTier ?? route.serviceTier;
        record.estimated =
          usage.costUSD === undefined && route.provider !== "demo";
      }
      record.status = "success";
      if (route.provider !== "demo")
        this.updateHealth({ state: "ready", checkedAt: this.now() });
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
      if (
        route.provider !== "demo" &&
        error instanceof AIError &&
        error.kind !== "response"
      )
        this.updateHealth({ state: "error", message: error.message });
      // An interrupted request may still be billed. Retain its reservation instead of falsely reporting zero.
      this.event(context, "ai.failure", {
        role,
        requestId: record.id,
        error:
          error instanceof Error ? error.message : "Unknown provider failure",
        reservedUSD: reserved,
        ...(error instanceof AIError ? error.detail : {}),
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
    if (this.activeRequestCount || this.testingConfiguration)
      throw new Error(
        "Wait for the current AI request before changing the connection.",
      );
    checkConfig(config);
    const candidate = structuredClone(config);
    for (const route of Object.values(candidate.routes))
      route.maxOutputTokens = 2048;
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
    const prior = this.health;
    this.updateHealth({ state: "checking" });
    try {
      const checked = new Set<string>();
      for (const [role, route] of Object.entries(candidate.routes)) {
        if (role === "speech" || route.provider === "demo") continue;
        const key = `${route.provider}:${route.model}:${route.serviceTier}:${route.reasoningEffort}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const result = await probe.generate(
          role as AIRole,
          {
            messages: [
              {
                role: "user",
                content:
                  'Confirm the connection by replying with {"ready":true}.',
              },
            ],
            jsonSchema: {
              name: "connection_check",
              schema: {
                type: "object",
                properties: { ready: { type: "boolean" } },
                required: ["ready"],
                additionalProperties: false,
              },
            },
          },
          context,
        );
        if (!result.text.trim())
          throw new Error(
            "The AI connection returned an empty response. Try another model.",
          );
        if (JSON.parse(result.text).ready !== true)
          throw new AIError(
            "The connection check did not return the expected answer. Please try again.",
            "response",
          );
        const toolResult = await probe.generate(
          role as AIRole,
          {
            messages: [
              {
                role: "user",
                content:
                  "Call connection_check with ready true. This is a harmless connection test.",
              },
            ],
            tools: [
              {
                name: "connection_check",
                description: "Confirm tool support. No side effects.",
                parameters: {
                  type: "object",
                  properties: { ready: { type: "boolean" } },
                  required: ["ready"],
                  additionalProperties: false,
                },
              },
            ],
            toolChoice: "required",
          },
          context,
        );
        if (
          !toolResult.toolCalls.some(
            (call) =>
              call.name === "connection_check" &&
              JSON.parse(call.arguments).ready === true,
          )
        )
          throw new AIError(
            "This connection could answer, but could not perform application actions. Check your model selection.",
            "model",
          );
      }
      this.validated = JSON.stringify(config.routes);
      this.updateHealth({ state: "ready", checkedAt: this.now() });
    } catch (error) {
      this.updateHealth(
        prior.state === "ready"
          ? prior
          : {
              state: "error",
              message:
                error instanceof Error ? error.message : "Connection failed",
            },
      );
      throw error;
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
