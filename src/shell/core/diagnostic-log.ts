import type { ShellDatabase } from "./database";
import { sanitizeDiagnostic } from "./diagnostics";
import type { HistoryEntry, LogEntry } from "./types";

type ConsoleLevel = LogEntry["level"];
type ConsoleWriter = (...args: unknown[]) => void;

interface GroupContext {
  label: string;
  appId?: string;
}

function normalizeDiagnostic(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return sanitizeDiagnostic({
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...("cause" in value && value.cause !== undefined ? { cause: normalizeDiagnostic(value.cause, seen) } : {}),
    });
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return sanitizeDiagnostic(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => normalizeDiagnostic(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = normalizeDiagnostic(item, seen);
  return sanitizeDiagnostic(result);
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function parsePrefix(value: string): { source: string; message: string } | undefined {
  const match = value.match(/^\[itsalive:([^\]]+)\]\s*(.*)$/s);
  return match ? { source: match[1]!, message: match[2]! } : undefined;
}

function appIdFromLabel(label: string): string | undefined {
  return label.match(/^\[itsalive:agent\]\s+Run\s+·\s+([0-9a-f-]{36})$/i)?.[1];
}

function appIdFromSource(source: string): string | undefined {
  return source.match(/^agent:([0-9a-f-]{36})$/i)?.[1];
}

function oneLine(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

export function buildDiagnosticExport(logs: LogEntry[], history: HistoryEntry[], appId?: string): string {
  const selectedLogs = appId ? logs.filter(item => !item.appId || item.appId === appId) : logs;
  const chat = history
    .filter(item => (!appId || item.appId === appId) && item.kind === "chat" && (item.role === "user" || item.role === "assistant"))
    .map(item => ({
      timestamp: item.timestamp,
      level: "info" as const,
      source: `chat:${item.role}`,
      message: item.content,
      appId: item.appId,
    }));

  return [...selectedLogs, ...chat]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(item => `${new Date(item.timestamp).toISOString()} [${item.level.toUpperCase()}] [${item.source}] ${oneLine(item.message)}${"details" in item && item.details !== undefined ? ` ${safeStringify(item.details)}` : ""}`)
    .join("\n");
}

export class DiagnosticLog {
  private readonly pending = new Set<Promise<void>>();
  private readonly groups: GroupContext[] = [];
  private installed = false;

  private readonly originals = {
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

  private readonly native = {
    debug: console.debug.bind(console) as ConsoleWriter,
    log: console.log.bind(console) as ConsoleWriter,
    info: console.info.bind(console) as ConsoleWriter,
    warn: console.warn.bind(console) as ConsoleWriter,
    error: console.error.bind(console) as ConsoleWriter,
    trace: console.trace.bind(console) as ConsoleWriter,
    table: console.table.bind(console) as ConsoleWriter,
    dir: console.dir.bind(console) as ConsoleWriter,
    group: console.group.bind(console) as ConsoleWriter,
    groupCollapsed: console.groupCollapsed.bind(console) as ConsoleWriter,
    groupEnd: console.groupEnd.bind(console) as () => void,
  };

  constructor(
    private readonly db: ShellDatabase,
    private readonly currentAppId: () => string | undefined = () => undefined,
  ) {}

  installConsoleCapture(): () => void {
    if (this.installed) return () => this.uninstallConsoleCapture();
    this.installed = true;

    console.debug = (...args: unknown[]) => { this.native.debug(...args); this.capture("debug", args, "console.debug"); };
    console.log = (...args: unknown[]) => { this.native.log(...args); this.capture("debug", args, "console.log"); };
    console.info = (...args: unknown[]) => { this.native.info(...args); this.capture("info", args, "console.info"); };
    console.warn = (...args: unknown[]) => { this.native.warn(...args); this.capture("warn", args, "console.warn"); };
    console.error = (...args: unknown[]) => { this.native.error(...args); this.capture("error", args, "console.error"); };
    console.trace = (...args: unknown[]) => {
      this.native.trace(...args);
      this.capture("debug", args.length ? args : ["Trace"], "console.trace", new Error("Trace").stack);
    };
    console.table = ((...args: unknown[]) => { this.native.table(...args); this.capture("debug", args, "console.table"); }) as typeof console.table;
    console.dir = ((...args: unknown[]) => { this.native.dir(...args); this.capture("debug", args, "console.dir"); }) as typeof console.dir;
    console.group = (...args: unknown[]) => { this.native.group(...args); this.openGroup(args, "console.group"); };
    console.groupCollapsed = (...args: unknown[]) => { this.native.groupCollapsed(...args); this.openGroup(args, "console.groupCollapsed"); };
    console.groupEnd = () => { this.groups.pop(); this.native.groupEnd(); };

    return () => this.uninstallConsoleCapture();
  }

  uninstallConsoleCapture(): void {
    if (!this.installed) return;
    console.debug = this.originals.debug;
    console.log = this.originals.log;
    console.info = this.originals.info;
    console.warn = this.originals.warn;
    console.error = this.originals.error;
    console.trace = this.originals.trace;
    console.table = this.originals.table;
    console.dir = this.originals.dir;
    console.group = this.originals.group;
    console.groupCollapsed = this.originals.groupCollapsed;
    console.groupEnd = this.originals.groupEnd;
    this.groups.length = 0;
    this.installed = false;
  }

  async write(level: ConsoleLevel, source: string, message: string, details?: unknown, appId?: string): Promise<void> {
    const safeMessage = String(normalizeDiagnostic(message));
    const safeDetails = details === undefined ? undefined : normalizeDiagnostic(details);
    const method = level === "debug" ? "debug" : level;
    this.native[method](`[itsalive:${source}] ${safeMessage}`, ...(safeDetails === undefined ? [] : [safeDetails]));
    await this.db.logs.add({ timestamp: Date.now(), level, source, message: safeMessage, details: safeDetails, appId: appId ?? this.currentAppId() });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private openGroup(args: unknown[], kind: string): void {
    const safeArgs = args.map(item => normalizeDiagnostic(item));
    const label = safeArgs.map(printable).join(" ");
    const inheritedAppId = this.groups.at(-1)?.appId;
    this.groups.push({ label, appId: appIdFromLabel(label) ?? inheritedAppId });
    this.captureNormalized("debug", safeArgs, kind);
  }

  private capture(level: ConsoleLevel, args: unknown[], kind: string, stack?: string): void {
    this.captureNormalized(level, args.map(item => normalizeDiagnostic(item)), kind, stack);
  }

  private captureNormalized(level: ConsoleLevel, safeArgs: unknown[], kind: string, stack?: string): void {
    const first = safeArgs[0];
    const direct = typeof first === "string" ? parsePrefix(first) : undefined;
    const groupPrefix = [...this.groups].reverse().map(group => parsePrefix(group.label)).find(Boolean);
    const source = direct?.source ?? groupPrefix?.source ?? "console";
    const message = direct?.message ?? (typeof first === "string" ? first : safeArgs.map(printable).join(" "));
    const detailArgs = typeof first === "string" ? safeArgs.slice(1) : safeArgs;
    const details = {
      kind,
      ...(detailArgs.length ? { args: detailArgs } : {}),
      ...(this.groups.length ? { groups: this.groups.map(group => group.label) } : {}),
      ...(stack ? { stack } : {}),
    };
    const groupAppId = [...this.groups].reverse().find(group => group.appId)?.appId;
    const appId = appIdFromSource(source) ?? groupAppId ?? this.currentAppId();
    this.persist({ timestamp: Date.now(), level, source, message, details, appId });
  }

  private persist(entry: LogEntry): void {
    let pending: Promise<void>;
    pending = this.db.logs.add(entry)
      .then(() => undefined)
      .catch(error => { this.native.error("[itsalive:logging] Failed to persist console entry", error); })
      .finally(() => { this.pending.delete(pending); });
    this.pending.add(pending);
  }
}
