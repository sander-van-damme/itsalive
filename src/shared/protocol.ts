import { isValidAppId } from "./domain";
import { isValidId } from "./ids";
import type { SerializedError } from "./serialization";

export const BOOTSTRAP_PROTOCOL = "itsalive-bootstrap" as const;
export const BOOTSTRAP_VERSION = 1 as const;
export const RUNTIME_BOOTSTRAP_KEY = "__itsaliveShellRuntimeInitV1" as const;
export const BRIDGE_PROTOCOL = "itsalive" as const;
export const BRIDGE_VERSION = 4 as const;
/** Shared character limit for the semantic HTML projection carried by Jev requests. */
export const MAX_SEMANTIC_DOCUMENT_CHARACTERS = 100_000;
export const MAX_SAVED_DOCUMENT_CHARACTERS = 5_000_000;

export type BootstrapReadyMessage = {
  protocol: typeof BOOTSTRAP_PROTOCOL;
  version: typeof BOOTSTRAP_VERSION;
  type: "ready";
  appId: string;
};

export type BootstrapInitMessage = {
  protocol: typeof BOOTSTRAP_PROTOCOL;
  version: typeof BOOTSTRAP_VERSION;
  type: "init";
  appId: string;
  runtimeSource: string;
  documentHtml?: string;
};

export type BootstrapErrorMessage = {
  protocol: typeof BOOTSTRAP_PROTOCOL;
  version: typeof BOOTSTRAP_VERSION;
  type: "error";
  appId: string;
  error: SerializedError;
};

export type BootstrapMessage = BootstrapReadyMessage | BootstrapInitMessage | BootstrapErrorMessage;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type RuntimeStatus = "ready";

export interface LogRecord { timestamp: number; level: LogLevel; source: string; message: string; details?: unknown; }
export interface CronRegistration { callbackId: string; schedule: string; }
export interface InteractionTarget { tag: string; id?: string; value?: string; state?: Record<string, string | boolean>; }
export interface InteractionSnapshot { seq: number; at: string; type: string; target: InteractionTarget; actualTarget: InteractionTarget; key?: string; }
export interface InteractionPatternSample {
  kind: "repeated-action";
  actionCount: number;
  coalescedCount: number;
  durationMs: number;
  averageIntervalMs: number;
  documentChangeCount: number;
}
export interface InteractionPattern extends InteractionPatternSample {
  likelyBenign: boolean;
  frustrationSignal: boolean;
}
export interface InteractionObservation { interaction: InteractionSnapshot; pattern?: InteractionPatternSample; document: string; }
export interface JevState { interaction: InteractionSnapshot; recentInteractions: InteractionSnapshot[]; pattern?: InteractionPattern; historySummary?: string; document: string; }

export type ShellToAppPayload =
  | { type: "execute"; code: string }
  | { type: "document.snapshot" }
  | { type: "llm.response"; result?: unknown; error?: SerializedError }
  | { type: "history.response"; results?: unknown[]; error?: SerializedError }
  | { type: "jev.response"; probability: number; escalated: boolean; error?: SerializedError }
  | { type: "cron.fire"; callbackId: string };

export type AppToShellPayload =
  | { type: "result"; result?: unknown; done?: boolean; message?: string }
  | { type: "document.save"; html: string }
  | { type: "execution.error"; error: SerializedError }
  | { type: "wake"; reason?: string }
  | { type: "llm.request"; prompt: string }
  | { type: "history.request"; query: string; limit?: number }
  | { type: "jev.request"; state: InteractionObservation }
  | { type: "log"; record: LogRecord }
  | { type: "cron.register"; registration: CronRegistration }
  | { type: "status"; status: RuntimeStatus };

export type BridgePayload = ShellToAppPayload | AppToShellPayload;
export type BridgeMessage<P extends BridgePayload = BridgePayload> = P & {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  appId: string;
  requestId: string;
};

const SHELL_TYPES = new Set<ShellToAppPayload["type"]>(["execute", "document.snapshot", "llm.response", "history.response", "jev.response", "cron.fire"]);
const APP_TYPES = new Set<AppToShellPayload["type"]>(["result", "execution.error", "document.save", "wake", "llm.request", "history.request", "jev.request", "log", "cron.register", "status"]);
const ALL_TYPES = new Set<string>([...SHELL_TYPES, ...APP_TYPES]);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));

export function createBootstrapReady(appId: string): BootstrapReadyMessage {
  if (!isValidAppId(appId)) throw new Error("Invalid app id");
  return { protocol: BOOTSTRAP_PROTOCOL, version: BOOTSTRAP_VERSION, type: "ready", appId };
}

export function createBootstrapInit(appId: string, runtimeSource: string, documentHtml?: string): BootstrapInitMessage {
  if (!isValidAppId(appId)) throw new Error("Invalid app id");
  if (!runtimeSource.trim()) throw new Error("Runtime source must not be empty");
  if (documentHtml !== undefined && documentHtml.length > MAX_SAVED_DOCUMENT_CHARACTERS) throw new Error("Saved document is too large");
  return {
    protocol: BOOTSTRAP_PROTOCOL,
    version: BOOTSTRAP_VERSION,
    type: "init",
    appId,
    runtimeSource,
    ...(documentHtml !== undefined ? { documentHtml } : {}),
  };
}

export function createBootstrapError(appId: string, error: SerializedError): BootstrapErrorMessage {
  if (!isValidAppId(appId)) throw new Error("Invalid app id");
  return { protocol: BOOTSTRAP_PROTOCOL, version: BOOTSTRAP_VERSION, type: "error", appId, error };
}

export function isBootstrapReadyMessage(value: unknown): value is BootstrapReadyMessage {
  return isObject(value)
    && hasOnly(value, ["protocol", "version", "type", "appId"])
    && value.protocol === BOOTSTRAP_PROTOCOL
    && value.version === BOOTSTRAP_VERSION
    && value.type === "ready"
    && isValidAppId(value.appId);
}

export function isBootstrapInitMessage(value: unknown): value is BootstrapInitMessage {
  return isObject(value)
    && hasOnly(value, ["protocol", "version", "type", "appId", "runtimeSource", "documentHtml"])
    && value.protocol === BOOTSTRAP_PROTOCOL
    && value.version === BOOTSTRAP_VERSION
    && value.type === "init"
    && isValidAppId(value.appId)
    && typeof value.runtimeSource === "string"
    && value.runtimeSource.length > 0
    && (value.documentHtml === undefined || typeof value.documentHtml === "string" && value.documentHtml.length <= MAX_SAVED_DOCUMENT_CHARACTERS);
}

export function isBootstrapErrorMessage(value: unknown): value is BootstrapErrorMessage {
  return isObject(value)
    && hasOnly(value, ["protocol", "version", "type", "appId", "error"])
    && value.protocol === BOOTSTRAP_PROTOCOL
    && value.version === BOOTSTRAP_VERSION
    && value.type === "error"
    && isValidAppId(value.appId)
    && isSerializedError(value.error);
}

/** Structural validation for the runtime channel after the bootstrap trust boundary is established. */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!isObject(value) || value.protocol !== BRIDGE_PROTOCOL || value.version !== BRIDGE_VERSION ||
      !isValidAppId(value.appId) || !isValidId(value.requestId) || typeof value.type !== "string" || !ALL_TYPES.has(value.type)) return false;
  switch (value.type) {
    case "execute": return typeof value.code === "string";
    case "document.save": return typeof value.html === "string" && value.html.length <= MAX_SAVED_DOCUMENT_CHARACTERS;
    case "llm.request": return typeof value.prompt === "string" && value.options === undefined;
    case "history.request": return typeof value.query === "string";
    case "jev.request": return isInteractionObservation(value.state);
    case "jev.response": return typeof value.probability === "number" && value.probability >= 0 && value.probability <= 1 && typeof value.escalated === "boolean" && (value.error === undefined || isSerializedError(value.error));
    case "cron.fire": return typeof value.callbackId === "string" && value.callbackId.length > 0 && value.callbackId.length <= 200;
    case "execution.error": return isSerializedError(value.error);
    case "log": return isLogRecord(value.record);
    case "cron.register": return isObject(value.registration) && typeof value.registration.callbackId === "string" && typeof value.registration.schedule === "string" && value.registration.description === undefined;
    case "status": return value.status === "ready";
    default: return true;
  }
}

function isInteractionTarget(value: unknown): boolean {
  if (!isObject(value) || !hasOnly(value, ["tag", "id", "value", "state"]) || typeof value.tag !== "string" || value.tag.length < 1 || value.tag.length > 100 || (value.id !== undefined && (typeof value.id !== "string" || value.id.length > 200)) || (value.value !== undefined && (typeof value.value !== "string" || value.value.length > 500))) return false;
  if (value.state === undefined) return true;
  return isObject(value.state) && Object.keys(value.state).length <= 20 && Object.entries(value.state).every(([key, entry]) => key.length <= 100 && (typeof entry === "boolean" || typeof entry === "string" && entry.length <= 200));
}
function isInteraction(value: unknown): boolean {
  return isObject(value) && hasOnly(value, ["seq", "at", "type", "target", "actualTarget", "key"]) && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0 && typeof value.at === "string" && value.at.length <= 40 && typeof value.type === "string" && value.type.length > 0 && value.type.length <= 30 && (value.key === undefined || typeof value.key === "string" && value.key.length <= 30) && isInteractionTarget(value.target) && isInteractionTarget(value.actualTarget);
}
function isInteractionPatternSample(value: unknown): boolean {
  if (!isObject(value) || !hasOnly(value, ["kind", "actionCount", "coalescedCount", "durationMs", "averageIntervalMs", "documentChangeCount"]) || value.kind !== "repeated-action") return false;
  return Number.isSafeInteger(value.actionCount) && Number(value.actionCount) >= 2 && Number(value.actionCount) <= 1_000
    && Number.isSafeInteger(value.coalescedCount) && Number(value.coalescedCount) >= 0 && Number(value.coalescedCount) <= Number(value.actionCount) - 2
    && typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 60_000
    && typeof value.averageIntervalMs === "number" && Number.isFinite(value.averageIntervalMs) && value.averageIntervalMs >= 0 && value.averageIntervalMs <= 60_000
    && Number.isSafeInteger(value.documentChangeCount) && Number(value.documentChangeCount) >= 0 && Number(value.documentChangeCount) < Number(value.actionCount);
}
function isInteractionObservation(value: unknown): boolean {
  return isObject(value)
    && hasOnly(value, ["interaction", "pattern", "document"])
    && isInteraction(value.interaction)
    && (value.pattern === undefined || isInteractionPatternSample(value.pattern))
    && typeof value.document === "string"
    && value.document.length <= MAX_SEMANTIC_DOCUMENT_CHARACTERS;
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
