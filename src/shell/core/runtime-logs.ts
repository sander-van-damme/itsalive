import type { LogLevel, LogRecord } from "../../shared";
import type { ShellDatabase } from "./database";

const RUNTIME_LOG_SOURCES = new Set(["app", "agent", "cron", "bridge"]);
export const MAX_RUNTIME_LOG_QUERY = 200;

export interface RuntimeLogQuery {
  level?: LogLevel;
  limit?: number;
}

export async function queryRuntimeLogs(
  db: ShellDatabase,
  appId: string,
  query: RuntimeLogQuery = {},
): Promise<LogRecord[]> {
  const limit = Math.max(1, Math.min(query.limit ?? 100, MAX_RUNTIME_LOG_QUERY));
  const rows = await db.logs.forApp(appId);
  return rows
    .filter(row => RUNTIME_LOG_SOURCES.has(row.source))
    .filter(row => !query.level || row.level === query.level)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit)
    .map(row => ({
      timestamp: row.timestamp,
      level: row.level,
      source: row.source,
      message: row.message,
      ...(row.details !== undefined ? { details: row.details } : {}),
    }));
}
