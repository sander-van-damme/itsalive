import { SYSTEM_PROMPT } from "./system-prompt";
import type { HistoryEntry, ModelConfig, ModelMessage } from "./types";

export type TokenCounter = (text: string) => number;
export const conservativeTokenEstimate: TokenCounter = (text) => Math.ceil(new TextEncoder().encode(text).length / 3);

export interface ContextInput {
  model: ModelConfig;
  appPrompt: string;
  trigger: string;
  summary?: string;
  observation?: string;
  environmentObservation?: string;
  history: HistoryEntry[];
  countTokens?: TokenCounter;
}

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  estimatedInputTokens: number;
  includedHistoryIds: number[];
  omittedHistoryCount: number;
}

const MAX_RECENT_CHAT_ENTRIES = 8;
const MAX_RECENT_OPERATION_ENTRIES = 6;
const MAX_HISTORY_TOKENS = 12_000;
const section = (title: string, body: string) => `${title}\n${body.trim() || "(none)"}`;

export function buildModelContext(input: ContextInput): BuiltContext {
  const count = input.countTokens ?? conservativeTokenEstimate;
  const headroom = input.model.observationHeadroomTokens ?? 1_024;
  const budget = input.model.maxContextTokens - input.model.maxOutputTokens - headroom;
  const mandatory = [section("APP PROMPT", input.appPrompt), section("CURRENT TRIGGER", input.trigger)].join("\n\n");
  const baseCost = count(SYSTEM_PROMPT) + count(mandatory);
  if (baseCost > budget) throw new Error(`Mandatory context (${baseCost} tokens estimated) exceeds input budget (${budget}); choose a larger-context model or shorten the app prompt/trigger`);

  const messages: ModelMessage[] = [{ role: "user", content: mandatory }];
  let used = baseCost;
  if (input.observation) {
    const maxObservation = Math.max(128, Math.min(headroom * 3, budget - used));
    const bounded = truncateToTokens(input.observation, maxObservation, count);
    const content = section("LAST EXECUTION OBSERVATION", bounded);
    if (used + count(content) <= budget) { messages.push({ role: "user", content }); used += count(content); }
  }
  if (input.environmentObservation) {
    const content = section("NEW ENVIRONMENT OBSERVATION", truncateToTokens(input.environmentObservation, Math.max(128, headroom * 3), count));
    if (used + count(content) <= budget) { messages.push({ role: "user", content }); used += count(content); }
  }
  if (input.summary) {
    const content = section("ROLLING SUMMARY", input.summary);
    if (used + count(content) <= budget) { messages.push({ role: "user", content }); used += count(content); }
  }

  const candidates = recentHistory(input.history, input.trigger, input.observation);
  const historyBudget = Math.min(
    Math.max(0, budget - used),
    Math.min(MAX_HISTORY_TOKENS, Math.max(256, Math.floor(input.model.maxContextTokens * 0.2))),
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
    system: SYSTEM_PROMPT,
    messages,
    estimatedInputTokens: used,
    includedHistoryIds: selected.flatMap(x => x.id == null ? [] : [x.id]),
    omittedHistoryCount: input.history.length - selected.length,
  };
}

function recentHistory(history: HistoryEntry[], trigger: string, observation?: string): HistoryEntry[] {
  const excluded = new Set<number>();
  const newestMatching = (predicate: (entry: HistoryEntry) => boolean) => {
    for (let index = history.length - 1; index >= 0; index--) {
      if (!excluded.has(index) && predicate(history[index]!)) {
        excluded.add(index);
        return;
      }
    }
  };

  newestMatching(entry => entry.role === "user" && entry.kind === "chat" && entry.content === trigger);
  if (observation) newestMatching(entry => entry.role === "observation" && entry.content === observation);

  const remaining = history.filter((_entry, index) => !excluded.has(index));
  const chat = remaining
    .filter(entry => !isOperational(entry) && entry.kind !== "compaction")
    .slice(-MAX_RECENT_CHAT_ENTRIES);
  const operations = remaining.filter(isOperational).slice(-MAX_RECENT_OPERATION_ENTRIES);
  const compaction = remaining.filter(entry => entry.kind === "compaction").slice(-1);

  const unique = new Map<string | number, HistoryEntry>();
  for (const entry of [...chat, ...operations, ...compaction]) {
    unique.set(entry.id ?? `${entry.timestamp}:${entry.role}:${entry.content}`, entry);
  }
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function isOperational(entry: HistoryEntry): boolean {
  return entry.role === "agent" || entry.role === "observation"
    || entry.kind === "javascript" || entry.kind === "execution" || entry.kind === "error";
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
