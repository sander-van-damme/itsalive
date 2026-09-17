import { ShellDatabase } from "./database";
import type { HistoryEntry } from "./types";

export interface HistoryMatch { timestamp: number; role: string; snippet: string; id?: number }

export async function searchHistory(db: ShellDatabase, appSlug: string, query: string, limit = 20): Promise<HistoryMatch[]> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const entries = await db.history.forApp(appSlug);
  return entries
    .filter(entry => entry.content.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(0, Math.min(limit, 100)))
    .map(entry => ({ timestamp: entry.timestamp, role: entry.role, snippet: matchingSnippet(entry.content, needle), id: entry.id }));
}

function matchingSnippet(content: string, lowerNeedle: string, width = 240): string {
  const at = content.toLocaleLowerCase().indexOf(lowerNeedle);
  const start = Math.max(0, at - Math.floor((width - lowerNeedle.length) / 2));
  const end = Math.min(content.length, start + width);
  return `${start ? "…" : ""}${content.slice(start, end).replace(/\s+/g, " ")}${end < content.length ? "…" : ""}`;
}

export async function appendHistory(db: ShellDatabase, entry: Omit<HistoryEntry, "timestamp"> & { timestamp?: number }): Promise<number> {
  return db.history.add({ ...entry, timestamp: entry.timestamp ?? Date.now() });
}
