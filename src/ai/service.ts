import {
  supportsDecisions,
  validateDecisionInput,
  type DecisionInput,
  type DecisionResponse,
} from "./decisions";
import type {
  AIConfig,
  AIContext,
  AIEvent,
  AIResponse,
  ModelRoute,
  AIRole,
  ApplicationAIRequest,
  GenerateInput,
  Provider,
  ProviderId,
  UsageRecord,
  ProviderCredentials,
} from "./types";
import { AIError, HTTPProvider } from "./providers";
import { MODEL_CHOICES, normalizeAIConfig, tierMultiplier } from "./types";
import { RequestQueue } from "./queue";
import { DemoProvider } from "./demo";
import { redactCredentials } from "../shared/redaction";
import type { VoiceUsageDetails } from "./speech";

export interface AIServiceOptions {
  beforeRequest?: () => void;
  credentials?: () => ProviderCredentials;
  onHealth?: (health: ConnectionHealth) => void;
  providers?: Partial<Record<ProviderId, Provider>>;
  log?: (event: AIEvent) => void;
  /** Removes account credentials held outside the service's routing markers. */
  sanitizeDiagnostic?: (value: unknown) => unknown;
  onUsage?: (record: UsageRecord) => void | Promise<void>;
  now?: () => number;
}
export interface ConnectionHealth {
  state: "unchecked" | "checking" | "ready" | "error";
  message?: string;
  checkedAt?: number;
}

export function redact(value: unknown, secrets: string[] = []): unknown {
  const normalize = (item: unknown): unknown => {
    if (typeof item === "string")
      return item
        .replaceAll("Bearer [redacted]", "[REDACTED]")
        .replaceAll("[redacted]", "[REDACTED]");
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [key, normalize(entry)]),
      );
    return item;
  };
  return normalize(redactCredentials(value, { secrets }));
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
      !Number.isFinite(route.inputPerMillion) ||
      !Number.isFinite(route.outputPerMillion) ||
      route.inputPerMillion < 0 ||
      route.outputPerMillion < 0
    )
      throw new Error("Invalid AI model configuration.");
    if (
      [route.cachedInputPerMillion, route.cacheWritePerMillion].some(
        (price) =>
          price !== undefined && (!Number.isFinite(price) || price < 0),
      )
    )
      throw new Error("Invalid cached-token pricing.");
  }
}

export class AIService {
  private configuration: AIConfig;
  private active = 0;
  private testingConfiguration = false;
  private records: UsageRecord[] = [];
  private readonly unpersistedUsage = new Set<string>();
  private readonly usageWrites = new Set<Promise<void>>();
  private readonly usageWriteTails = new Map<string, Promise<void>>();
  private readonly providers: Record<ProviderId, Provider>;
  private readonly now: () => number;
  private readonly queue: RequestQueue;
  private validated = "";
  // Private in-memory comparison only; never logged or persisted.
  private validatedCredentials: ProviderCredentials = {};
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
    this.configuration = normalizeAIConfig(config);
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
    return this.records.reduce(
      (sum, record) =>
        sum +
        (record.costStatus === "unknown" || record.status === "pending"
          ? 0
          : record.costUSD),
      0,
    );
  }
  get periodSpentUSD(): number {
    const date = new Date(this.now());
    const start =
      this.configuration.limits.budgetPeriod === "month"
        ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
        : 0;
    return this.records
      .filter(
        (record) =>
          record.timestamp >= start &&
          record.status !== "pending" &&
          record.costStatus !== "unknown",
      )
      .reduce((sum, record) => sum + record.costUSD, 0);
  }
  get unknownCostCount(): number {
    return this.records.filter((record) => record.costStatus === "unknown")
      .length;
  }
  private connectionIdentity(config: AIConfig): string {
    return JSON.stringify(
      Object.entries(config.routes).map(([role, route]) => [
        role,
        route.provider,
        route.model,
        route.reasoningEffort,
        route.serviceTier,
      ]),
    );
  }
  private checkBudget() {
    if (
      this.configuration.limits.budgetEnabled === true &&
      this.periodSpentUSD >= this.configuration.limits.budgetUSD
    )
      throw new AIError(
        "Your recorded spending has reached your spending limit. You can change it in Settings → Usage. Requests already in progress may add further costs.",
        "limit",
      );
  }
  resetHealth(): void {
    this.validated = "";
    this.validatedCredentials = {};
    this.updateHealth({ state: "unchecked" });
  }
  configure(config: AIConfig): void {
    checkConfig(config);
    const changed =
      this.connectionIdentity(config) !==
      this.connectionIdentity(this.configuration);
    this.configuration = normalizeAIConfig(config);
    if (changed)
      this.updateHealth(
        this.connectionIdentity(config) === this.validated
          ? { state: "ready", checkedAt: this.now() }
          : { state: "unchecked" },
      );
  }
  private persistUsage(record: UsageRecord): Promise<void> {
    const snapshot = structuredClone(record);
    // Voice can publish a final update while its initial marker is still being
    // written. Preserve order for that request, without serializing other work.
    const previous = this.usageWriteTails.get(record.id) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(() => this.options.onUsage?.(snapshot));
    this.usageWriteTails.set(record.id, write);
    this.usageWrites.add(write);
    const settled = () => {
      this.usageWrites.delete(write);
      if (this.usageWriteTails.get(record.id) === write)
        this.usageWriteTails.delete(record.id);
    };
    void write.then(settled, settled);
    return write;
  }
  /** Flush the ledger before a diagnostic or backup snapshot; expose unsaved data explicitly. */
  async flushUsage(): Promise<{
    pendingWrites: number;
    unpersistedRecords: UsageRecord[];
  }> {
    await Promise.allSettled([...this.usageWrites]);
    for (const id of [...this.unpersistedUsage]) {
      const record = this.records.find((entry) => entry.id === id);
      if (!record) {
        this.unpersistedUsage.delete(id);
        continue;
      }
      try {
        await this.persistUsage(record);
        this.unpersistedUsage.delete(id);
      } catch {
        /* Declared below; evidence export remains available. */
      }
    }
    return {
      pendingWrites: this.usageWrites.size,
      unpersistedRecords: this.usage.filter((record) =>
        this.unpersistedUsage.has(record.id),
      ),
    };
  }
  startVoice(context: AIContext): {
    update(
      seconds: number,
      final?: boolean,
      confirmed?: boolean,
      details?: VoiceUsageDetails,
    ): void;
  } {
    const rate = 0.05 / 60;
    this.checkBudget();
    const record: UsageRecord & { voiceAccounting?: Record<string, unknown> } =
      {
        id: crypto.randomUUID(),
        timestamp: this.now(),
        role: "speech",
        provider: "openai",
        model: this.configuration.routes.speech.model,
        appId: context.appId,
        correlationId: context.correlationId,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUSD: 0,
        costStatus: "unknown",
        usageStatus: "unknown",
        estimated: true,
        latencyMs: 0,
        status: "pending",
        seconds: 0,
      };
    this.records.push(record);
    let settled = false;
    const persist = () => {
      void this.persistUsage(record)
        .then(() => this.unpersistedUsage.delete(record.id))
        .catch((error: unknown) => {
          this.unpersistedUsage.add(record.id);
          this.event(context, "ai.accounting.persist.failure", {
            requestId: record.id,
            role: "speech",
            error,
          });
        });
    };
    this.event(context, "voice.accounting.started", {
      requestId: record.id,
      model: record.model,
    });
    persist();
    return {
      update: (seconds, final = false, confirmed = false, details) => {
        if (settled) return;
        const observedSeconds = Number.isFinite(seconds)
          ? Math.max(0, seconds)
          : 0;
        const providerSeconds =
          details?.providerSeconds ?? (confirmed ? observedSeconds : undefined);
        const created = details?.sessionCreated ?? confirmed;
        const initializationSeconds = created
          ? (details?.initializationSeconds ?? 0)
          : 0;
        const billedSeconds = created
          ? Math.max(providerSeconds ?? observedSeconds, initializationSeconds)
          : 0;
        const neverBilled =
          details?.sessionCreateOutcome === "not-attempted" ||
          details?.sessionCreateOutcome === "rejected";
        record.seconds = providerSeconds ?? observedSeconds;
        record.costUSD = billedSeconds * rate;
        record.costStatus = created
          ? "estimated"
          : neverBilled
            ? "not-billed"
            : "unknown";
        record.usageStatus =
          providerSeconds === undefined ? "unknown" : "reported";
        record.latencyMs =
          details?.elapsedMs ?? Math.max(0, this.now() - record.timestamp);
        record.status = final
          ? details?.outcome === "completed" || (!details && confirmed)
            ? "success"
            : "failed"
          : "pending";
        record.estimated = record.costStatus === "estimated";
        record.voiceAccounting = {
          measuredSeconds: record.latencyMs / 1000,
          observedSeconds,
          providerSeconds: providerSeconds ?? null,
          sessionCreateOutcome:
            details?.sessionCreateOutcome ?? (created ? "created" : "unknown"),
          initializationSeconds,
          estimatedBillableSeconds: created ? billedSeconds : null,
          estimatedRatePerMinuteUSD: 0.05,
          outcome:
            details?.outcome ??
            (final ? (confirmed ? "completed" : "failed") : "active"),
          failureStage: details?.failureStage ?? null,
        };
        settled = final;
        persist();
        if (final)
          this.event(context, "voice.accounting.finished", {
            requestId: record.id,
            seconds: record.seconds,
            latencyMs: record.latencyMs,
            costUSD: record.costStatus === "unknown" ? null : record.costUSD,
            costStatus: record.costStatus,
            usageStatus: record.usageStatus,
            ...record.voiceAccounting,
          });
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
    this.records = structuredClone(records).map((record) => {
      // Interrupted old ledgers contain reservations, not charges. Do not carry them into recorded spending.
      if (
        record.status === "pending" ||
        (!record.costStatus &&
          record.status === "failed" &&
          !record.inputTokens &&
          !record.outputTokens)
      )
        return {
          ...record,
          status: "failed" as const,
          costUSD: 0,
          estimated: true,
          costStatus:
            record.provider === "openai"
              ? ("unknown" as const)
              : ("not-billed" as const),
          usageStatus: "unknown" as const,
        };
      return {
        ...record,
        costStatus:
          record.costStatus ?? (record.estimated ? "estimated" : "reported"),
        usageStatus:
          record.usageStatus ??
          (record.inputTokens || record.outputTokens ? "reported" : "unknown"),
      };
    });
  }
  private event(
    context: AIContext,
    event: string,
    data: Record<string, unknown>,
    level: "INFO" | "DEBUG" = "INFO",
  ): void {
    const secrets = Object.entries(this.options.credentials?.() ?? {})
      .filter(
        ([provider, value]) =>
          !(provider === "chatgpt" && value === "connected"),
      )
      .map(([, value]) => value)
      .filter((value): value is string => !!value);
    try {
      const sanitized = this.options.sanitizeDiagnostic
        ? this.options.sanitizeDiagnostic(data)
        : data;
      this.options.log?.({
        event,
        level,
        appId: context.appId,
        correlationId: context.correlationId,
        data: redact(sanitized, secrets) as Record<string, unknown>,
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
    // A previous final write may have failed after billing. Repair that durable
    // ledger before starting any further request, including explicit retries.
    for (const id of [...this.unpersistedUsage]) {
      const record = this.records.find((item) => item.id === id);
      if (!record) {
        this.unpersistedUsage.delete(id);
        continue;
      }
      try {
        await this.persistUsage(record);
        this.unpersistedUsage.delete(id);
      } catch {
        throw new AIError(
          "Previous AI usage could not be saved. Free some browser storage before retrying.",
          "accounting",
          { reason: "usage_persistence_failed", requestId: id },
        );
      }
    }
    context.signal?.throwIfAborted();
    if (this.testingConfiguration)
      throw new Error("Wait for the AI connection check to finish.");
    const configuredRoute = this.configuration.routes[role];
    // Decisions bills input only and does not accept a service tier parameter.
    const route =
      input.decisions && configuredRoute
        ? {
            ...configuredRoute,
            inputPerMillion: 0.1,
            cachedInputPerMillion: 0.01,
            cacheWritePerMillion: 0.125,
            outputPerMillion: 0,
            serviceTier: "default" as const,
          }
        : configuredRoute;
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
    if (input.decisions) {
      validateDecisionInput(input.decisions);
      if (!supportsDecisions(route))
        throw new AIError(
          "The selected provider or model does not support OpenAI Decisions.",
          "model",
        );
    }
    const encoded = JSON.stringify(input);
    const credential =
      route.provider === "demo"
        ? ""
        : (this.options.credentials?.()[route.provider] ?? "");
    if (route.provider !== "demo" && !credential)
      throw new Error(`Add a ${route.provider} key in Settings.`);
    const now = this.now();
    const captureContent = this.configuration.captureContent;
    if (route.provider === "openai") this.checkBudget();
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
      costUSD: 0,
      costStatus: route.provider === "openai" ? "unknown" : "not-billed",
      usageStatus: "unknown",
      estimated: route.provider === "openai",
      latencyMs: 0,
      status: "pending",
      serviceTier: route.serviceTier,
    };
    this.records.push(record);
    this.active++;
    try {
      await this.persistUsage(record);
    } catch {
      this.active--;
      this.records = this.records.filter((item) => item.id !== record.id);
      const detail = {
        requestId: record.id,
        reason: "pending_usage_persistence_failed",
      };
      this.event(context, "ai.accounting.persist.failure", detail);
      throw new AIError(
        "Could not save AI usage before starting the request. Free some browser storage and retry.",
        "accounting",
        detail,
      );
    }
    this.event(context, "ai.request", {
      role,
      provider: route.provider,
      model: route.model,
      requestId: record.id,
      costStatus: record.costStatus,
      inputCharacters: encoded.length,
      captureContent,
    });
    this.event(
      context,
      "ai.request.parameters",
      {
        role,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        serviceTier: route.serviceTier,
        messageCount: input.messages.length,
        toolCount: input.tools?.length ?? 0,
      },
      "DEBUG",
    );
    if (captureContent)
      this.event(
        context,
        "ai.request.content",
        { requestId: record.id, role, route, ...input },
        "DEBUG",
      );
    let providerStarted = false;
    let outcome: AIResponse | undefined;
    let providerFailure: unknown;
    try {
      context.signal?.throwIfAborted();
      if (route.provider === "openai") this.checkBudget();
      providerStarted = true;
      const providerInput = { ...input, captureContent };
      const result = await this.providers[route.provider].generate(
        route,
        providerInput,
        credential,
        context.signal,
      );
      outcome = result;
      this.applyUsage(record, result, route);
      context.signal?.throwIfAborted();
      record.status = "success";
      if (route.provider !== "demo")
        this.updateHealth({ state: "ready", checkedAt: this.now() });
      this.event(context, "ai.response", {
        role,
        requestId: record.id,
        providerResponseId: result.requestId,
        providerRequestId: (
          result as AIResponse & { providerRequestId?: string }
        ).providerRequestId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costUSD: record.costStatus === "unknown" ? null : record.costUSD,
        estimated: record.estimated,
        usageStatus: record.usageStatus,
        costStatus: record.costStatus,
        completion: result.completion,
        latencyMs: this.now() - now,
        toolCalls: result.toolCalls.map((call) => call.name),
      });
      if (captureContent)
        this.event(
          context,
          "ai.response.content",
          { requestId: record.id, role, response: result },
          "DEBUG",
        );
      return result;
    } catch (error) {
      providerFailure = error;
      if (error instanceof AIError) outcome = error.response;
      record.status = "failed";
      if (!providerStarted) {
        record.costStatus = "not-billed";
        record.estimated = false;
      }
      if (error instanceof AIError && error.response)
        this.applyUsage(record, error.response, route);
      if (
        route.provider !== "demo" &&
        error instanceof AIError &&
        !["response", "cancelled", "context"].includes(error.kind)
      ) {
        this.validated = "";
        this.validatedCredentials = {};
        this.updateHealth({ state: "error", message: error.message });
      }
      // Missing provider usage remains explicitly unknown; it is never presented as a precise charge.
      this.event(context, "ai.failure", {
        role,
        requestId: record.id,
        error: error,
        costStatus: record.costStatus,
        usageStatus: record.usageStatus,
        costUSD: record.costStatus === "unknown" ? null : record.costUSD,
        inputTokens:
          record.usageStatus === "unknown" ? null : record.inputTokens,
        outputTokens:
          record.usageStatus === "unknown" ? null : record.outputTokens,
        latencyMs: this.now() - now,
        ...(error instanceof AIError
          ? {
              kind: error.kind,
              providerDetail: error.detail,
              providerRequestId: error.detail.requestId,
            }
          : {}),
      });
      if (captureContent && outcome)
        this.event(
          context,
          "ai.response.content",
          { requestId: record.id, role, response: outcome, failed: true },
          "DEBUG",
        );
      throw error;
    } finally {
      record.latencyMs = this.now() - now;
      try {
        await this.persistUsage(record);
        this.unpersistedUsage.delete(record.id);
      } catch {
        this.unpersistedUsage.add(record.id);
        const detail = {
          requestId: record.id,
          reason: "usage_persistence_failed",
          ...(providerFailure instanceof AIError
            ? {
                providerFailureKind: providerFailure.kind,
                providerFailureReason: providerFailure.detail.reason,
              }
            : {}),
        };
        this.event(context, "ai.accounting.persist.failure", detail);
        throw new AIError(
          "The AI request finished, but its usage could not be saved. Free some browser storage before retrying. The working application is safe.",
          "accounting",
          detail,
          outcome
            ? {
                ...outcome,
                completion: {
                  status: outcome.completion?.status ?? "completed",
                  reason: "usage_persistence_failed",
                  recoverable: false,
                },
              }
            : undefined,
        );
      } finally {
        this.active--;
      }
    }
  }
  private applyUsage(
    record: UsageRecord,
    result: AIResponse,
    route: ModelRoute,
  ): void {
    const usage = result.usage;
    if (
      !usage ||
      ![
        usage.inputTokens,
        usage.outputTokens,
        usage.cachedTokens,
        usage.cacheWriteTokens ?? 0,
      ].every((value) => Number.isFinite(value) && value >= 0) ||
      usage.cachedTokens + (usage.cacheWriteTokens ?? 0) > usage.inputTokens ||
      (usage.costUSD !== undefined &&
        (!Number.isFinite(usage.costUSD) || usage.costUSD < 0))
    )
      return;
    record.inputTokens = usage.inputTokens;
    record.outputTokens = usage.outputTokens;
    record.cachedTokens = usage.cachedTokens;
    record.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
    record.usageStatus = "reported";
    record.serviceTier = result.serviceTier ?? route.serviceTier;
    const notBilled = route.provider === "demo" || route.provider === "chatgpt";
    const longContext =
      MODEL_CHOICES.some((model) => model.id === route.model) &&
      usage.inputTokens > 272_000;
    const inputRate = route.inputPerMillion * (longContext ? 2 : 1);
    const cachedRate =
      (route.cachedInputPerMillion ?? route.inputPerMillion) *
      (longContext ? 2 : 1);
    const writeRate =
      (route.cacheWritePerMillion ?? route.inputPerMillion) *
      (longContext ? 2 : 1);
    const outputRate = route.outputPerMillion * (longContext ? 1.5 : 1);
    record.costUSD = notBilled
      ? 0
      : (usage.costUSD ??
        (((usage.inputTokens - usage.cachedTokens - record.cacheWriteTokens) *
          inputRate +
          usage.cachedTokens * cachedRate +
          record.cacheWriteTokens * writeRate +
          usage.outputTokens * outputRate) /
          1_000_000) *
          tierMultiplier(record.serviceTier));
    record.costStatus = notBilled
      ? "not-billed"
      : usage.costUSD === undefined
        ? "estimated"
        : "reported";
    record.estimated = record.costStatus === "estimated";
  }
  /** Probe actual configured models without committing credentials or routing on failure.
   * Probe requests share the durable accounting ledger and block competing requests.
   */
  async testConfiguration(
    config: AIConfig,
    credentials: ProviderCredentials,
    context: AIContext,
    options: { force?: boolean } = {},
  ): Promise<void> {
    context.signal?.throwIfAborted();
    const identity = this.connectionIdentity(config);
    const currentCredentials =
      this.options.credentials?.() ?? this.validatedCredentials;
    const checkingSavedConnection =
      identity === this.connectionIdentity(this.configuration) &&
      Object.entries(credentials).every(
        ([key, value]) =>
          currentCredentials[key as keyof ProviderCredentials] === value,
      );
    if (
      !options.force &&
      identity === this.validated &&
      Object.keys(credentials).length ===
        Object.keys(this.validatedCredentials).length &&
      Object.entries(credentials).every(
        ([key, value]) =>
          this.validatedCredentials[key as keyof ProviderCredentials] === value,
      )
    ) {
      this.updateHealth({ state: "ready", checkedAt: this.now() });
      return;
    }
    if (this.activeRequestCount || this.testingConfiguration)
      throw new Error(
        "Wait for the current AI request before changing the connection.",
      );
    checkConfig(config);
    const candidate = normalizeAIConfig(config);
    const probe = new AIService(candidate, {
      providers: this.providers,
      credentials: () => credentials,
      beforeRequest: this.options.beforeRequest,
      log: this.options.log,
      now: this.now,
      onUsage: async (record) => {
        const index = this.records.findIndex((item) => item.id === record.id);
        if (index === -1) this.records.push(record);
        else this.records[index] = record;
        try {
          await this.persistUsage(record);
          this.unpersistedUsage.delete(record.id);
        } catch (error) {
          // A probe that never started must not leave a phantom pending charge in the parent ledger.
          if (record.status === "pending")
            this.records = this.records.filter((item) => item.id !== record.id);
          else this.unpersistedUsage.add(record.id);
          throw error;
        }
      },
    });
    probe.importUsage(this.usage);
    for (const id of this.unpersistedUsage) probe.unpersistedUsage.add(id);
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
      if (supportsDecisions(candidate.routes.decision)) {
        const decision = await probe.decide(
          {
            input: "2 is greater than 1.",
            questions: [
              {
                type: "predicate",
                name: "connection_check",
                instructions:
                  "Is the statement true? This is an inert connection capability check.",
              },
            ],
          },
          context,
        );
        const answer = decision.answers[0];
        if (
          answer?.type !== "predicate" ||
          answer.name !== "connection_check" ||
          !Number.isFinite(answer.probability) ||
          answer.probability < 0.5 ||
          answer.probability > 1
        )
          throw new AIError(
            "The connection could generate replies but could not make the requested bounded decision. Check the decision model access.",
            "model",
          );
      }
      context.signal?.throwIfAborted();
      this.validated = identity;
      this.validatedCredentials = { ...credentials };
      this.updateHealth({ state: "ready", checkedAt: this.now() });
    } catch (error) {
      if (identity === this.validated) {
        this.validated = "";
        this.validatedCredentials = {};
      }
      this.updateHealth(
        prior.state === "ready" && !checkingSavedConnection
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
  /** Detailed answers preserve uncertainty; callers, not this API, authorize actions. */
  async decide(
    input: DecisionInput,
    context: AIContext,
  ): Promise<DecisionResponse> {
    const result = await this.generate(
      "decision",
      { messages: [], decisions: input },
      context,
    );
    if (!result.answers)
      throw new Error(
        "The configured provider did not return bounded decisions.",
      );
    return result as DecisionResponse;
  }
  async application(
    request: ApplicationAIRequest,
    context: AIContext,
  ): Promise<string | boolean | number> {
    if (
      !request ||
      typeof request.prompt !== "string" ||
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
        request.options.some((option) => typeof option !== "string") ||
        new Set(request.options).size !== request.options.length
      )
        throw new Error("Choose requires at least two distinct text options.");
      valueSchema = { type: "string", enum: request.options };
    } else {
      if (
        !Array.isArray(request.levels) ||
        request.levels.length < 2 ||
        request.levels.some((level) => typeof level !== "string")
      )
        throw new Error("Score requires at least two named levels.");
      valueSchema = {
        type: "number",
        minimum: 0,
        maximum: request.levels.length - 1,
      };
    }
    // Supported bounded judgments use Decisions. Larger cardinalities or other
    // configured models keep the general structured-output contract via Responses.
    if (
      supportsDecisions(this.configuration.routes.decision) &&
      (request.method !== "choose" || request.options!.length <= 255) &&
      (request.method !== "score" || request.levels!.length <= 10)
    ) {
      const question =
        request.method === "decide"
          ? {
              type: "predicate" as const,
              name: "result",
              instructions: request.prompt,
            }
          : request.method === "choose"
            ? {
                type: "choice" as const,
                name: "result",
                instructions: request.prompt,
                choices: request.options!.map((value) => ({ value })),
              }
            : {
                type: "score" as const,
                name: "result",
                instructions: request.prompt,
                levels: request.levels!.map((label) => ({ label })),
              };
      const result = await this.decide(
        {
          input:
            request.context === undefined
              ? ""
              : JSON.stringify(request.context),
          questions: [question],
        },
        context,
      );
      const answer = result.answers[0]!;
      if (answer.type === "refusal")
        throw new Error(
          "The AI could not make this decision. Try a different question.",
        );
      // Existing primitive API uses the most likely answer, never authorization
      // for destructive platform changes. Internal callers can use decide() for
      // the complete probabilities and choose their own evidence-based threshold.
      if (answer.type === "predicate") return answer.probability >= 0.5;
      if (answer.type === "choice") return answer.choice;
      return answer.score;
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
