import { SYSTEM_PROMPT } from "./system-prompt";
import type { HistoryEntry, ModelConfig, ModelMessage, ToolSummary } from "./types";

export type TokenCounter = (text: string) => number;
export const conservativeTokenEstimate: TokenCounter = (text) => Math.ceil(new TextEncoder().encode(text).length / 3);

export interface ContextInput {
  model: ModelConfig;
  appPrompt: string;
  trigger: string;
  tools: ToolSummary[];
  summary?: string;
  observation?: string;
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

const section = (title: string, body: string) => `${title}\n${body.trim() || "(none)"}`;

export function buildModelContext(input: ContextInput): BuiltContext {
  const count = input.countTokens ?? conservativeTokenEstimate;
  const headroom = input.model.observationHeadroomTokens ?? 1_024;
  const budget = input.model.maxContextTokens - input.model.maxOutputTokens - headroom;
  const inventory = input.tools.map(({ name, description }) => `${name} — ${description.replace(/\s+/g, " ").trim()}`).join("\n");
  const mandatory = [section("APP PROMPT", input.appPrompt), section("CUSTOM TOOLS", inventory), section("CURRENT TRIGGER", input.trigger)].join("\n\n");
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
  if (input.summary) {
    const content = section("ROLLING SUMMARY", input.summary);
    if (used + count(content) <= budget) { messages.push({ role: "user", content }); used += count(content); }
  }

  const selected: HistoryEntry[] = [];
  for (const entry of [...input.history].sort((a, b) => b.timestamp - a.timestamp)) {
    const cost = count(entry.content) + 8;
    if (used + cost > budget) continue;
    selected.push(entry); used += cost;
  }
  selected.reverse();
  messages.splice(0, 0, ...selected.map((entry): ModelMessage => ({
    role: entry.role === "assistant" || entry.role === "agent" ? "assistant" : "user",
    content: entry.content,
  })));
  return { system: SYSTEM_PROMPT, messages, estimatedInputTokens: used, includedHistoryIds: selected.flatMap(x => x.id == null ? [] : [x.id]), omittedHistoryCount: input.history.length - selected.length };
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
