import type { RuntimeInit } from "./types";

export const PROTOCOL_VERSION = 2;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ROOT_ORIGIN = "https://itsalive.org";
export const LOCAL_ROOT_ORIGIN = "http://itsalive.localhost:4173";

export function appOriginFor(appId: string, rootOrigin: string): string {
  if (!UUID_PATTERN.test(appId)) throw new Error("Invalid application UUID");
  if (rootOrigin === ROOT_ORIGIN) return `https://${appId}.itsalive.org`;
  if (rootOrigin === LOCAL_ROOT_ORIGIN)
    return `http://${appId}.itsalive.localhost:4174`;
  throw new Error("Unrecognized shell origin");
}

export function bootstrapIdentity(
  location: Pick<Location, "origin" | "hostname">,
): { appId: string; rootOrigin: string } | null {
  const [appId, ...domain] = location.hostname.split(".");
  if (!appId || !UUID_PATTERN.test(appId)) return null;
  const rootOrigin =
    domain.join(".") === "itsalive.org"
      ? ROOT_ORIGIN
      : domain.join(".") === "itsalive.localhost"
        ? LOCAL_ROOT_ORIGIN
        : null;
  if (!rootOrigin || location.origin !== appOriginFor(appId, rootOrigin))
    return null;
  return { appId, rootOrigin };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isRuntimeInit(
  value: unknown,
  appId: string,
): value is RuntimeInit {
  return (
    isRecord(value) &&
    value.appId === appId &&
    ["app", "verify", "backup"].includes(String(value.mode)) &&
    typeof value.observe === "boolean" &&
    isRecord(value.state)
  );
}

export interface BootstrapEnvelope {
  kind: "itsalive:bootstrap";
  version: typeof PROTOCOL_VERSION;
  appId: string;
  runtime: string;
  init: RuntimeInit;
}

export function validBootstrap(
  value: unknown,
  appId: string,
): value is BootstrapEnvelope {
  return (
    isRecord(value) &&
    value.kind === "itsalive:bootstrap" &&
    value.version === PROTOCOL_VERSION &&
    value.appId === appId &&
    typeof value.runtime === "string" &&
    value.runtime.length > 0 &&
    value.runtime.length < 8_000_000 &&
    isRuntimeInit(value.init, appId)
  );
}

export type RequestHandler = (
  method: string,
  payload: unknown,
) => Promise<unknown> | unknown;
export type EventHandler = (event: string, payload: unknown) => void;

type WireMessage =
  | { v: 2; kind: "request"; id: string; method: string; payload: unknown }
  | { v: 2; kind: "response"; id: string; payload?: unknown; error?: string }
  | { v: 2; kind: "event"; event: string; payload: unknown };

export function isWireMessage(value: unknown): value is WireMessage {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return false;
  if (value.kind === "event")
    return typeof value.event === "string" && value.event.length <= 100;
  if (typeof value.id !== "string" || value.id.length > 100) return false;
  if (value.kind === "request")
    return typeof value.method === "string" && value.method.length <= 100;
  return (
    value.kind === "response" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export class PortRPC {
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly active = new Set<string>();
  private readonly post: (message: WireMessage) => void;
  private readonly closePort: () => void;
  private closed = false;

  constructor(
    private readonly port: MessagePort,
    private readonly onRequest: RequestHandler = () => {
      throw new Error("Capability unavailable");
    },
    private readonly onEvent: EventHandler = () => {},
  ) {
    // Capture these before generated code can modify same-realm prototypes.
    // The MessagePort itself never becomes an application-facing capability.
    this.post = port.postMessage.bind(port);
    this.closePort = port.close.bind(port);
    port.onmessage = (event) => {
      void this.receive(event.data);
    };
    port.onmessageerror = () =>
      this.close("Bridge message could not be decoded");
    port.start();
  }

  request<T = unknown>(
    method: string,
    payload: unknown = null,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Bridge is closed"));
    if (this.pending.size >= 100)
      return Promise.reject(new Error("Too many outstanding bridge requests"));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.post({
          v: PROTOCOL_VERSION,
          kind: "request",
          id,
          method,
          payload,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  event(event: string, payload: unknown): void {
    if (!this.closed)
      this.post({ v: PROTOCOL_VERSION, kind: "event", event, payload });
  }

  close(reason = "Bridge closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.closePort();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private async receive(message: unknown): Promise<void> {
    if (this.closed || !isWireMessage(message)) return;
    if (message.kind === "response") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.payload);
      return;
    }
    if (message.kind === "event") {
      this.onEvent(message.event, message.payload);
      return;
    }
    if (this.active.has(message.id) || this.active.size >= 100) return;
    this.active.add(message.id);
    try {
      const payload = await this.onRequest(message.method, message.payload);
      if (!this.closed)
        this.post({
          v: PROTOCOL_VERSION,
          kind: "response",
          id: message.id,
          payload,
        });
    } catch (error) {
      if (!this.closed)
        this.post({
          v: PROTOCOL_VERSION,
          kind: "response",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      this.active.delete(message.id);
    }
  }
}
