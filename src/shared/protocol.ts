import { isValidAppId } from "./domain";
import { isValidId } from "./ids";
import type { SerializedError } from "./serialization";

export const BRIDGE_PROTOCOL = "itsalive" as const;
export const BRIDGE_VERSION = 4 as const;
/** Shared character limit for the semantic HTML projection carried by Jev requests. */
export const MAX_SEMANTIC_DOCUMENT_CHARACTERS = 100_000;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type RuntimeStatus = "ready";

export interface LogRecord { timestamp: number; level: LogLevel; source: string; message: string; details?: unknown; }
export interface CronRegistration { callbackId: string; schedule: string; }
export interface InteractionTarget { tag: string; id?: string; value?: string; state?: Record<string, string | boolean>; }
export interface InteractionSnapshot { seq: number; at: string; type: string; target: InteractionTarget; actualTarget: InteractionTarget; key?: string; }
export interface InteractionPattern {
  kind: "repeated-action";
  actionCount: number;
  coalescedCount: number;
  durationMs: number;
  averageIntervalMs: number;
  documentChangeCount: number;
  likelyBenign: boolean;
  frustrationSignal: boolean;
}
export interface JevState { interaction: InteractionSnapshot; recentInteractions: InteractionSnapshot[]; pattern?: InteractionPattern; historySummary?: string; document: string; }

export type ShellToAppPayload =
  | { type: "execute"; code: string }
  | { type: "reload" }
  | { type: "storage.clear" }
  | { type: "llm.response"; result?: unknown; error?: SerializedError }
  | { type: "history.response"; results?: unknown[]; error?: SerializedError }
  | { type: "jev.response"; probability: number; escalated: boolean; error?: SerializedError }
  | { type: "cron.fire"; callbackId: string };

export type AppToShellPayload =
  | { type: "result"; result?: unknown; done?: boolean; message?: string }
  | { type: "execution.error"; error: SerializedError }
  | { type: "wake"; reason?: string }
  | { type: "llm.request"; prompt: string }
  | { type: "history.request"; query: string; limit?: number }
  | { type: "jev.request"; state: JevState }
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

const SHELL_TYPES = new Set<ShellToAppPayload["type"]>(["execute", "reload", "storage.clear", "llm.response", "history.response", "jev.response", "cron.fire"]);
const APP_TYPES = new Set<AppToShellPayload["type"]>(["result", "execution.error", "wake", "llm.request", "history.request", "jev.request", "log", "cron.register", "status"]);
const ALL_TYPES = new Set<string>([...SHELL_TYPES, ...APP_TYPES]);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Structural validation at the untrusted postMessage boundary. */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!isObject(value) || value.protocol !== BRIDGE_PROTOCOL || value.version !== BRIDGE_VERSION ||
      !isValidAppId(value.appId) || !isValidId(value.requestId) || typeof value.type !== "string" || !ALL_TYPES.has(value.type)) return false;
  switch (value.type) {
    case "execute": return typeof value.code === "string";
    case "llm.request": return typeof value.prompt === "string" && value.options === undefined;
    case "history.request": return typeof value.query === "string";
    case "jev.request": return isJevState(value.state);
    case "jev.response": return typeof value.probability === "number" && value.probability >= 0 && value.probability <= 1 && typeof value.escalated === "boolean" && (value.error === undefined || isSerializedError(value.error));
    case "cron.fire": return typeof value.callbackId === "string" && value.callbackId.length > 0 && value.callbackId.length <= 200;
    case "execution.error": return isSerializedError(value.error);
    case "log": return isLogRecord(value.record);
    case "cron.register": return isObject(value.registration) && typeof value.registration.callbackId === "string" && typeof value.registration.schedule === "string" && value.registration.description === undefined;
    case "status": return value.status === "ready";
    default: return true;
  }
}

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
function isInteractionTarget(value: unknown): boolean {
  if (!isObject(value) || !hasOnly(value, ["tag", "id", "value", "state"]) || typeof value.tag !== "string" || value.tag.length < 1 || value.tag.length > 100 || (value.id !== undefined && (typeof value.id !== "string" || value.id.length > 200)) || (value.value !== undefined && (typeof value.value !== "string" || value.value.length > 500))) return false;
  if (value.state === undefined) return true;
  return isObject(value.state) && Object.keys(value.state).length <= 20 && Object.entries(value.state).every(([key, entry]) => key.length <= 100 && (typeof entry === "boolean" || typeof entry === "string" && entry.length <= 200));
}
function isInteraction(value: unknown): boolean {
  return isObject(value) && hasOnly(value, ["seq", "at", "type", "target", "actualTarget", "key"]) && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0 && typeof value.at === "string" && value.at.length <= 40 && typeof value.type === "string" && value.type.length > 0 && value.type.length <= 30 && (value.key === undefined || typeof value.key === "string" && value.key.length <= 30) && isInteractionTarget(value.target) && isInteractionTarget(value.actualTarget);
}
function isInteractionPattern(value: unknown): boolean {
  if (!isObject(value) || !hasOnly(value, ["kind", "actionCount", "coalescedCount", "durationMs", "averageIntervalMs", "documentChangeCount", "likelyBenign", "frustrationSignal"]) || value.kind !== "repeated-action") return false;
  return Number.isSafeInteger(value.actionCount) && Number(value.actionCount) >= 2 && Number(value.actionCount) <= 1_000
    && Number.isSafeInteger(value.coalescedCount) && Number(value.coalescedCount) >= 0 && Number(value.coalescedCount) <= Number(value.actionCount) - 2
    && typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 60_000
    && typeof value.averageIntervalMs === "number" && Number.isFinite(value.averageIntervalMs) && value.averageIntervalMs >= 0 && value.averageIntervalMs <= 60_000
    && Number.isSafeInteger(value.documentChangeCount) && Number(value.documentChangeCount) >= 0 && Number(value.documentChangeCount) < Number(value.actionCount)
    && typeof value.likelyBenign === "boolean" && typeof value.frustrationSignal === "boolean";
}
function isJevState(value: unknown): boolean { return isObject(value) && hasOnly(value, ["interaction", "recentInteractions", "pattern", "historySummary", "document"]) && isInteraction(value.interaction) && Array.isArray(value.recentInteractions) && value.recentInteractions.length <= 20 && value.recentInteractions.every(isInteraction) && (value.pattern === undefined || isInteractionPattern(value.pattern)) && (value.historySummary === undefined || typeof value.historySummary === "string" && value.historySummary.length <= 8_000) && typeof value.document === "string" && value.document.length <= MAX_SEMANTIC_DOCUMENT_CHARACTERS; }

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
