import { AppBridge, slugFromHostname } from "./bridge";
import { appDatabaseApi } from "./db";
import { inspectDom, ref } from "./inspect";
import { installLogging } from "./logs";
import { installAutosave, loadSavedDocument } from "./persistence";
import { captureScreenshot } from "./screenshot";
import { createToolsApi } from "./tools";
import type { RuntimeOptions } from "./types";
import type { ItsaliveRuntimeApi } from "./globals";
import type { BridgeMessage, ShellToAppPayload } from "../shared";
import { serializeError } from "../shared";

const DONE = Symbol("agent-done");

function errorPayload(error: unknown, logs: unknown[]) {
  const value = error instanceof Error ? error : new Error(String(error));
  return { message: value.message, stack: value.stack, logs };
}

function bounded(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return null;
  let json: string;
  try { json = JSON.stringify(value); } catch { return { truncated: true, value: String(value), reason: "Result was not serializable" }; }
  if (new Blob([json]).size <= maxBytes) return value;
  return { truncated: true, size: new Blob([json]).size, preview: json.slice(0, Math.max(0, maxBytes - 200)) };
}

export async function startAppRuntime(options: RuntimeOptions) {
  const rootOrigin = new URL(options.rootOrigin).origin;
  const appSlug = options.appSlug ?? slugFromHostname(rootOrigin);
  const bridge = new AppBridge(rootOrigin, appSlug);
  const logs = installLogging(bridge);
  const cronCallbacks = new Map<string, () => unknown>();
  const tools = createToolsApi(logs.add);
  const screenshot = options.screenshot
    ? async (input: { ref?: string } = {}) => {
        const target = input.ref ? ref(input.ref) : document.documentElement;
        if (!(target instanceof HTMLElement)) throw new Error(`Unknown or non-HTML ref: ${input.ref}`);
        return options.screenshot!(target);
      }
    : captureScreenshot;

  const done = (message?: string) => ({ [DONE]: true, message });
  const cron = (id: string, schedule: string, callback: () => unknown) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid cron callback ID");
    if (typeof callback !== "function" || !schedule.trim()) throw new Error("cron requires a schedule and callback");
    cronCallbacks.set(id, callback);
    bridge.post({ type: "cron.register", registration: { callbackId: id, schedule } });
    return { id, schedule };
  };
  const llm = Object.freeze({ ask: async <T = unknown>(prompt: unknown, settings?: unknown) => {
      const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "llm.request", prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt), options: settings && typeof settings === "object" ? settings as Record<string, unknown> : undefined }, 120_000);
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
    apiVersion: 1,
    db: Object.freeze(appDatabaseApi),
    llm,
    history,
    tools: Object.freeze(tools),
    agent,
    dom: Object.freeze({ inspect: inspectDom, ref, screenshot }),
    logs: Object.freeze({ get: logs.get }),
    cron,
    reload: () => location.reload(),
    done,
  });
  installRuntimeApi(window, runtimeApi);

  const run = async (code: string) => {
    // AsyncFunction provides top-level await and return. Platform capabilities live
    // on the single browser-global itsalive namespace, also used by restored scripts.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction(`"use strict";\n${code}`).call(window);
  };

  const listener = async (event: MessageEvent) => {
    const message = bridge.validate(event);
    if (!message) return;
    if (bridge.acceptResponse(message)) return;
    if (message.type === "execute") {
      try {
        const result = await run(message.code);
        if (result && result[DONE]) bridge.post({ type: "result", done: true, message: result.message }, message.requestId);
        else bridge.post({ type: "result", result: bounded(result, options.maxResultBytes ?? 256_000) }, message.requestId);
      } catch (error) {
        logs.add("error", ["Agent execution failed", error], "agent", error instanceof Error ? error.stack : undefined);
        const details = errorPayload(error, logs.get({ level: "error", limit: 30 }));
        bridge.post({ type: "execution.error", error: { ...serializeError(error), cause: JSON.stringify(details.logs) } }, message.requestId);
      }
    } else if (message.type === "ready.request") {
      bridge.post({ type: "ready", metadata: { title: document.title } }, message.requestId);
    } else if (message.type === "metadata.request") {
      bridge.post({ type: "metadata", metadata: { title: document.title } }, message.requestId);
    } else if (message.type === "reload") {
      bridge.post({ type: "result", result: { reloading: true } }, message.requestId);
      location.reload();
    } else if (message.type === "cron.fire") {
      const id = message.callbackId;
      const callback = id && cronCallbacks.get(id);
      if (!callback) return bridge.post({ type: "execution.error", error: serializeError(new Error(`Unknown cron callback: ${id}`)) }, message.requestId);
      try { bridge.post({ type: "result", result: bounded(await callback(), options.maxResultBytes ?? 256_000) }, message.requestId); }
      catch (error) {
        logs.add("error", [`Cron ${id} failed`, error], "cron", error instanceof Error ? error.stack : undefined);
        bridge.post({ type: "execution.error", error: serializeError(error) }, message.requestId);
      }
    } else if (message.type === "screenshot.request") {
      try {
        const dataUrl = await screenshot();
        const image = new Image(); image.src = dataUrl; await image.decode();
        bridge.post({ type: "screenshot", dataUrl, width: image.naturalWidth, height: image.naturalHeight }, message.requestId);
      } catch (error) { bridge.post({ type: "execution.error", error: serializeError(error) }, message.requestId); }
    }
  };
  addEventListener("message", listener);

  await loadSavedDocument();
  const autosave = installAutosave(options.autosaveDelay);
  bridge.post({ type: "status", status: "ready", detail: appSlug });
  return { bridge, appSlug, autosave, destroy: () => { removeEventListener("message", listener); autosave.disconnect(); } };
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
  const slug = slugFromHostname(rootOrigin);
  location.replace(`${new URL(rootOrigin).origin}/?app=${encodeURIComponent(slug)}`);
  return true;
}
