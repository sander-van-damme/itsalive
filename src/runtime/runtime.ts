import { AppBridge } from "./bridge";
import { installLogging } from "./logs";
import { installAutosave, restoreAppDocument, serializeAppDocument } from "./persistence";
import { captureScreenshot, formatScreenshotUnavailable } from "./screenshot";
import type { RuntimeOptions } from "./types";
import type { AgentRuntimeApi, ApplicationAiApi, ApplicationRuntimeApi } from "./globals";
import { createApplicationStore, type JsonValue } from "./application-store";
import type { ApplicationAiDecisionRequest, ApplicationAiDecisionResult, BridgeMessage, ExecutionConsoleEntry, ShellToAppPayload } from "../shared";
import { MAX_SAVED_DOCUMENT_CHARACTERS, appDocumentCharacterSize, isApplicationAiDecisionRequest, serializeError } from "../shared";
import { installInteractionObserver } from "./interactions";
import { ensureCanonicalAppRoot, enforceCanonicalAppRootAfterAgentCommand } from "./app-root";
import { installAgentDurabilityAudit } from "./durability";
import { createAgentTransactionController, type AgentTransactionController } from "./agent-transactions";

const DONE = Symbol("agent-done");

interface DoneSignal {
  [DONE]: true;
  message?: string;
}

function doneSignal(message?: string): DoneSignal {
  if (message !== undefined && typeof message !== "string") {
    throw new TypeError("agent.done(message) accepts only a string. Serialize structured completion data with JSON.stringify(...).");
  }
  return { [DONE]: true, ...(message === undefined ? {} : { message }) };
}

function isDoneSignal(value: unknown): value is DoneSignal {
  return Boolean(value && typeof value === "object" && DONE in value);
}

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

const MAX_EXECUTION_CONSOLE_ENTRIES = 100;
const MAX_EXECUTION_CONSOLE_ARG_BYTES = 8_000;

function executionConsoleArg(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  return bounded(value, MAX_EXECUTION_CONSOLE_ARG_BYTES);
}

function installExecutionConsoleCapture(entries: ExecutionConsoleEntry[]): () => void {
  const originals = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const wrap = (level: ExecutionConsoleEntry["level"], original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      if (entries.length < MAX_EXECUTION_CONSOLE_ENTRIES) {
        entries.push({ level, args: args.slice(0, 20).map(executionConsoleArg) });
      }
      original.call(console, ...args);
    };
  const wrappers = {
    debug: wrap("debug", originals.debug),
    log: wrap("log", originals.log),
    info: wrap("info", originals.info),
    warn: wrap("warn", originals.warn),
    error: wrap("error", originals.error),
  };

  console.debug = wrappers.debug;
  console.log = wrappers.log;
  console.info = wrappers.info;
  console.warn = wrappers.warn;
  console.error = wrappers.error;

  return () => {
    if (console.debug === wrappers.debug) console.debug = originals.debug;
    if (console.log === wrappers.log) console.log = originals.log;
    if (console.info === wrappers.info) console.info = originals.info;
    if (console.warn === wrappers.warn) console.warn = originals.warn;
    if (console.error === wrappers.error) console.error = originals.error;
  };
}

export async function startAppRuntime(options: RuntimeOptions) {
  const rootOrigin = new URL(options.rootOrigin).origin;
  const appId = options.appId;
  const bridge = new AppBridge(rootOrigin, appId, options.port);
  const logs = installLogging(bridge);
  const applicationStore = createApplicationStore();
  const screenshot = async (input: { scale?: number } = {}) => {
    try {
      return options.screenshot ? await options.screenshot(document.documentElement) : await captureScreenshot(input);
    } catch (error) {
      const unavailable = formatScreenshotUnavailable(error);
      logs.add("warn", ["Screenshot verification unavailable", unavailable], "agent", error instanceof Error ? error.stack : undefined);
      return unavailable;
    }
  };

  const done = (message?: string): DoneSignal => doneSignal(message);
  const text = async (prompt: string): Promise<string> => {
    if (typeof prompt !== "string") throw new TypeError("application.ai.text prompt must be a string");
    const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({
      type: "llm.request",
      prompt,
    }, 120_000);
    if (response.type !== "llm.response") throw new Error(`Unexpected LLM response: ${response.type}`);
    if (response.error) throw new Error(response.error.message);
    if (typeof response.result !== "string") throw new Error("application.ai.text returned a non-text result");
    return response.result;
  };
  const contextJson = (context: JsonValue): string => {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(context); }
    catch { throw new TypeError("application.ai context must be JSON-serializable"); }
    if (serialized === undefined) throw new TypeError("application.ai context must be JSON-serializable");
    return serialized;
  };
  const requestDecision = async (decision: ApplicationAiDecisionRequest): Promise<ApplicationAiDecisionResult> => {
    if (!isApplicationAiDecisionRequest(decision)) throw new TypeError("Invalid application.ai decision request");
    const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({
      type: "ai.decision.request",
      decision,
    }, 30_000);
    if (response.type !== "ai.decision.response") throw new Error(`Unexpected application.ai decision response: ${response.type}`);
    if (response.error) throw new Error(response.error.message);
    if (!("result" in response)) throw new Error("application.ai decision returned no result");
    return response.result ?? null;
  };
  const ai: Readonly<ApplicationAiApi> = Object.freeze({
    text,
    choose: async <T extends string>(question: string, options: Record<T, string>, context?: JsonValue): Promise<T | null> => {
      const result = await requestDecision({ kind: "choose", question, options, ...(context === undefined ? {} : { contextJson: contextJson(context) }) });
      if (result !== null && typeof result !== "string") throw new Error("application.ai.choose returned an invalid result");
      return result as T | null;
    },
    score: async (question: string, levels: string[], context?: JsonValue) => {
      const result = await requestDecision({ kind: "score", question, levels, ...(context === undefined ? {} : { contextJson: contextJson(context) }) });
      if (result !== null && typeof result !== "number") throw new Error("application.ai.score returned an invalid result");
      return result;
    },
    decide: async (question: string, context?: JsonValue) => {
      const result = await requestDecision({ kind: "decide", question, ...(context === undefined ? {} : { contextJson: contextJson(context) }) });
      if (result !== null && typeof result !== "boolean") throw new Error("application.ai.decide returned an invalid result");
      return result;
    },
    probability: async (question: string, context?: JsonValue) => {
      const result = await requestDecision({ kind: "probability", question, ...(context === undefined ? {} : { contextJson: contextJson(context) }) });
      if (typeof result !== "number" || result < 0 || result > 1) throw new Error("application.ai.probability returned an invalid result");
      return result;
    },
  });
  const escalate = (reason: string): void => {
    if (!reason.trim()) throw new Error("application.escalate requires a reason");
    bridge.post({ type: "wake", reason });
  };
  const memory = async (): Promise<string> => {
    const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "memory.request" }, 30_000);
    if (response.type !== "memory.response") throw new Error(`Unexpected memory response: ${response.type}`);
    if (response.error) throw new Error(response.error.message);
    return response.memory ?? "";
  };
  const transactionState: { controller?: AgentTransactionController } = {};
  const verify = async <T>(work: () => T | Promise<T>): Promise<T> => {
    if (typeof work !== "function") throw new TypeError("agent.verify(work) requires a verification callback");
    if (!transactionState.controller) throw new Error("agent.verify() is unavailable until the app runtime is ready");
    return transactionState.controller.verify(work);
  };

  const applicationApi: ApplicationRuntimeApi = Object.freeze({
    store: applicationStore.store,
    ai,
    escalate,
  });
  const agentApi: AgentRuntimeApi = Object.freeze({
    memory,
    screenshot,
    verify,
    done,
  });
  installApplicationApi(window, applicationApi);
  installAgentApi(window, agentApi);
  const durability = installAgentDurabilityAudit();

  const run = async (code: string, executionLogs: ExecutionConsoleEntry[]): Promise<{ value: unknown; completion?: DoneSignal }> => {
    let completion: DoneSignal | undefined;
    const executionAgent: AgentRuntimeApi = Object.freeze({
      memory,
      screenshot,
      verify,
      done: (message?: string) => {
        const signal = doneSignal(message);
        completion = signal;
        return signal;
      },
    });
    const restoreConsole = installExecutionConsoleCapture(executionLogs);
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const value = await new AsyncFunction("agent", `"use strict";\n${code}`).call(window, executionAgent);
      return { value, ...(completion ? { completion } : {}) };
    } finally {
      restoreConsole();
    }
  };

  const listener = async (event: MessageEvent<unknown>) => {
    const message = bridge.validate(event);
    if (!message) return;
    if (bridge.acceptResponse(message)) return;
    if (message.type === "document.snapshot") {
      const document = serializeAppDocument(applicationStore.snapshot());
      if (appDocumentCharacterSize(document) > MAX_SAVED_DOCUMENT_CHARACTERS) {
        bridge.post({ type: "execution.error", error: serializeError(new Error("Saved document is too large")) }, message.requestId);
      } else {
        bridge.post({ type: "result", result: { document } }, message.requestId);
      }
    } else if (message.type === "execute") {
      const executionLogs: ExecutionConsoleEntry[] = [];
      try {
        ensureCanonicalAppRoot();
        if (!transactionState.controller) throw new Error("Agent execution transaction controller is not ready");
        const execution = await transactionState.controller.runCommand(async () => {
          const result = await durability.runAgentCommand(() => run(message.code, executionLogs));
          enforceCanonicalAppRootAfterAgentCommand();
          return result;
        });
        const returnedCompletion = isDoneSignal(execution.value) ? execution.value : undefined;
        const completion = returnedCompletion ?? execution.completion;
        const consolePayload = executionLogs.length ? { logs: executionLogs } : {};
        if (completion) bridge.post({ type: "result", done: true, message: completion.message, ...consolePayload }, message.requestId);
        else bridge.post({ type: "result", result: bounded(execution.value, options.maxResultBytes ?? 256_000), ...consolePayload }, message.requestId);
      } catch (error) {
        logs.add("error", ["Agent execution failed", error], "agent", error instanceof Error ? error.stack : undefined);
        bridge.post({ type: "execution.error", error: serializeError(error), ...(executionLogs.length ? { logs: executionLogs } : {}) }, message.requestId);
      }
    }
  };

  // Responses to the initial restore request arrive on this same MessagePort.
  // Install the listener before the first request so AppBridge.acceptResponse()
  // can settle document.response instead of deadlocking startup.
  bridge.addMessageListener(listener);

  const saved = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "document.request" }, 10_000);
  if (saved.type !== "document.response") throw new Error(`Unexpected document response: ${saved.type}`);
  if (saved.error) throw new Error(saved.error.message);
  if (saved.document) {
    applicationStore.restore(saved.document.store);
    await restoreAppDocument(saved.document);
  }
  document.querySelectorAll("[data-itsalive-bootstrap]").forEach(node => node.remove());
  ensureCanonicalAppRoot();
  const autosave = installAutosave(document => {
    if (appDocumentCharacterSize(document) > MAX_SAVED_DOCUMENT_CHARACTERS) {
      logs.add("error", [`Saved document exceeds ${MAX_SAVED_DOCUMENT_CHARACTERS} characters; snapshot was not persisted`], "bridge");
      return;
    }
    bridge.post({ type: "document.save", document });
  }, options.autosaveDelay, () => applicationStore.snapshot());
  applicationStore.setOnDirty(autosave.schedule);
  transactionState.controller = createAgentTransactionController({
    applicationStore,
    autosave,
    durability,
    onRollbackError: error => {
      logs.add(
        "error",
        ["Agent transaction rollback failed", error],
        "agent",
        error instanceof Error ? error.stack : undefined,
      );
    },
  });
  const interactions = installInteractionObserver(bridge);
  bridge.post({ type: "status", status: "ready" });
  return { bridge, appId, autosave, destroy: () => {
    bridge.removeMessageListener(listener);
    interactions.destroy();
    durability.destroy();
    bridge.destroy();
    autosave.disconnect();
    logs.destroy();
  } };
}

export function installApplicationApi(target: Window, runtimeApi: ApplicationRuntimeApi): void {
  if (Object.prototype.hasOwnProperty.call(target, "application")) {
    throw new Error("Cannot install application runtime API because window.application already exists.");
  }
  Object.defineProperty(target, "application", {
    value: runtimeApi,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}


export function installAgentApi(target: Window, runtimeApi: AgentRuntimeApi): void {
  if (Object.prototype.hasOwnProperty.call(target, "agent")) {
    throw new Error("Cannot install agent runtime API because window.agent already exists.");
  }
  Object.defineProperty(target, "agent", {
    value: runtimeApi,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}
