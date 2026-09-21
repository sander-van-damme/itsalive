// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  posts: [] as Array<{ payload: Record<string, unknown>; requestId?: string }>,
  restoredWithApi: false,
  restoredHtml: undefined as string | undefined,
  persistDocument: undefined as ((html: string) => void) | undefined,
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
      if (payload.type === "history.request") return { type: "history.response", results: ["match"] };
      if (payload.type === "logs.request") return { type: "logs.response", results: [{ timestamp: 1, level: "error", source: "app", message: "boom" }] };
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
  serializeAppDocument: () => "<!doctype html><html><body><main>snapshot</main></body></html>",
  restoreAppDocument: async (html: string) => {
    state.restoredWithApi = window.itsalive?.apiVersion === 2;
    state.restoredHtml = html;
  },
  installAutosave: (persist: (html: string) => void) => {
    state.persistDocument = persist;
    return { save: vi.fn(), suspend: vi.fn(), resume: vi.fn(), disconnect: vi.fn() };
  },
}));

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
const nativeHistory = window.history;
const emit = (data: Record<string, unknown>) => {
  const listener = state.listener;
  if (!listener) throw new Error("Runtime listener is not installed");
  listener(new MessageEvent("message", { data }));
};

describe("injected app runtime namespace", () => {
  beforeAll(async () => {
    state.posts.length = 0;
    state.requests.length = 0;
    const { startAppRuntime } = await import("../src/runtime/runtime");
    await startAppRuntime({
      rootOrigin: "https://itsalive.test",
      appId: "550e8400-e29b-41d4-a716-446655440000",
      port: {} as MessagePort,
      documentHtml: "<!doctype html><html><body><main>shell saved</main></body></html>",
      screenshot: async element => {
        if (state.screenshotError) throw state.screenshotError;
        return element.tagName;
      },
    });
  });

  it("installs one immutable, versioned facade without replacing native history", () => {
    expect(window.history).toBe(nativeHistory);
    expect(Object.keys(window.itsalive)).toEqual([
      "apiVersion", "llm", "history", "agent", "dom", "logs", "components", "cron", "done",
    ]);
    expect(window.itsalive.apiVersion).toBe(2);
    expect(window.itsalive).not.toHaveProperty("db");
    expect(window.itsalive).not.toHaveProperty("reload");
    expect(Object.isFrozen(window.itsalive)).toBe(true);
    expect(Object.isFrozen(window.itsalive.dom)).toBe(true);
    expect(Object.isFrozen(window.itsalive.components)).toBe(true);
    expect(Object.keys(window.itsalive.components)).toHaveLength(94);
    expect(window.itsalive.components).toHaveProperty("modal");
    expect(window.itsalive.components).toHaveProperty("date-picker");
    expect(window.itsalive.components).toHaveProperty("modal/example-01");
    expect(Object.getOwnPropertyDescriptor(window, "itsalive")).toMatchObject({ writable: false, configurable: false, enumerable: false });
    expect(state.restoredWithApi).toBe(true);
    expect(state.restoredHtml).toContain("shell saved");
    expect(state.posts.some(({ payload }) => payload.type === "status" && payload.status === "ready")).toBe(true);
  });

  it("preserves bridge-backed LLM, history, wake, cron, DOM, logs, and completion behavior", async () => {
    expect(await window.itsalive.llm.ask("question")).toBe("answer");
    expect(state.requests.find(request => request.type === "llm.request")).toEqual({ type: "llm.request", prompt: "question" });
    expect(await window.itsalive.history.search({ query: "old" })).toEqual(["match"]);
    await window.itsalive.agent.wake("continue");
    expect(state.posts.some(({ payload }) => payload.type === "wake" && payload.reason === "continue")).toBe(true);
    expect(window.itsalive.cron("daily", "0 8 * * *", () => "fired")).toEqual({ id: "daily", schedule: "0 8 * * *" });
    expect(window.itsalive.dom).toEqual({ screenshot: expect.any(Function) });
    expect(await window.itsalive.logs.get({ level: "error", limit: 10 })).toEqual([
      { timestamp: 1, level: "error", source: "app", message: "boom" },
    ]);
    expect(state.requests.find(request => request.type === "logs.request")).toEqual({ type: "logs.request", level: "error", limit: 10 });
    await expect(window.itsalive.logs.get({ limit: 201 })).rejects.toThrow("Log limit must be an integer from 1 to 200");

    document.getElementById("itsalive-root")!.insertAdjacentHTML("beforeend", '<main data-native-dom="yes"><h1>Native DOM</h1></main>');
    emit({ type: "execute", code: "return itsalive.apiVersion;", requestId: "version" });
    emit({ type: "execute", code: "return document.querySelector('main[data-native-dom]');", requestId: "native-dom" });
    emit({ type: "execute", code: 'return itsalive.done("ok");', requestId: "done" });
    emit({ type: "cron.fire", callbackId: "daily", requestId: "cron" });
    emit({ type: "execute", code: "return await itsalive.dom.screenshot();", requestId: "screenshot" });
    await nextTask();
    expect(state.posts).toContainEqual({ payload: { type: "result", result: 2 }, requestId: "version" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: '<main data-native-dom="yes"><h1>Native DOM</h1></main>' }, requestId: "native-dom" });
    expect(state.posts).toContainEqual({ payload: { type: "result", done: true, message: "ok" }, requestId: "done" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: "fired" }, requestId: "cron" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: "HTML" }, requestId: "screenshot" });
    expect(state.posts.some(({ payload }) => payload.type === "screenshot")).toBe(false);
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
    emit({ type: "execute", code: "return await itsalive.dom.screenshot();", requestId: "screenshot-failure" });
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

  it("returns an explicit document snapshot before shell-driven teardown", async () => {
    emit({ type: "document.snapshot", requestId: "snapshot" });
    await nextTask();
    expect(state.posts).toContainEqual({
      payload: { type: "result", result: { html: "<!doctype html><html><body><main>snapshot</main></body></html>" } },
      requestId: "snapshot",
    });
  });

  it("sends autosave snapshots to the shell instead of writing runtime storage", () => {
    expect(state.persistDocument).toBeTypeOf("function");
    state.persistDocument!("<!doctype html><html><body><main>latest</main></body></html>");
    expect(state.posts).toContainEqual({
      payload: { type: "document.save", html: "<!doctype html><html><body><main>latest</main></body></html>" },
      requestId: undefined,
    });
  });

  it("fails clearly instead of overwriting an existing namespace", async () => {
    const { installRuntimeApi } = await import("../src/runtime/runtime");
    const target = {} as Window;
    Object.defineProperty(target, "itsalive", { value: { unrelated: true }, configurable: true });
    expect(() => installRuntimeApi(target, window.itsalive)).toThrow("window.itsalive already exists");
    expect((target.itsalive as unknown as { unrelated: boolean }).unrelated).toBe(true);
  });
});
