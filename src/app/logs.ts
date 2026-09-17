import type { AppBridge } from "./bridge";
import type { LogEntry } from "./types";

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function installLogging(bridge: AppBridge, capacity = 500) {
  const entries: LogEntry[] = [];
  const add = (level: LogEntry["level"], args: unknown[], source: LogEntry["source"] = "app", stack?: string) => {
    const entry = { timestamp: new Date().toISOString(), level, message: args.map(printable).join(" "), source, ...(stack ? { stack } : {}) } satisfies LogEntry;
    entries.push(entry);
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    bridge.post({ type: "log", record: { timestamp: Date.now(), level: level === "log" ? "debug" : level, source, message: entry.message, details: stack ? { stack } : undefined } });
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => { original(...args); add(level, args); };
  }
  addEventListener("error", event => add("error", [event.message], "app", event.error?.stack));
  addEventListener("unhandledrejection", event => {
    const reason = event.reason;
    add("error", ["Unhandled promise rejection", reason], "app", reason instanceof Error ? reason.stack : undefined);
  });
  return {
    add,
    get: ({ level, limit = 100 }: { level?: LogEntry["level"]; limit?: number } = {}) =>
      entries.filter(entry => !level || entry.level === level).slice(-Math.max(0, Math.min(limit, capacity))),
  };
}
