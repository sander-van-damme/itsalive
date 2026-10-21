import {
  appOriginFor,
  isRecord,
  PortRPC,
  PROTOCOL_VERSION,
  type EventHandler,
  type RequestHandler,
} from "../shared/bridge";
import type { Json, RuntimeMode } from "../shared/types";
import { runtimeSource } from "./runtime-source.generated";

export interface MountFrameOptions {
  appId: string;
  container: HTMLElement;
  mode: RuntimeMode;
  state?: Record<string, Json>;
  observe?: boolean;
  onRequest?: RequestHandler;
  onEvent?: EventHandler;
  timeoutMs?: number;
}

export class FrameSession {
  private constructor(
    readonly iframe: HTMLIFrameElement,
    private readonly rpc: PortRPC,
  ) {}

  static mount(options: MountFrameOptions): Promise<FrameSession> {
    const origin = appOriginFor(options.appId, location.origin);
    const iframe = document.createElement("iframe");
    iframe.title =
      options.mode === "app" ? "Application" : `Application ${options.mode}`;
    iframe.dataset.mode = options.mode;
    iframe.dataset.appId = options.appId;
    iframe.sandbox.add("allow-scripts", "allow-same-origin");
    if (options.mode === "app") {
      iframe.sandbox.add(
        "allow-forms",
        "allow-downloads",
        "allow-modals",
        "allow-popups",
      );
      iframe.allow = "microphone; camera; autoplay; clipboard-write";
    }
    iframe.referrerPolicy = "no-referrer";
    return new Promise((resolve, reject) => {
      let rpc: PortRPC | undefined;
      let finished = false;
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", ready);
      };
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        rpc?.close();
        iframe.remove();
        reject(error);
      };
      const timer = setTimeout(
        () =>
          fail(new Error(`Application ${options.mode} bootstrap timed out`)),
        options.timeoutMs ?? 20_000,
      );
      const ready = (event: MessageEvent<unknown>) => {
        if (
          event.origin !== origin ||
          event.source !== iframe.contentWindow ||
          !isRecord(event.data) ||
          event.data.kind !== "itsalive:ready" ||
          event.data.version !== PROTOCOL_VERSION ||
          event.data.appId !== options.appId ||
          rpc
        )
          return;
        const channel = new MessageChannel();
        rpc = new PortRPC(channel.port1, options.onRequest, (name, payload) => {
          if (name === "ready" && !finished) {
            finished = true;
            cleanup();
            resolve(new FrameSession(iframe, rpc!));
          }
          if (name === "fatal" && !finished) fail(new Error(String(payload)));
          options.onEvent?.(name, payload);
        });
        iframe.contentWindow!.postMessage(
          {
            kind: "itsalive:bootstrap",
            version: PROTOCOL_VERSION,
            appId: options.appId,
            runtime: runtimeSource,
            init: {
              appId: options.appId,
              mode: options.mode,
              state: options.state ?? {},
              observe: options.observe ?? false,
            },
          },
          origin,
          [channel.port2],
        );
      };
      window.addEventListener("message", ready);
      iframe.src = `${origin}/?mode=${options.mode}&session=${crypto.randomUUID()}`;
      options.container.append(iframe);
    });
  }

  request<T = unknown>(
    method: string,
    payload: unknown = null,
    timeoutMs?: number,
  ): Promise<T> {
    return this.rpc.request<T>(method, payload, timeoutMs);
  }
  close(): void {
    this.rpc.close();
    this.iframe.remove();
  }
}
