import { SYSTEM_PROMPT } from "./system-prompt";
import type { HistoryEntry, ModelMessage } from "./types";

export interface ContextInput {
  appPrompt: string;
  trigger: string;
  observation?: string;
  environmentObservation?: string;
  history: HistoryEntry[];
}

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  includedHistoryIds: number[];
}

const section = (title: string, body: string) => `${title}\n${body.trim() || "(none)"}`;

export function buildModelContext(input: ContextInput): BuiltContext {
  const selected = contextHistory(input.history, input.trigger, input.observation);
  const messages: ModelMessage[] = selected.map((entry): ModelMessage => ({
    role: entry.role === "assistant" || entry.role === "agent" ? "assistant" : "user",
    content: entry.content,
  }));

  messages.push({
    role: "user",
    content: [section("APP PROMPT", input.appPrompt), section("CURRENT TRIGGER", input.trigger)].join("\n\n"),
  });

  if (input.observation) {
    messages.push({ role: "user", content: section("LAST EXECUTION OBSERVATION", input.observation) });
  }
  if (input.environmentObservation) {
    messages.push({ role: "user", content: section("NEW ENVIRONMENT OBSERVATION", input.environmentObservation) });
  }

  return {
    system: SYSTEM_PROMPT,
    messages,
    includedHistoryIds: selected.flatMap(entry => entry.id == null ? [] : [entry.id]),
  };
}

function contextHistory(history: HistoryEntry[], trigger: string, observation?: string): HistoryEntry[] {
  const excluded = new Set<number>();
  const excludeNewest = (predicate: (entry: HistoryEntry) => boolean) => {
    for (let index = history.length - 1; index >= 0; index--) {
      if (!excluded.has(index) && predicate(history[index]!)) {
        excluded.add(index);
        return;
      }
    }
  };

  excludeNewest(entry => entry.role === "user" && entry.kind === "chat" && entry.content === trigger);
  if (observation) excludeNewest(entry => entry.role === "observation" && entry.content === observation);

  return history.filter((_entry, index) => !excluded.has(index));
}
