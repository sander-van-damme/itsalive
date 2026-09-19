import {
  createBootstrapInit,
  createBridgeMessage,
  createRequestId,
  isAppToShellMessage,
  isBootstrapErrorMessage,
  isBootstrapReadyMessage,
} from "../../shared";
import type { AppToShellPayload, BridgeMessage, ShellToAppPayload } from "../../shared";
import { PostMessageExecutor } from "./bridge-executor";

export type RuntimeState = "loading" | "ready" | "error" | "disposed";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Owns the one live wildcard iframe, its one-shot bootstrap handshake, and authenticated MessagePort. */
export class RuntimeSession {
  frame: HTMLIFrameElement | undefined;
  executor: PostMessageExecutor | undefined;
  state: RuntimeState = "disposed";
  appId: string | undefined;
  origin: string | undefined;

  private port: MessagePort | undefined;
  private runtimeSource: string | undefined;
  private documentHtml: string | undefined;
  private bootstrapAccepted = false;
  private readonly pending = new Map<string, PendingRequest>();

  private readonly onWindowMessage = (event: MessageEvent<unknown>) => {
    const frameWindow = this.frame?.contentWindow;
    const appId = this.appId;
    const origin = this.origin;
    if (!frameWindow || !appId || !origin || event.origin !== origin || event.source !== frameWindow) return;

    if (isBootstrapErrorMessage(event.data) && event.data.appId === appId) {
      this.state = "error";
      const error = new Error(event.data.error.message);
      error.name = event.data.error.name;
      if (event.data.error.stack) error.stack = event.data.error.stack;
      this.onError(error);
      return;
    }

    if (!isBootstrapReadyMessage(event.data) || event.data.appId !== appId || this.bootstrapAccepted) return;
    const source = this.runtimeSource;
    if (!source) {
      this.state = "error";
      this.onError(new Error("Runtime source is unavailable"));
      return;
    }

    this.bootstrapAccepted = true;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.addEventListener("message", this.onPortMessage as EventListener);
    this.port.start();
    this.executor = new PostMessageExecutor(this.port, appId);
    frameWindow.postMessage(createBootstrapInit(appId, source, this.documentHtml), origin, [channel.port2]);
  };

  private readonly onPortMessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    const appId = this.appId;
    if (!appId || !isAppToShellMessage(message) || message.appId !== appId) return;

    if (message.type === "result" || message.type === "execution.error") {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        if (message.type === "execution.error") pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    }

    this.onMessage(message);
  };

  constructor(
    private readonly mount: (frame: HTMLIFrameElement) => void,
    private readonly onMessage: (message: BridgeMessage<AppToShellPayload>) => void = () => undefined,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {}

  switchTo(appId: string, origin: string, runtimeSource: string, documentHtml?: string): HTMLIFrameElement {
    this.dispose();
    if (!runtimeSource.trim()) throw new Error("Runtime source must not be empty");

    const frame = document.createElement("iframe");
    frame.allow = "camera; microphone; geolocation; clipboard-read; clipboard-write";
    frame.referrerPolicy = "strict-origin";
    frame.src = origin;

    this.frame = frame;
    this.appId = appId;
    this.origin = new URL(origin).origin;
    this.runtimeSource = runtimeSource;
    this.documentHtml = documentHtml;
    this.bootstrapAccepted = false;
    this.state = "loading";

    window.addEventListener("message", this.onWindowMessage);
    this.mount(frame);
    return frame;
  }

  setState(state: Exclude<RuntimeState, "disposed">): void {
    if (this.state !== "disposed") this.state = state;
  }

  requireReady(): PostMessageExecutor {
    if (!this.frame?.isConnected || !this.executor || this.state === "disposed") throw new Error("App runtime is unavailable");
    if (this.state !== "ready") throw new Error(this.state === "error" ? "App runtime is in an error state" : "App runtime is not ready yet");
    return this.executor;
  }

  post(payload: ShellToAppPayload, requestId = createRequestId()): void {
    const appId = this.appId;
    const port = this.port;
    if (!appId || !port || this.state === "disposed") throw new Error("App runtime channel is unavailable");
    port.postMessage(createBridgeMessage(appId, requestId, payload));
  }

  respond(message: BridgeMessage<AppToShellPayload>, payload: ShellToAppPayload): void {
    if (message.appId !== this.appId) throw new Error("Runtime response app id mismatch");
    this.post(payload, message.requestId);
  }

  request<T>(payload: ShellToAppPayload, timeoutMs = 10_000): Promise<T> {
    const appId = this.appId;
    const port = this.port;
    if (!appId || !port || this.state !== "ready") return Promise.reject(new Error("App is not connected"));

    const requestId = createRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Runtime request timed out"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
      port.postMessage(createBridgeMessage(appId, requestId, payload));
    });
  }

  dispose(): void {
    window.removeEventListener("message", this.onWindowMessage);
    this.executor?.dispose();
    if (this.port) {
      this.port.removeEventListener("message", this.onPortMessage as EventListener);
      this.port.close();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Runtime disposed"));
    }
    this.pending.clear();
    this.frame?.remove();
    this.executor = undefined;
    this.port = undefined;
    this.frame = undefined;
    this.appId = undefined;
    this.origin = undefined;
    this.runtimeSource = undefined;
    this.documentHtml = undefined;
    this.bootstrapAccepted = false;
    this.state = "disposed";
  }
}
