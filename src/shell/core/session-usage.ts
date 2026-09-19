import type { GenerateResult } from "./types";
import type { OpenRouterKeyInfo } from "./openrouter-account";

export interface SessionUsageSnapshot {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  costComplete: boolean;
  latestContextTokens?: number;
  contextCapacity?: number;
  keyUsage?: number;
  keyLimit?: number | null;
  keyLimitRemaining?: number | null;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class SessionUsageTracker {
  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private knownCost = 0;
  private pricedRequests = 0;
  private unpricedRequests = 0;
  private latestContextTokens?: number;
  private contextCapacity?: number;
  private keyInfo?: OpenRouterKeyInfo;

  recordGeneration(usage: GenerateResult["usage"]): void {
    this.requests++;
    this.inputTokens += finiteNonNegative(usage?.inputTokens) ?? 0;
    this.outputTokens += finiteNonNegative(usage?.outputTokens) ?? 0;
    const cost = finiteNonNegative(usage?.cost);
    if (cost === undefined) this.unpricedRequests++;
    else {
      this.knownCost += cost;
      this.pricedRequests++;
    }
  }

  recordUnpricedUsage(usage?: { inputTokens?: number; outputTokens?: number }): void {
    this.requests++;
    this.inputTokens += finiteNonNegative(usage?.inputTokens) ?? 0;
    this.outputTokens += finiteNonNegative(usage?.outputTokens) ?? 0;
    this.unpricedRequests++;
  }

  setContext(inputTokens: number, capacity: number): void {
    this.latestContextTokens = finiteNonNegative(inputTokens);
    this.contextCapacity = finiteNonNegative(capacity);
  }

  setKeyInfo(info: OpenRouterKeyInfo): void { this.keyInfo = info; }

  reset(): void {
    this.requests = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.knownCost = 0;
    this.pricedRequests = 0;
    this.unpricedRequests = 0;
    this.latestContextTokens = undefined;
    this.contextCapacity = undefined;
    this.keyInfo = undefined;
  }

  snapshot(): SessionUsageSnapshot {
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.pricedRequests > 0 ? { cost: this.knownCost } : {}),
      costComplete: this.unpricedRequests === 0,
      ...(this.latestContextTokens !== undefined ? { latestContextTokens: this.latestContextTokens } : {}),
      ...(this.contextCapacity !== undefined ? { contextCapacity: this.contextCapacity } : {}),
      ...(this.keyInfo?.usage !== undefined ? { keyUsage: this.keyInfo.usage } : {}),
      ...(this.keyInfo?.limit !== undefined ? { keyLimit: this.keyInfo.limit } : {}),
      ...(this.keyInfo?.limitRemaining !== undefined ? { keyLimitRemaining: this.keyInfo.limitRemaining } : {}),
    };
  }
}
