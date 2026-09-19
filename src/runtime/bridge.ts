import { createBridgeMessage, createRequestId, isShellToAppMessage } from "../shared";
import type { AppToShellPayload, BridgeMessage, ShellToAppPayload } from "../shared";

export class AppBridge {
  private pending = new Map<string, { resolve: (value: BridgeMessage<ShellToAppPayload>) => void; reject: (error: Error) => void; timer: number }>();

  constructor(readonly rootOrigin: string, readonly appId: string, private readonly port: MessagePort) {
    this.port.start();
  }

  validate(event: MessageEvent<unknown>): BridgeMessage<ShellToAppPayload> | null {
    const message = event.data;
    return isShellToAppMessage(message) && message.appId === this.appId ? message : null;
  }

  addMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.port.addEventListener("message", listener as EventListener);
  }

  removeMessageListener(listener: (event: MessageEvent<unknown>) => void): void {
    this.port.removeEventListener("message", listener as EventListener);
  }

  post(payload: AppToShellPayload, requestId = createRequestId()) {
    this.port.postMessage(createBridgeMessage(this.appId, requestId, payload));
  }

  request<T extends BridgeMessage<ShellToAppPayload>>(payload: AppToShellPayload, timeoutMs = 30_000): Promise<T> {
    const requestId = createRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Bridge request timed out: ${payload.type}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (value: BridgeMessage<ShellToAppPayload>) => void, reject, timer });
      this.post(payload, requestId);
    });
  }

  acceptResponse(message: BridgeMessage<ShellToAppPayload>): boolean {
    const pending = this.pending.get(message.requestId);
    if (!pending) return false;
    window.clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message);
    return true;
  }

  destroy(): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Bridge destroyed"));
    }
    this.pending.clear();
    this.port.close();
  }
}
