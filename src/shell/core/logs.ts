import { ShellDatabase } from "./database";
import type { LogEntry } from "./types";

export class ShellLogger {
  constructor(private readonly db: ShellDatabase, private readonly maxEntries = 2_000) {}
  async write(entry: Omit<LogEntry, "timestamp"> & { timestamp?: number }): Promise<void> {
    await this.db.logs.add({ ...entry, timestamp: entry.timestamp ?? Date.now() });
  }
  async query(options: { appSlug?: string; level?: LogEntry["level"]; limit?: number } = {}): Promise<LogEntry[]> {
    let rows = options.appSlug ? await this.db.logs.forApp(options.appSlug) : await this.db.logs.all();
    if (options.level) rows = rows.filter(x => x.level === options.level);
    return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, options.limit ?? 100);
  }
  async export(appSlug?: string): Promise<string> {
    const rows = await this.query({ appSlug, limit: this.maxEntries });
    return rows.slice().reverse().map(row => `${new Date(row.timestamp).toISOString()} [${row.level}] [${row.source}] ${row.message}${row.details == null ? "" : ` ${safeJson(row.details)}`}`).join("\n");
  }
}

const safeJson = (value: unknown) => { try { return JSON.stringify(value); } catch { return "[unserializable]"; } };
