import type { GenerateResult } from "./types";
import type { OpenRouterKeyInfo } from "./openrouter-account";

export interface UsageBucketState {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  knownCost: number;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface SessionUsageState {
  llm: UsageBucketState;
  jev: UsageBucketState;
}

export interface UsageBucketSnapshot {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  costComplete: boolean;
}

export interface SessionUsageSnapshot {
  llm: UsageBucketSnapshot;
  jev: UsageBucketSnapshot;
  latestContextTokens?: number;
  contextCapacity?: number;
  keyUsage?: number;
  keyLimit?: number | null;
  keyLimitRemaining?: number | null;
}

type MeterUsage = { inputTokens?: number; outputTokens?: number; cost?: number };

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function emptyBucket(): UsageBucketState {
  return { requests: 0, inputTokens: 0, outputTokens: 0, knownCost: 0, pricedRequests: 0, unpricedRequests: 0 };
}

function restoreBucket(initial?: Partial<UsageBucketState>): UsageBucketState {
  if (!initial) return emptyBucket();
  return {
    requests: Math.floor(finiteNonNegative(initial.requests) ?? 0),
    inputTokens: finiteNonNegative(initial.inputTokens) ?? 0,
    outputTokens: finiteNonNegative(initial.outputTokens) ?? 0,
    knownCost: finiteNonNegative(initial.knownCost) ?? 0,
    pricedRequests: Math.floor(finiteNonNegative(initial.pricedRequests) ?? 0),
    unpricedRequests: Math.floor(finiteNonNegative(initial.unpricedRequests) ?? 0),
  };
}

function record(bucket: UsageBucketState, usage?: MeterUsage): void {
  bucket.requests++;
  bucket.inputTokens += finiteNonNegative(usage?.inputTokens) ?? 0;
  bucket.outputTokens += finiteNonNegative(usage?.outputTokens) ?? 0;
  const cost = finiteNonNegative(usage?.cost);
  if (cost === undefined) bucket.unpricedRequests++;
  else {
    bucket.knownCost += cost;
    bucket.pricedRequests++;
  }
}

function snapshotBucket(bucket: UsageBucketState): UsageBucketSnapshot {
  return {
    requests: bucket.requests,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    ...(bucket.pricedRequests > 0 ? { cost: bucket.knownCost } : {}),
    costComplete: bucket.unpricedRequests === 0,
  };
}

export class SessionUsageTracker {
  private llm: UsageBucketState;
  private jev: UsageBucketState;
  private latestContextTokens?: number;
  private contextCapacity?: number;
  private keyInfo?: OpenRouterKeyInfo;

  constructor(initial?: Partial<SessionUsageState>) {
    this.llm = restoreBucket(initial?.llm);
    this.jev = restoreBucket(initial?.jev);
  }

  recordLlmGeneration(usage: GenerateResult["usage"]): void {
    record(this.llm, usage);
  }

  recordJevDecision(usage?: MeterUsage): void {
    record(this.jev, usage);
  }

  setContext(inputTokens: number, capacity: number): void {
    this.latestContextTokens = finiteNonNegative(inputTokens);
    this.contextCapacity = finiteNonNegative(capacity);
  }

  setKeyInfo(info: OpenRouterKeyInfo): void { this.keyInfo = info; }

  reset(): void {
    this.llm = emptyBucket();
    this.jev = emptyBucket();
    this.latestContextTokens = undefined;
    this.contextCapacity = undefined;
    this.keyInfo = undefined;
  }

  state(): SessionUsageState {
    return {
      llm: { ...this.llm },
      jev: { ...this.jev },
    };
  }

  snapshot(): SessionUsageSnapshot {
    return {
      llm: snapshotBucket(this.llm),
      jev: snapshotBucket(this.jev),
      ...(this.latestContextTokens !== undefined ? { latestContextTokens: this.latestContextTokens } : {}),
      ...(this.contextCapacity !== undefined ? { contextCapacity: this.contextCapacity } : {}),
      ...(this.keyInfo?.usage !== undefined ? { keyUsage: this.keyInfo.usage } : {}),
      ...(this.keyInfo?.limit !== undefined ? { keyLimit: this.keyInfo.limit } : {}),
      ...(this.keyInfo?.limitRemaining !== undefined ? { keyLimitRemaining: this.keyInfo.limitRemaining } : {}),
    };
  }
}
