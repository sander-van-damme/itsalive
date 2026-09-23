import type {
  LlmTraceEvent,
  LlmTraceIdentity,
  LlmTraceMetricRollup,
  LlmTraceRollup,
  NormalizedLlmUsage,
} from "./types";

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const id = (): string => globalThis.crypto?.randomUUID?.()
  ?? `trace-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function createLlmTraceIdentity(
  role: string,
  profile: string,
  options: {
    runId?: string;
    agentId?: string;
    parentRunId?: string;
    parentAgentId?: string;
    scope?: string;
  } = {},
): LlmTraceIdentity {
  const runId = options.runId ?? id();
  return {
    runId,
    agentId: options.agentId ?? runId,
    role,
    profile,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.parentAgentId ? { parentAgentId: options.parentAgentId } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  };
}

export function normalizeLlmUsage(usage: {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cost?: number;
} | undefined): NormalizedLlmUsage {
  return {
    inputTokens: finite(usage?.inputTokens),
    cachedInputTokens: finite(usage?.cachedInputTokens),
    cacheWriteTokens: finite(usage?.cacheWriteTokens),
    outputTokens: finite(usage?.outputTokens),
    reasoningTokens: finite(usage?.reasoningTokens),
    cost: finite(usage?.cost),
  };
}

function metric(events: readonly LlmTraceEvent[], key: keyof NormalizedLlmUsage): LlmTraceMetricRollup {
  let value = 0;
  let complete = true;
  for (const event of events) {
    const current = event.usage[key];
    if (current === null) complete = false;
    else value += current;
  }
  return { value, complete };
}

export class LlmTraceTracker {
  private readonly events: LlmTraceEvent[] = [];

  constructor(private readonly maxEvents = 500) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("maxEvents must be a positive integer");
  }

  record(event: LlmTraceEvent): void {
    this.events.push(structuredClone(event));
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  snapshot(): LlmTraceEvent[] {
    return this.events.map(event => structuredClone(event));
  }

  rollups(): LlmTraceRollup[] {
    const groups = new Map<string, LlmTraceEvent[]>();
    for (const event of this.events) {
      const key = [
        event.runId,
        event.agentId,
        event.role,
        event.profile,
        event.parentRunId ?? "",
        event.parentAgentId ?? "",
        event.scope ?? "",
      ].join("\u001f");
      const existing = groups.get(key);
      if (existing) existing.push(event);
      else groups.set(key, [event]);
    }

    return [...groups.values()].map(events => {
      const first = events[0]!;
      const turns = new Set(events.flatMap(event => event.turn == null ? [] : [event.turn]));
      return {
        runId: first.runId,
        agentId: first.agentId,
        role: first.role,
        profile: first.profile,
        ...(first.parentRunId ? { parentRunId: first.parentRunId } : {}),
        ...(first.parentAgentId ? { parentAgentId: first.parentAgentId } : {}),
        ...(first.scope ? { scope: first.scope } : {}),
        requests: events.length,
        successes: events.filter(event => event.status === "success").length,
        errors: events.filter(event => event.status === "error").length,
        elapsedMs: events.reduce((sum, event) => sum + event.elapsedMs, 0),
        turns: turns.size,
        inputTokens: metric(events, "inputTokens"),
        cachedInputTokens: metric(events, "cachedInputTokens"),
        cacheWriteTokens: metric(events, "cacheWriteTokens"),
        outputTokens: metric(events, "outputTokens"),
        reasoningTokens: metric(events, "reasoningTokens"),
        cost: metric(events, "cost"),
      };
    });
  }

  reset(): void {
    this.events.length = 0;
  }
}
