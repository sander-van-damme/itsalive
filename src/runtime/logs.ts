import type { AppBridge } from "./bridge";
import type { LogEntry } from "./types";

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function serializable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...("cause" in value && value.cause !== undefined ? { cause: serializable(value.cause, seen) } : {}),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => serializable(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = serializable(item, seen);
  return result;
}

export function installLogging(bridge: AppBridge) {
  const groups: string[] = [];

  const originals = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    trace: console.trace,
    table: console.table,
    dir: console.dir,
    group: console.group,
    groupCollapsed: console.groupCollapsed,
    groupEnd: console.groupEnd,
  };

  const add = (level: LogEntry["level"], args: unknown[], source: LogEntry["source"] = "app", stack?: string) => {
    const entry = { timestamp: new Date().toISOString(), level, message: args.map(printable).join(" "), source, ...(stack ? { stack } : {}) } satisfies LogEntry;
    bridge.post({
      type: "log",
      record: {
        timestamp: Date.now(),
        level: level === "log" ? "debug" : level,
        source,
        message: entry.message,
        details: {
          args: args.map(item => serializable(item)),
          ...(groups.length ? { groups: [...groups] } : {}),
          ...(stack ? { stack } : {}),
        },
      },
    });
  };

  const wrappers = {
    debug: (...args: unknown[]) => { originals.debug.call(console, ...args); add("debug", args); },
    log: (...args: unknown[]) => { originals.log.call(console, ...args); add("log", args); },
    info: (...args: unknown[]) => { originals.info.call(console, ...args); add("info", args); },
    warn: (...args: unknown[]) => { originals.warn.call(console, ...args); add("warn", args); },
    error: (...args: unknown[]) => { originals.error.call(console, ...args); add("error", args); },
    trace: (...args: unknown[]) => {
      originals.trace.call(console, ...args);
      add("debug", args.length ? args : ["Trace"], "app", new Error("Trace").stack);
    },
    table: (...args: unknown[]) => { (originals.table as (...values: unknown[]) => void).call(console, ...args); add("debug", args); },
    dir: (...args: unknown[]) => { (originals.dir as (...values: unknown[]) => void).call(console, ...args); add("debug", args); },
    group: (...args: unknown[]) => {
      originals.group.call(console, ...args);
      const label = args.map(printable).join(" ");
      groups.push(label);
      add("debug", args);
    },
    groupCollapsed: (...args: unknown[]) => {
      originals.groupCollapsed.call(console, ...args);
      const label = args.map(printable).join(" ");
      groups.push(label);
      add("debug", args);
    },
    groupEnd: () => {
      groups.pop();
      originals.groupEnd.call(console);
    },
  };

  console.debug = wrappers.debug;
  console.log = wrappers.log;
  console.info = wrappers.info;
  console.warn = wrappers.warn;
  console.error = wrappers.error;
  console.trace = wrappers.trace;
  console.table = wrappers.table as typeof console.table;
  console.dir = wrappers.dir as typeof console.dir;
  console.group = wrappers.group;
  console.groupCollapsed = wrappers.groupCollapsed;
  console.groupEnd = wrappers.groupEnd;

  const onError = (event: ErrorEvent) => add("error", [event.message], "app", event.error?.stack);
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    add("error", ["Unhandled promise rejection", reason], "app", reason instanceof Error ? reason.stack : undefined);
  };
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onUnhandledRejection);

  const destroy = () => {
    if (console.debug === wrappers.debug) console.debug = originals.debug;
    if (console.log === wrappers.log) console.log = originals.log;
    if (console.info === wrappers.info) console.info = originals.info;
    if (console.warn === wrappers.warn) console.warn = originals.warn;
    if (console.error === wrappers.error) console.error = originals.error;
    if (console.trace === wrappers.trace) console.trace = originals.trace;
    if (console.table === wrappers.table) console.table = originals.table;
    if (console.dir === wrappers.dir) console.dir = originals.dir;
    if (console.group === wrappers.group) console.group = originals.group;
    if (console.groupCollapsed === wrappers.groupCollapsed) console.groupCollapsed = originals.groupCollapsed;
    if (console.groupEnd === wrappers.groupEnd) console.groupEnd = originals.groupEnd;
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onUnhandledRejection);
  };

  return { add, destroy };
}
