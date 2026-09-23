import { SYSTEM_PROMPT } from "./system-prompt";
import type { HistoryEntry, ModelConfig, ModelMessage } from "./types";

export type TokenCounter = (text: string) => number;
export const conservativeTokenEstimate: TokenCounter = (text) => Math.ceil(new TextEncoder().encode(text).length / 3);

export interface ContextInput {
  model: ModelConfig;
  appPrompt: string;
  behaviorSummary?: string;
  trigger: string;
  observation?: string;
  environmentObservation?: string;
  history: HistoryEntry[];
  /** Benchmark/profile override. Production callers default to SYSTEM_PROMPT. */
  systemPrompt?: string;
  countTokens?: TokenCounter;
}

export interface ContextTokenBreakdown {
  system: number;
  mandatory: number;
  observation: number;
  environmentObservation: number;
  history: number;
  total: number;
}

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  estimatedInputTokens: number;
  includedHistoryIds: number[];
  omittedHistoryCount: number;
  historyTokens: number;
  historyTokenBudget: number;
  tokenBreakdown: ContextTokenBreakdown;
}

const section = (title: string, body: string) => `${title}\n${body.trim() || "(none)"}`;

export function buildModelContext(input: ContextInput): BuiltContext {
  const count = input.countTokens ?? conservativeTokenEstimate;
  const system = input.systemPrompt ?? SYSTEM_PROMPT;
  const headroom = input.model.observationHeadroomTokens ?? 1_024;
  const budget = input.model.maxContextTokens - input.model.outputHeadroomTokens - headroom;
  const mandatory = [
    section("APP PROMPT", input.appPrompt),
    ...(input.behaviorSummary?.trim() ? [section("CURATED BEHAVIORAL HISTORY", input.behaviorSummary)] : []),
    section("CURRENT TECHNICAL INTENT", input.trigger),
  ].join("\n\n");
  const systemTokens = count(system);
  const mandatoryTokens = count(mandatory);
  const baseCost = systemTokens + mandatoryTokens;
  if (baseCost > budget) throw new Error(`Mandatory context (${baseCost} tokens estimated) exceeds input budget (${budget}); choose a larger-context model or shorten the app prompt/trigger`);

  const messages: ModelMessage[] = [{ role: "user", content: mandatory }];
  let used = baseCost;
  let observationTokens = 0;
  let environmentObservationTokens = 0;

  if (input.observation) {
    const maxObservation = Math.max(128, Math.min(headroom * 3, budget - used));
    const bounded = truncateToTokens(input.observation, maxObservation, count);
    const content = section("LAST EXECUTION OBSERVATION", bounded);
    const cost = count(content);
    if (used + cost <= budget) {
      messages.push({ role: "user", content });
      observationTokens = cost;
      used += cost;
    }
  }

  if (input.environmentObservation) {
    const content = section(
      "NEW ENVIRONMENT OBSERVATION",
      truncateToTokens(input.environmentObservation, Math.max(128, headroom * 3), count),
    );
    const cost = count(content);
    if (used + cost <= budget) {
      messages.push({ role: "user", content });
      environmentObservationTokens = cost;
      used += cost;
    }
  }

  const candidates = historyCandidates(input.history, input.observation);
  const historyBudget = Math.min(
    Math.max(0, budget - used),
    Math.max(0, input.model.historyContextTokens),
  );
  let historyUsed = 0;
  const selected: HistoryEntry[] = [];
  for (const entry of [...candidates].sort((a, b) => b.timestamp - a.timestamp)) {
    const cost = count(entry.content) + 8;
    if (historyUsed + cost > historyBudget || used + cost > budget) continue;
    selected.push(entry);
    historyUsed += cost;
    used += cost;
  }

  selected.reverse();
  messages.splice(0, 0, ...selected.map((entry): ModelMessage => ({
    role: entry.role === "assistant" || entry.role === "agent" ? "assistant" : "user",
    content: entry.content,
  })));

  return {
    system,
    messages,
    estimatedInputTokens: used,
    includedHistoryIds: selected.flatMap(x => x.id == null ? [] : [x.id]),
    omittedHistoryCount: input.history.length - selected.length,
    historyTokens: historyUsed,
    historyTokenBudget: historyBudget,
    tokenBreakdown: {
      system: systemTokens,
      mandatory: mandatoryTokens,
      observation: observationTokens,
      environmentObservation: environmentObservationTokens,
      history: historyUsed,
      total: used,
    },
  };
}

function historyCandidates(history: HistoryEntry[], observation?: string): HistoryEntry[] {
  const excluded = new Set<number>();
  const newestMatching = (predicate: (entry: HistoryEntry) => boolean) => {
    for (let index = history.length - 1; index >= 0; index--) {
      if (!excluded.has(index) && predicate(history[index]!)) {
        excluded.add(index);
        return;
      }
    }
  };

  if (observation) newestMatching(entry => entry.role === "observation" && entry.content === observation);

  return history.filter((entry, index) => !excluded.has(index) && isTechnicalHistory(entry));
}

function isTechnicalHistory(entry: HistoryEntry): boolean {
  if (entry.role === "observation" || entry.role === "agent") return true;
  return entry.kind === "javascript" || entry.kind === "execution" || entry.kind === "error";
}

function truncateToTokens(value: string, limit: number, count: TokenCounter): string {
  if (count(value) <= limit) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (count(value.slice(0, mid)) <= limit) low = mid; else high = mid - 1;
  }
  return `${value.slice(0, Math.max(0, low - 14))}\n…[truncated]`;
}
