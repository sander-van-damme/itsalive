import { AppBridge } from "./bridge";
import { installLogging } from "./logs";
import { installAutosave, restoreAppDocument, serializeAppDocument } from "./persistence";
import { captureScreenshot, formatScreenshotUnavailable } from "./screenshot";
import type { RuntimeOptions } from "./types";
import type { AgentRuntimeApi, ApplicationAiApi, ApplicationRuntimeApi } from "./globals";
import { createApplicationStore } from "./application-store";
import type { ApplicationAiDecisionRequest, ApplicationAiDecisionResult, BridgeMessage, ShellToAppPayload } from "../shared";
import { MAX_SAVED_DOCUMENT_CHARACTERS, appDocumentCharacterSize, isApplicationAiDecisionRequest, serializeError } from "../shared";
import { installInteractionObserver } from "./interactions";
import { ensureCanonicalAppRoot, enforceCanonicalAppRootAfterAgentCommand } from "./app-root";
import { installAgentDurabilityAudit } from "./durability";

const DONE = Symbol("agent-done");

interface DoneSignal {
  [DONE]: true;
  message?: string;
}

function doneSignal(message?: string): DoneSignal {
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
  const text = async (prompt: unknown): Promise<string> => {
    const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    if (typeof promptText !== "string") throw new TypeError("application.ai.text prompt must be text or JSON-serializable");
    const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({
      type: "llm.request",
      prompt: promptText,
    }, 120_000);
    if (response.type !== "llm.response") throw new Error(`Unexpected LLM response: ${response.type}`);
    if (response.error) throw new Error(response.error.message);
    if (typeof response.result !== "string") throw new Error("application.ai.text returned a non-text result");
    return response.result;
  };
  const contextJson = (context: unknown): string | undefined => {
    if (context === undefined) return undefined;
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
    choose: async (question: string, options: Record<string, string>, context?: unknown) => {
      const result = await requestDecision({ kind: "choose", question, options, ...(context === undefined ? {} : { contextJson: contextJson(context) }) });
      if (result !== null && typeof result !== "string") throw new Error("application.ai.choose returned an invalid result");
      return result;
    },
    score: async (question: string, levels: string[], context?: unknown) => {
      const result = await requestDecision({ kind: "score", question, levels, ...(context === undefined ? {} : { contextJson: contextJson(context) }) });
      if (result !== null && typeof result !== "number") throw new Error("application.ai.score returned an invalid result");
      return result;
    },
    decide: async (question: string, context?: unknown) => {
      const result = await requestDecision({ kind: "decide", question, ...(context === undefined ? {} : { contextJson: contextJson(context) }) });
      if (result !== null && typeof result !== "boolean") throw new Error("application.ai.decide returned an invalid result");
      return result;
    },
    probability: async (question: string, context?: unknown) => {
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

  const applicationApi: ApplicationRuntimeApi = Object.freeze({
    store: applicationStore.store,
    ai,
    escalate,
  });
  const agentApi: AgentRuntimeApi = Object.freeze({
    memory,
    screenshot,
    done,
  });
  installApplicationApi(window, applicationApi);
  installAgentApi(window, agentApi);
  const durability = installAgentDurabilityAudit();

  const run = async (code: string): Promise<{ value: unknown; completion?: DoneSignal }> => {
    let completion: DoneSignal | undefined;
    const executionAgent: AgentRuntimeApi = Object.freeze({
      memory,
      screenshot,
      done: (message?: string) => {
        const signal = doneSignal(message);
        completion = signal;
        return signal;
      },
    });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const value = await new AsyncFunction("agent", `"use strict";\n${code}`).call(window, executionAgent);
    return { value, ...(completion ? { completion } : {}) };
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
      try {
        ensureCanonicalAppRoot();
        let execution: { value: unknown; completion?: DoneSignal };
        try {
          execution = await durability.runAgentCommand(() => run(message.code));
        } catch (error) {
          try {
            enforceCanonicalAppRootAfterAgentCommand();
          } catch (rootError) {
            logs.add("warn", ["Canonical app root repaired after a failed agent command", rootError], "agent", rootError instanceof Error ? rootError.stack : undefined);
          }
          throw error;
        }
        enforceCanonicalAppRootAfterAgentCommand();
        const returnedCompletion = isDoneSignal(execution.value) ? execution.value : undefined;
        const completion = returnedCompletion ?? execution.completion;
        if (completion) bridge.post({ type: "result", done: true, message: completion.message }, message.requestId);
        else bridge.post({ type: "result", result: bounded(execution.value, options.maxResultBytes ?? 256_000) }, message.requestId);
      } catch (error) {
        logs.add("error", ["Agent execution failed", error], "agent", error instanceof Error ? error.stack : undefined);
        bridge.post({ type: "execution.error", error: serializeError(error) }, message.requestId);
      }
    }
  };
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
