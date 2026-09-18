import { createBridgeMessage, createRequestId, validateMessageEvent } from "../shared";
import type { AppToShellPayload, BridgeMessage, ShellToAppPayload } from "../shared";

export class AppBridge {
  private pending = new Map<string, { resolve: (value: BridgeMessage<ShellToAppPayload>) => void; reject: (error: Error) => void; timer: number }>();

  constructor(readonly rootOrigin: string, readonly appId: string) {}

  validate(event: MessageEvent): BridgeMessage<ShellToAppPayload> | null {
    return validateMessageEvent(event, {
      expectedOrigin: this.rootOrigin,
      expectedAppId: this.appId,
      expectedSource: window.parent,
      direction: "to-app",
    }) as BridgeMessage<ShellToAppPayload> | null;
  }

  post(payload: AppToShellPayload, requestId = createRequestId()) {
    if (window.parent === window) return;
    window.parent.postMessage(createBridgeMessage(this.appId, requestId, payload), this.rootOrigin);
  }

  request<T extends BridgeMessage<ShellToAppPayload>>(payload: AppToShellPayload, timeoutMs = 30_000): Promise<T> {
    if (window.parent === window) return Promise.reject(new Error(`${payload.type} requires the root shell`));
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
  }
}

export function idFromHostname(rootOrigin: string): string {
  const root = new URL(rootOrigin).hostname;
  const host = location.hostname;
  const suffix = `.${root}`;
  if (!host.endsWith(suffix) || host === root) throw new Error(`App hostname ${host} is not a subdomain of ${root}`);
  const id = host.slice(0, -suffix.length).split(".")[0];
  if (!id) throw new Error("Unable to determine app id");
  return id;
}
