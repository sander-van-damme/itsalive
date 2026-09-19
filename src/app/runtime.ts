import { AppBridge, idFromHostname } from "./bridge";
import { installLogging } from "./logs";
import { installAutosave, loadSavedDocument } from "./persistence";
import { captureScreenshot, formatScreenshotUnavailable } from "./screenshot";
import { clearOriginStorage } from "./storage";
import type { RuntimeOptions } from "./types";
import type { ItsaliveRuntimeApi } from "./globals";
import type { BridgeMessage, ShellToAppPayload } from "../shared";
import { serializeError, shellUrlForApp } from "../shared";
import { installInteractionObserver } from "./interactions";
import { ensureCanonicalAppRoot, enforceCanonicalAppRootAfterAgentCommand } from "./app-root";
import { COMPONENTS } from "./components";

const DONE = Symbol("agent-done");

function stringifyExecutionValue(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, current: unknown) => {
    if (current instanceof Document) return `<!doctype html>\n${current.documentElement.outerHTML}`;
    if (current instanceof Element) return current.outerHTML;
    if (current instanceof NodeList || current instanceof HTMLCollection) return Array.from(current);
    if (current instanceof Node) return current.textContent ?? current.nodeName;
    if (current && typeof current === "object") {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  });
  return serialized ?? "null";
}

function bounded(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return null;
  let json: string;
  try { json = stringifyExecutionValue(value); }
  catch { return { truncated: true, value: String(value), reason: "Result was not serializable" }; }
  if (new Blob([json]).size <= maxBytes) {
    try { return JSON.parse(json) as unknown; }
    catch { return value; }
  }
  return { truncated: true, size: new Blob([json]).size, preview: json.slice(0, Math.max(0, maxBytes - 200)) };
}

export async function startAppRuntime(options: RuntimeOptions) {
  const rootOrigin = new URL(options.rootOrigin).origin;
  const appId = options.appId ?? idFromHostname(rootOrigin);
  const bridge = new AppBridge(rootOrigin, appId);
  const logs = installLogging(bridge);
  const cronCallbacks = new Map<string, () => unknown>();
  const screenshot = async (input: { scale?: number } = {}) => {
    try {
      return options.screenshot ? await options.screenshot(document.documentElement) : await captureScreenshot(input);
    } catch (error) {
      const unavailable = formatScreenshotUnavailable(error);
      logs.add("warn", ["Screenshot verification unavailable", unavailable], "agent", error instanceof Error ? error.stack : undefined);
      return unavailable;
    }
  };

  const done = (message?: string) => ({ [DONE]: true, message });
  const cron = (id: string, schedule: string, callback: () => unknown) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid cron callback ID");
    if (typeof callback !== "function" || !schedule.trim()) throw new Error("cron requires a schedule and callback");
    cronCallbacks.set(id, callback);
    bridge.post({ type: "cron.register", registration: { callbackId: id, schedule } });
    return { id, schedule };
  };
  const llm = Object.freeze({ ask: async <T = unknown>(prompt: unknown) => {
      const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "llm.request", prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt) }, 120_000);
      if (response.type !== "llm.response") throw new Error(`Unexpected LLM response: ${response.type}`);
      if (response.error) throw new Error(response.error.message);
      return response.result as T;
    } });
  const agent = Object.freeze({ wake: async (prompt: string) => { bridge.post({ type: "wake", reason: prompt }); } });
  const history = Object.freeze({ search: async (query: { query: string; limit?: number }) => {
    const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "history.request", query: query.query, limit: query.limit });
    if (response.type !== "history.response") throw new Error(`Unexpected history response: ${response.type}`);
    if (response.error) throw new Error(response.error.message);
    return response.results ?? [];
  } });

  const runtimeApi: ItsaliveRuntimeApi = Object.freeze({
    apiVersion: 2,
    llm,
    history,
    agent,
    dom: Object.freeze({ screenshot }),
    logs: Object.freeze({ get: logs.get }),
    components: COMPONENTS,
    cron,
    done,
  });
  installRuntimeApi(window, runtimeApi);

  const run = async (code: string) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction(`"use strict";\n${code}`).call(window);
  };

  const listener = async (event: MessageEvent) => {
    const message = bridge.validate(event);
    if (!message) return;
    if (bridge.acceptResponse(message)) return;
    if (message.type === "execute") {
      try {
        ensureCanonicalAppRoot();
        let result: unknown;
        try {
          result = await run(message.code);
        } catch (error) {
          try {
            enforceCanonicalAppRootAfterAgentCommand();
          } catch (rootError) {
            logs.add("warn", ["Canonical app root repaired after a failed agent command", rootError], "agent", rootError instanceof Error ? rootError.stack : undefined);
          }
          throw error;
        }
        enforceCanonicalAppRootAfterAgentCommand();
        if (result && typeof result === "object" && DONE in result) bridge.post({ type: "result", done: true, message: (result as { message?: string }).message }, message.requestId);
        else bridge.post({ type: "result", result: bounded(result, options.maxResultBytes ?? 256_000) }, message.requestId);
      } catch (error) {
        logs.add("error", ["Agent execution failed", error], "agent", error instanceof Error ? error.stack : undefined);
        bridge.post({ type: "execution.error", error: serializeError(error) }, message.requestId);
      }
    } else if (message.type === "reload") {
      bridge.post({ type: "result", result: { reloading: true } }, message.requestId);
      location.reload();
    } else if (message.type === "storage.clear") {
      autosave.suspend();
      autosave.disconnect();
      try {
        await clearOriginStorage();
        bridge.post({ type: "result", result: { cleared: true } }, message.requestId);
      } catch (error) {
        bridge.post({ type: "execution.error", error: serializeError(error) }, message.requestId);
      }
    } else if (message.type === "cron.fire") {
      const id = message.callbackId;
      const callback = id && cronCallbacks.get(id);
      if (!callback) return bridge.post({ type: "execution.error", error: serializeError(new Error(`Unknown cron callback: ${id}`)) }, message.requestId);
      try { bridge.post({ type: "result", result: bounded(await callback(), options.maxResultBytes ?? 256_000) }, message.requestId); }
      catch (error) {
        logs.add("error", [`Cron ${id} failed`, error], "cron", error instanceof Error ? error.stack : undefined);
        bridge.post({ type: "execution.error", error: serializeError(error) }, message.requestId);
      }
    }
  };
  addEventListener("message", listener);

  await loadSavedDocument();
  ensureCanonicalAppRoot();
  const autosave = installAutosave(options.autosaveDelay);
  const interactions = installInteractionObserver(bridge);
  bridge.post({ type: "status", status: "ready" });
  return { bridge, appId, autosave, destroy: () => { removeEventListener("message", listener); interactions.destroy(); bridge.destroy(); autosave.disconnect(); logs.destroy(); } };
}

export function installRuntimeApi(target: Window, runtimeApi: ItsaliveRuntimeApi): void {
  if (Object.prototype.hasOwnProperty.call(target, "itsalive")) {
    throw new Error("Cannot install itsalive runtime API because window.itsalive already exists.");
  }
  Object.defineProperty(target, "itsalive", {
    value: runtimeApi,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

export function redirectStandaloneToShell(rootOrigin: string) {
  if (window.parent !== window) return false;
  const id = idFromHostname(rootOrigin);
  location.replace(shellUrlForApp(`${new URL(rootOrigin).origin}/`, id).href);
  return true;
}
