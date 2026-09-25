// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  posts: [] as Array<{ payload: Record<string, unknown>; requestId?: string }>,
  restoredWithApi: false,
  restoredDocument: undefined as { html: string; scripts: unknown[]; store: string } | undefined,
  persistDocument: undefined as ((document: { html: string; scripts: unknown[]; store: string }) => void) | undefined,
  scheduleSave: vi.fn(),
  requests: [] as Record<string, unknown>[],
  screenshotError: undefined as Error | undefined,
  listener: undefined as ((event: MessageEvent<unknown>) => void) | undefined,
}));

vi.mock("../src/runtime/bridge", () => ({
  AppBridge: class {
    post(payload: Record<string, unknown>, requestId?: string) { state.posts.push({ payload, requestId }); }
    validate(event: MessageEvent<unknown>) { return event.data; }
    acceptResponse() { return false; }
    addMessageListener(listener: (event: MessageEvent<unknown>) => void) { state.listener = listener; }
    removeMessageListener(listener: (event: MessageEvent<unknown>) => void) { if (state.listener === listener) state.listener = undefined; }
    destroy() { state.listener = undefined; }
    async request(payload: Record<string, unknown>) {
      state.requests.push(payload);
      if (payload.type === "llm.request") return { type: "llm.response", result: "answer" };
      if (payload.type === "ai.decision.request") {
        const decision = payload.decision as { kind?: string };
        const result = decision.kind === "choose" ? "billing"
          : decision.kind === "score" ? 1.2
            : decision.kind === "decide" ? null
              : decision.kind === "probability" ? .93
                : undefined;
        return { type: "ai.decision.response", result };
      }
      if (payload.type === "memory.request") return { type: "memory.response", memory: "Prefers fast feedback." };
      if (payload.type === "document.request") return {
        type: "document.response",
        document: { html: "<!doctype html><html><body><main>shell saved</main></body></html>", scripts: [], store: "{\"counter\":{\"count\":3}}" },
      };
      throw new Error(`Unexpected request: ${String(payload.type)}`);
    }
  },
}));

vi.mock("../src/runtime/logs", () => ({
  installLogging: () => {
    const entries: unknown[] = [];
    return { add: (...entry: unknown[]) => entries.push(entry), destroy: vi.fn() };
  },
}));

vi.mock("../src/runtime/persistence", () => ({
  serializeAppDocument: (store = "{}") => ({ html: "<!doctype html><html><body><main>snapshot</main></body></html>", scripts: [], store }),
  restoreAppDocument: async (document: { html: string; scripts: unknown[]; store: string }) => {
    state.restoredWithApi = Boolean(window.application)
      && Boolean(window.agent)
      && (window.application.store.counter as { count?: number } | undefined)?.count === 3;
    state.restoredDocument = document;
  },
  installAutosave: (
    persist: (document: { html: string; scripts: unknown[]; store: string }) => void,
    _delay: number,
    storeSnapshot: () => string,
  ) => {
    state.persistDocument = persist;
    return {
      save: vi.fn(),
      schedule: () => state.scheduleSave(storeSnapshot()),
      suspend: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn(),
    };
  },
}));

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
const nativeHistory = window.history;
const emit = (data: Record<string, unknown>) => {
  const listener = state.listener;
  if (!listener) throw new Error("Runtime listener is not installed");
  listener(new MessageEvent("message", { data }));
};

describe("injected app runtime namespaces", () => {
  beforeAll(async () => {
    state.posts.length = 0;
    state.requests.length = 0;
    const { startAppRuntime } = await import("../src/runtime/runtime");
    await startAppRuntime({
      rootOrigin: "https://itsalive.test",
      appId: "550e8400-e29b-41d4-a716-446655440000",
      port: {} as MessagePort,
      screenshot: async element => {
        if (state.screenshotError) throw state.screenshotError;
        return element.tagName;
      },
    });
  });

  it("installs application and agent before restoring app scripts", () => {
    expect(window.history).toBe(nativeHistory);
    expect((window.application.store.counter as { count: number }).count).toBe(3);
    expect(Object.keys(window.application)).toEqual(["store", "ai", "escalate"]);
    expect(Object.keys(window.application.ai)).toEqual(["text", "choose", "score", "decide", "probability"]);
    expect(Object.isFrozen(window.application.ai)).toBe(true);
    expect(Object.keys(window.agent)).toEqual(["memory", "screenshot", "done"]);
    expect(Object.isFrozen(window.application)).toBe(true);
    expect(Object.isFrozen(window.agent)).toBe(true);
    expect(window).not.toHaveProperty("itsalive");
    expect(Object.getOwnPropertyDescriptor(window, "application")).toMatchObject({ writable: false, configurable: false, enumerable: false });
    expect(Object.getOwnPropertyDescriptor(window, "agent")).toMatchObject({ writable: false, configurable: false, enumerable: false });
    expect(state.restoredWithApi).toBe(true);
    expect(state.requests[0]).toEqual({ type: "document.request" });
    expect(state.restoredDocument?.html).toContain("shell saved");
    expect(state.restoredDocument?.store).toBe('{"counter":{"count":3}}');
    expect(state.posts.some(({ payload }) => payload.type === "status" && payload.status === "ready")).toBe(true);
  });

  it("supports simple application AI values, escalation, curated memory, screenshot, and completion", async () => {
    expect(await window.application.ai.text("question")).toBe("answer");
    expect(state.requests.find(request => request.type === "llm.request")).toEqual({ type: "llm.request", prompt: "question" });

    expect(await window.application.ai.choose(
      "Which route?",
      { billing: "Payments", technical: "Broken feature" },
      { subject: "refund" },
    )).toBe("billing");
    expect(await window.application.ai.score("Severity?", ["Low", "Medium", "High"], { broken: true })).toBe(1.2);
    expect(await window.application.ai.decide("Refund request?", "please refund")).toBeNull();
    expect(await window.application.ai.probability("Refund request?", "please refund")).toBe(.93);

    expect(state.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "ai.decision.request",
        decision: {
          kind: "choose",
          question: "Which route?",
          options: { billing: "Payments", technical: "Broken feature" },
          contextJson: '{"subject":"refund"}',
        },
      }),
      expect.objectContaining({
        type: "ai.decision.request",
        decision: {
          kind: "score",
          question: "Severity?",
          levels: ["Low", "Medium", "High"],
          contextJson: '{"broken":true}',
        },
      }),
    ]));

    await expect(window.application.ai.choose("?", { only: "one" })).rejects.toThrow("Invalid application.ai decision request");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(window.application.ai.decide("Circular?", circular)).rejects.toThrow("JSON-serializable");

    window.application.escalate("continue");
    expect(state.posts.some(({ payload }) => payload.type === "wake" && payload.reason === "continue")).toBe(true);
    expect(() => window.application.escalate("   ")).toThrow("application.escalate requires a reason");

    expect(await window.agent.memory()).toBe("Prefers fast feedback.");
    expect(state.requests.find(request => request.type === "memory.request")).toEqual({ type: "memory.request" });
    expect(await window.agent.screenshot()).toBe("HTML");

    document.getElementById("itsalive-root")!.insertAdjacentHTML("beforeend", '<main data-native-dom="yes"><h1>Native DOM</h1></main>');
    emit({ type: "execute", code: "return document.querySelector('main[data-native-dom]');", requestId: "native-dom" });
    emit({ type: "execute", code: 'return agent.done("ok");', requestId: "done" });
    emit({ type: "execute", code: "return await agent.screenshot();", requestId: "screenshot" });
    await nextTask();

    expect(state.posts).toContainEqual({ payload: { type: "result", result: '<main data-native-dom="yes"><h1>Native DOM</h1></main>' }, requestId: "native-dom" });
    expect(state.posts).toContainEqual({ payload: { type: "result", done: true, message: "ok" }, requestId: "done" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: "HTML" }, requestId: "screenshot" });
  });

  it("captures nested done calls per execution without leaking completion state", async () => {
    emit({ type: "execute", code: '(() => { agent.done("nested"); })();', requestId: "nested-done" });
    emit({ type: "execute", code: "return null;", requestId: "after-nested-done" });
    await nextTask();

    expect(state.posts).toContainEqual({
      payload: { type: "result", done: true, message: "nested" },
      requestId: "nested-done",
    });
    expect(state.posts).toContainEqual({
      payload: { type: "result", result: null },
      requestId: "after-nested-done",
    });
    expect(state.posts.some(({ requestId, payload }) => requestId === "after-nested-done" && payload.done === true)).toBe(false);
  });

  it("tracks listeners installed only by transient agent commands", async () => {
    emit({
      type: "execute",
      code: "const button = document.createElement('button'); button.dataset.ephemeral = 'yes'; document.getElementById('itsalive-root').append(button); button.addEventListener('click', () => {}); return 'wired';",
      requestId: "ephemeral-listener",
    });
    await nextTask();

    emit({
      type: "execute",
      code: "return window['__itsaliveRuntimeDurabilityAuditV1']();",
      requestId: "durability-audit",
    });
    await nextTask();

    expect(state.posts).toContainEqual({
      payload: { type: "result", result: { runtimeOnlyEventListenerCount: 1 } },
      requestId: "durability-audit",
    });

    document.querySelector("[data-ephemeral]")?.remove();
  });

  it("rejects UI appended beside the canonical app root and removes the duplicate surface", async () => {
    const root = document.getElementById("itsalive-root");
    expect(root).toBeTruthy();
    emit({
      type: "execute",
      code: "document.body.insertAdjacentHTML('beforeend', '<main data-duplicate-app>Duplicate</main>'); return 'added';",
      requestId: "duplicate-root",
    });
    await nextTask();

    const response = state.posts.find(({ requestId }) => requestId === "duplicate-root");
    expect(response?.payload.type).toBe("execution.error");
    expect(JSON.stringify(response?.payload)).toContain("#itsalive-root");
    expect(document.querySelector("[data-duplicate-app]")).toBeNull();
    expect(document.getElementById("itsalive-root")).toBe(root);
  });

  it("keeps screenshot verification failures non-fatal", async () => {
    state.screenshotError = new Error("canvas export blocked");
    emit({ type: "execute", code: "return await agent.screenshot();", requestId: "screenshot-failure" });
    await nextTask();
    state.screenshotError = undefined;

    const response = state.posts.find(({ requestId }) => requestId === "screenshot-failure");
    expect(response?.payload.type).toBe("result");
    expect(String(response?.payload.result)).toContain("[screenshot unavailable:");
    expect(state.posts.some(({ requestId, payload }) => requestId === "screenshot-failure" && payload.type === "execution.error")).toBe(false);
  });

  it("returns only the current execution error instead of recursively embedding prior logs", async () => {
    emit({ type: "execute", code: 'throw new Error("first failure");', requestId: "error-one" });
    emit({ type: "execute", code: 'throw new Error("second failure");', requestId: "error-two" });
    await nextTask();

    const second = state.posts.find(({ requestId }) => requestId === "error-two");
    expect(second?.payload.type).toBe("execution.error");
    expect(second?.payload.error).toEqual(expect.objectContaining({ name: "Error", message: "second failure" }));
    expect(second?.payload.error).not.toHaveProperty("cause");
    expect(JSON.stringify(second)).not.toContain("first failure");
  });

  it("returns an explicit document snapshot with durable store state before shell-driven teardown", async () => {
    (window.application.store.counter as { count: number }).count = 9;
    emit({ type: "document.snapshot", requestId: "snapshot" });
    await nextTask();
    expect(state.posts).toContainEqual({
      payload: { type: "result", result: { document: { html: "<!doctype html><html><body><main>snapshot</main></body></html>", scripts: [], store: '{"counter":{"count":9}}' } } },
      requestId: "snapshot",
    });
  });

  it("sends autosave snapshots to the shell instead of writing runtime storage", () => {
    expect(state.persistDocument).toBeTypeOf("function");
    state.persistDocument!({ html: "<!doctype html><html><body><main>latest</main></body></html>", scripts: [], store: '{"counter":{"count":9}}' });
    expect(state.posts).toContainEqual({
      payload: { type: "document.save", document: { html: "<!doctype html><html><body><main>latest</main></body></html>", scripts: [], store: '{"counter":{"count":9}}' } },
      requestId: undefined,
    });
  });

  it("schedules autosave for store-only nested mutations", () => {
    state.scheduleSave.mockClear();
    const store = window.application.store as Record<string, unknown>;
    store.tasks = [];
    (store.tasks as Array<{ done: boolean }>).push({ done: false });
    (store.tasks as Array<{ done: boolean }>).at(0)!.done = true;
    delete store.tasks;
    expect(state.scheduleSave).toHaveBeenCalled();
  });

  it("fails clearly instead of overwriting existing application or agent globals", async () => {
    const { installAgentApi, installApplicationApi } = await import("../src/runtime/runtime");

    const applicationTarget = {} as Window;
    Object.defineProperty(applicationTarget, "application", { value: { unrelated: true }, configurable: true });
    expect(() => installApplicationApi(applicationTarget, window.application)).toThrow("window.application already exists");

    const agentTarget = {} as Window;
    Object.defineProperty(agentTarget, "agent", { value: { unrelated: true }, configurable: true });
    expect(() => installAgentApi(agentTarget, window.agent)).toThrow("window.agent already exists");
  });
});
