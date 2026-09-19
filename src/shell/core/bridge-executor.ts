import type { AppExecutor, ExecutionResult } from "./agent-runner";
import { createBridgeMessage, createRequestId, isAppToShellMessage } from "../../shared";

interface Pending { resolve(value: ExecutionResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Request/response executor carried by the authenticated runtime MessagePort. */
export class PostMessageExecutor implements AppExecutor {
  private readonly pending = new Map<string, Pending>();
  private readonly onMessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isAppToShellMessage(message) || message.appId !== this.appId || (message.type !== "result" && message.type !== "execution.error")) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message.type === "execution.error" ? { error: message.error } : { value: message.result, done: message.done, message: message.message });
  };

  constructor(private readonly port: MessagePort, private readonly appId: string) {
    this.port.addEventListener("message", this.onMessage as EventListener);
    this.port.start();
  }

  execute(appId: string, code: string, { signal, timeoutMs }: { signal: AbortSignal; timeoutMs: number }): Promise<ExecutionResult> {
    if (appId !== this.appId) return Promise.reject(new Error("Executor app id mismatch"));
    const requestId = createRequestId();
    return new Promise((resolve, reject) => {
      const finishAbort = () => {
        const item = this.pending.get(requestId);
        if (item) {
          clearTimeout(item.timer);
          this.pending.delete(requestId);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        }
      };
      signal.addEventListener("abort", finishAbort, { once: true });
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", finishAbort);
        this.pending.delete(requestId);
        reject(new Error(`App execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: value => {
          signal.removeEventListener("abort", finishAbort);
          resolve(value);
        },
        reject,
        timer,
      });
      this.port.postMessage(createBridgeMessage(appId, requestId, { type: "execute", code }));
    });
  }

  dispose(): void {
    this.port.removeEventListener("message", this.onMessage as EventListener);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Executor disposed"));
    }
    this.pending.clear();
  }
}
