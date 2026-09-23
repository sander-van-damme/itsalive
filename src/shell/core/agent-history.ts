import type { ShellDatabase } from "./database";
import type { HistoryEntry } from "./types";

export interface AgentHistoryStore {
  list(appId: string): Promise<HistoryEntry[]>;
  append(entry: Omit<HistoryEntry, "timestamp"> & { timestamp?: number }): Promise<number>;
}

export function databaseAgentHistory(db: ShellDatabase): AgentHistoryStore {
  return {
    list: appId => db.history.forApp(appId),
    append: entry => db.history.add({ ...entry, timestamp: entry.timestamp ?? Date.now() }),
  };
}

/**
 * Per-worker technical history. Nothing written here leaks into another worker
 * or into the manager's durable shell history.
 */
export class IsolatedAgentHistory implements AgentHistoryStore {
  private readonly entries: HistoryEntry[] = [];
  private nextId = 1;

  constructor(seed: readonly HistoryEntry[] = []) {
    for (const entry of seed) {
      this.entries.push(structuredClone(entry));
      this.nextId = Math.max(this.nextId, (entry.id ?? 0) + 1);
    }
  }

  async list(appId: string): Promise<HistoryEntry[]> {
    return this.entries.filter(entry => entry.appId === appId).map(entry => structuredClone(entry));
  }

  async append(entry: Omit<HistoryEntry, "timestamp"> & { timestamp?: number }): Promise<number> {
    const id = this.nextId++;
    this.entries.push({
      ...structuredClone(entry),
      id,
      timestamp: entry.timestamp ?? Date.now(),
    });
    return id;
  }

  snapshot(): HistoryEntry[] {
    return this.entries.map(entry => structuredClone(entry));
  }
}
