import {
  appOriginFor,
  isRecord,
  PortRPC,
  PROTOCOL_VERSION,
  type EventHandler,
} from "../shared/bridge";
import type { Json, RuntimeMode } from "../shared/types";
import { runtimeSource } from "./runtime-source.generated";

export interface MountFrameOptions {
  appId: string;
  container: HTMLElement;
  mode: RuntimeMode;
  state?: Record<string, Json>;
  observe?: boolean;
  onRequest?: (
    method: string,
    payload: unknown,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
  onEvent?: EventHandler;
  timeoutMs?: number;
  visible?: boolean;
}

export class FrameSession {
  private constructor(
    readonly iframe: HTMLIFrameElement,
    private readonly rpc: PortRPC,
    private readonly lifetime: AbortController,
    private readonly appWork: { active: boolean; controller: AbortController },
  ) {
    const appearance = new MutationObserver(() => {
      void rpc
        .request(
          "set-appearance",
          document.documentElement.dataset.theme === "dark" ? "dark" : "light",
        )
        .catch(() => undefined);
    });
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    lifetime.signal.addEventListener("abort", () => appearance.disconnect(), {
      once: true,
    });
  }

  static mount(options: MountFrameOptions): Promise<FrameSession> {
    const lifetime = new AbortController();
    const appWork = { active: true, controller: new AbortController() };
    const origin = appOriginFor(options.appId, location.origin);
    const iframe = document.createElement("iframe");
    iframe.title =
      options.mode === "app" ? "Application" : `Application ${options.mode}`;
    iframe.dataset.mode = options.mode;
    iframe.dataset.appId = options.appId;
    if (options.mode === "app" && options.visible === false) {
      // Give the first render its real viewport before exposing it. display:none
      // would make canvas/layout initialization measure a zero-sized frame.
      iframe.style.position = "absolute";
      iframe.style.inset = "0";
      iframe.style.visibility = "hidden";
      iframe.inert = true;
      iframe.setAttribute("aria-hidden", "true");
      iframe.dataset.mode = "parked";
    }
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
        lifetime.abort();
        appWork.controller.abort();
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
        rpc = new PortRPC(
          channel.port1,
          (method, payload) => {
            lifetime.signal.throwIfAborted();
            if (!appWork.active)
              throw new DOMException("Application is not active", "AbortError");
            appWork.controller.signal.throwIfAborted();
            if (!options.onRequest) throw new Error("Capability unavailable");
            return options.onRequest(
              method,
              payload,
              appWork.controller.signal,
            );
          },
          (name, payload) => {
            if (name === "ready" && !finished) {
              finished = true;
              cleanup();
              resolve(new FrameSession(iframe, rpc!, lifetime, appWork));
            }
            if (name === "fatal" && !finished) fail(new Error(String(payload)));
            options.onEvent?.(name, payload);
          },
        );
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
              appearance:
                document.documentElement.dataset.theme === "dark"
                  ? "dark"
                  : "light",
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
  setVisible(visible: boolean): void {
    if (!visible) {
      this.appWork.active = false;
      this.appWork.controller.abort();
    } else if (!this.appWork.active) {
      this.appWork.active = true;
      this.appWork.controller = new AbortController();
    }
    this.iframe.style.removeProperty("position");
    this.iframe.style.removeProperty("inset");
    this.iframe.style.removeProperty("visibility");
    this.iframe.hidden = !visible;
    this.iframe.style.display = visible ? "" : "none";
    this.iframe.inert = !visible;
    if (visible) this.iframe.removeAttribute("aria-hidden");
    else this.iframe.setAttribute("aria-hidden", "true");
    this.iframe.dataset.mode = visible ? "app" : "parked";
    void this.request("set-visibility", visible).catch(() => {});
  }
  close(): void {
    this.lifetime.abort();
    this.appWork.controller.abort();
    this.rpc.close();
    this.iframe.remove();
  }
}
