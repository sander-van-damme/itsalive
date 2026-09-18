import { isValidAppId } from "./domain";
import { isValidId } from "./ids";
import type { SerializedError } from "./serialization";

export const BRIDGE_PROTOCOL = "itsalive" as const;
export const BRIDGE_VERSION = 2 as const;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type RuntimeStatus = "booting" | "ready" | "busy" | "saving" | "error";

export interface LogRecord { timestamp: number; level: LogLevel; source: string; message: string; details?: unknown; }
export interface CronRegistration { callbackId: string; schedule: string; description?: string; }

export type ShellToAppPayload =
  | { type: "execute"; code: string }
  | { type: "reload" }
  | { type: "llm.response"; result?: unknown; error?: SerializedError }
  | { type: "history.response"; results?: unknown[]; error?: SerializedError }
  | { type: "cron.fire"; callbackId: string };

export type AppToShellPayload =
  | { type: "result"; result?: unknown; done?: boolean; message?: string }
  | { type: "execution.error"; error: SerializedError }
  | { type: "wake"; reason?: string }
  | { type: "llm.request"; prompt: string; options?: Record<string, unknown> }
  | { type: "history.request"; query: string; limit?: number }
  | { type: "log"; record: LogRecord }
  | { type: "cron.register"; registration: CronRegistration }
  | { type: "status"; status: RuntimeStatus; detail?: string };

export type BridgePayload = ShellToAppPayload | AppToShellPayload;
export type BridgeMessage<P extends BridgePayload = BridgePayload> = P & {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  appId: string;
  requestId: string;
};

const SHELL_TYPES = new Set<ShellToAppPayload["type"]>(["execute", "reload", "llm.response", "history.response", "cron.fire"]);
const APP_TYPES = new Set<AppToShellPayload["type"]>(["result", "execution.error", "wake", "llm.request", "history.request", "log", "cron.register", "status"]);
const ALL_TYPES = new Set<string>([...SHELL_TYPES, ...APP_TYPES]);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Structural validation at the untrusted postMessage boundary. */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!isObject(value) || value.protocol !== BRIDGE_PROTOCOL || value.version !== BRIDGE_VERSION ||
      !isValidAppId(value.appId) || !isValidId(value.requestId) || typeof value.type !== "string" || !ALL_TYPES.has(value.type)) return false;
  switch (value.type) {
    case "execute": return typeof value.code === "string";
    case "llm.request": return typeof value.prompt === "string";
    case "history.request": return typeof value.query === "string";
    case "cron.fire": return typeof value.callbackId === "string" && value.callbackId.length > 0 && value.callbackId.length <= 200;
    case "execution.error": return isSerializedError(value.error);
    case "log": return isLogRecord(value.record);
    case "cron.register": return isObject(value.registration) && typeof value.registration.callbackId === "string" && typeof value.registration.schedule === "string";
    case "status": return ["booting", "ready", "busy", "saving", "error"].includes(String(value.status));
    default: return true;
  }
}

export const isShellToAppMessage = (value: unknown): value is BridgeMessage<ShellToAppPayload> =>
  isBridgeMessage(value) && SHELL_TYPES.has(value.type as ShellToAppPayload["type"]);
export const isAppToShellMessage = (value: unknown): value is BridgeMessage<AppToShellPayload> =>
  isBridgeMessage(value) && APP_TYPES.has(value.type as AppToShellPayload["type"]);

export function isSerializedError(value: unknown): value is SerializedError {
  return isObject(value) && typeof value.name === "string" && typeof value.message === "string" && (value.stack === undefined || typeof value.stack === "string");
}

export function isLogRecord(value: unknown): value is LogRecord {
  return isObject(value) && typeof value.timestamp === "number" && Number.isFinite(value.timestamp) &&
    ["debug", "info", "warn", "error"].includes(String(value.level)) && typeof value.source === "string" && typeof value.message === "string";
}

export function createBridgeMessage<P extends BridgePayload>(appId: string, requestId: string, payload: P): BridgeMessage<P> {
  if (!isValidAppId(appId)) throw new Error("Invalid app id");
  if (!isValidId(requestId)) throw new Error("Invalid request ID");
  return { protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, appId, requestId, ...payload } as BridgeMessage<P>;
}

export interface MessageValidationOptions {
  expectedOrigin: string;
  expectedAppId: string;
  expectedSource?: MessageEventSource | null;
  direction: "to-app" | "to-shell";
}

/** Validates origin, source window, id, envelope, direction and correlation ID together. */
export function validateMessageEvent(event: MessageEvent<unknown>, options: MessageValidationOptions): BridgeMessage | null {
  let expectedOrigin: string;
  try { expectedOrigin = new URL(options.expectedOrigin).origin; } catch { return null; }
  if (event.origin !== expectedOrigin || (options.expectedSource !== undefined && event.source !== options.expectedSource)) return null;
  if (!isBridgeMessage(event.data) || event.data.appId !== options.expectedAppId) return null;
  const validDirection = options.direction === "to-app"
    ? SHELL_TYPES.has(event.data.type as ShellToAppPayload["type"])
    : APP_TYPES.has(event.data.type as AppToShellPayload["type"]);
  return validDirection ? event.data : null;
}

export function isResponseTo(message: BridgeMessage, requestId: string): boolean {
  return isValidId(requestId) && message.requestId === requestId;
}
