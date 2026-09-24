const DURABILITY_AUDIT_KEY = "__itsaliveRuntimeDurabilityAuditV1";

interface RuntimeListenerRegistration {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  signal?: AbortSignal;
}

export interface DurabilityAuditResult {
  runtimeOnlyEventListenerCount: number;
}

function captureOption(options?: boolean | AddEventListenerOptions): boolean {
  return typeof options === "boolean" ? options : Boolean(options?.capture);
}

function signalOption(options?: boolean | AddEventListenerOptions): AbortSignal | undefined {
  return typeof options === "object" && options ? options.signal ?? undefined : undefined;
}

function isRelevantTarget(target: EventTarget, root: HTMLElement | null): boolean {
  if (target === window || target === document) return true;
  if (!root || !(target instanceof Node)) return false;
  return target === root || root.contains(target);
}

/**
 * Tracks event listeners installed directly by transient agent commands.
 *
 * Listeners created while a persisted <script> is executing are intentionally
 * excluded because that setup code will run again when the saved document is
 * restored. Persisted setup-script listeners are normally installed outside the direct agent
 * execution stack and therefore remain outside this audit as well.
 */
export function installAgentDurabilityAudit() {
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const registrations = new Set<RuntimeListenerRegistration>();
  let agentExecutionDepth = 0;

  const patchedAdd = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (agentExecutionDepth > 0 && listener && !document.currentScript) {
      registrations.add({
        target: this,
        type,
        listener,
        capture: captureOption(options),
        signal: signalOption(options),
      });
    }
    return originalAdd.call(this, type, listener, options);
  } as typeof EventTarget.prototype.addEventListener;

  const patchedRemove = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (listener) {
      const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
      for (const registration of registrations) {
        if (
          registration.target === this
          && registration.type === type
          && registration.listener === listener
          && registration.capture === capture
        ) registrations.delete(registration);
      }
    }
    return originalRemove.call(this, type, listener, options);
  } as typeof EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = patchedAdd;
  EventTarget.prototype.removeEventListener = patchedRemove;

  const audit = (): DurabilityAuditResult => {
    const root = document.getElementById("itsalive-root");
    let runtimeOnlyEventListenerCount = 0;
    for (const registration of registrations) {
      if (registration.signal?.aborted) continue;
      if (isRelevantTarget(registration.target, root)) runtimeOnlyEventListenerCount++;
    }
    return { runtimeOnlyEventListenerCount };
  };

  Object.defineProperty(window, DURABILITY_AUDIT_KEY, {
    value: audit,
    configurable: true,
    enumerable: false,
    writable: false,
  });

  return {
    async runAgentCommand<T>(work: () => Promise<T>): Promise<T> {
      agentExecutionDepth++;
      try {
        return await work();
      } finally {
        agentExecutionDepth--;
      }
    },
    audit,
    destroy() {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
      registrations.clear();
      delete (window as unknown as Record<string, unknown>)[DURABILITY_AUDIT_KEY];
    },
  };
}

export { DURABILITY_AUDIT_KEY };
