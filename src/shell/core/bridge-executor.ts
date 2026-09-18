import type { AppExecutor, ExecutionResult } from "./agent-runner";
import { createBridgeMessage, createRequestId, validateMessageEvent } from "../../shared";

interface Pending { resolve(value: ExecutionResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Validated request/response bridge for the one active cross-origin app iframe. */
export class PostMessageExecutor implements AppExecutor {
  private readonly pending = new Map<string, Pending>();
  private readonly onMessage = (event: MessageEvent) => {
    const message = validateMessageEvent(event, { expectedOrigin: this.appOrigin, expectedAppSlug: this.appSlug, expectedSource: this.frame.contentWindow, direction: "to-shell" });
    if (!message || (message.type !== "result" && message.type !== "execution.error")) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.requestId);
    pending.resolve(message.type === "execution.error" ? { error: message.error } : { value: message.result, done: message.done, message: message.message });
  };

  constructor(private readonly frame: HTMLIFrameElement, private readonly appSlug: string, private readonly appOrigin: string) {
    window.addEventListener("message", this.onMessage);
  }

  execute(appSlug: string, code: string, { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number }): Promise<ExecutionResult> {
    if (appSlug !== this.appSlug) return Promise.reject(new Error("Executor app slug mismatch"));
    if (!this.frame.contentWindow) return Promise.reject(new Error("App iframe is not available"));
    const requestId = createRequestId();
    return new Promise((resolve, reject) => {
      const finishAbort = () => { const item = this.pending.get(requestId); if (item) { clearTimeout(item.timer); this.pending.delete(requestId); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); } };
      signal.addEventListener("abort", finishAbort, { once: true });
      const timer = setTimeout(() => { signal.removeEventListener("abort", finishAbort); this.pending.delete(requestId); reject(new Error(`App execution timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(requestId, { resolve: value => { signal.removeEventListener("abort", finishAbort); resolve(value); }, reject, timer });
      this.frame.contentWindow!.postMessage(createBridgeMessage(appSlug, requestId, { type: "execute", code }), this.appOrigin);
    });
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Executor disposed")); }
    this.pending.clear();
  }
}
