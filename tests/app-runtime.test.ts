// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  posts: [] as Array<{ payload: Record<string, unknown>; requestId?: string }>,
  rows: new Map<string, unknown>(),
  restoredWithApi: false,
  requests: [] as Record<string, unknown>[],
  screenshotError: undefined as Error | undefined,
}));

vi.mock("../src/app/bridge", () => ({
  idFromHostname: () => "550e8400-e29b-41d4-a716-446655440000",
  AppBridge: class {
    post(payload: Record<string, unknown>, requestId?: string) { state.posts.push({ payload, requestId }); }
    validate(event: MessageEvent) { return event.data; }
    acceptResponse() { return false; }
    async request(payload: Record<string, unknown>) {
      state.requests.push(payload);
      if (payload.type === "llm.request") return { type: "llm.response", result: "answer" };
      if (payload.type === "history.request") return { type: "history.response", results: ["match"] };
      throw new Error(`Unexpected request: ${String(payload.type)}`);
    }
  },
}));

vi.mock("../src/app/db", () => ({
  STORES: { document: "document" },
  dbGet: async (_store: string, key: IDBValidKey) => state.rows.get(String(key)),
  dbSet: async (_store: string, key: IDBValidKey, value: unknown) => { state.rows.set(String(key), value); return value; },
  closeAppDatabase: async () => undefined,
}));

vi.mock("../src/app/logs", () => ({
  installLogging: () => {
    const entries: unknown[] = [];
    return { add: (...entry: unknown[]) => entries.push(entry), get: () => entries };
  },
}));

vi.mock("../src/app/persistence", () => ({
  loadSavedDocument: async () => { state.restoredWithApi = window.itsalive?.apiVersion === 2; },
  installAutosave: () => ({ suspend: vi.fn(), disconnect: vi.fn() }),
}));

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
const nativeHistory = window.history;

describe("app runtime namespace", () => {
  beforeAll(async () => {
    state.posts.length = 0;
    const { startAppRuntime } = await import("../src/app/runtime");
    await startAppRuntime({ rootOrigin: "https://itsalive.test", appId: "550e8400-e29b-41d4-a716-446655440000", screenshot: async element => {
      if (state.screenshotError) throw state.screenshotError;
      return element.tagName;
    } });
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
    expect(window.itsalive.logs.get()).toEqual([]);

    document.getElementById("itsalive-root")!.insertAdjacentHTML("beforeend", '<main data-native-dom="yes"><h1>Native DOM</h1></main>');
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: "return itsalive.apiVersion;", requestId: "version" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: "return document.querySelector('main[data-native-dom]');", requestId: "native-dom" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: 'return itsalive.done("ok");', requestId: "done" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "cron.fire", callbackId: "daily", requestId: "cron" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: "return await itsalive.dom.screenshot();", requestId: "screenshot" } }));
    await nextTask();
    expect(state.posts).toContainEqual({ payload: { type: "result", result: 2 }, requestId: "version" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: '<main data-native-dom="yes"><h1>Native DOM</h1></main>' }, requestId: "native-dom" });
    expect(state.posts).toContainEqual({ payload: { type: "result", done: true, message: "ok" }, requestId: "done" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: "fired" }, requestId: "cron" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: "HTML" }, requestId: "screenshot" });
    expect(state.posts.some(({ payload }) => payload.type === "screenshot")).toBe(false);
  });

  it("rejects UI appended beside the canonical app root and removes the duplicate surface", async () => {
    const root = document.getElementById("itsalive-root");
    expect(root).toBeTruthy();
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "execute",
      code: "document.body.insertAdjacentHTML('beforeend', '<main data-duplicate-app>Duplicate</main>'); return 'added';",
      requestId: "duplicate-root",
    } }));
    await nextTask();

    const response = state.posts.find(({ requestId }) => requestId === "duplicate-root");
    expect(response?.payload.type).toBe("execution.error");
    expect(JSON.stringify(response?.payload)).toContain("#itsalive-root");
    expect(document.querySelector("[data-duplicate-app]")).toBeNull();
    expect(document.getElementById("itsalive-root")).toBe(root);
  });

  it("keeps screenshot verification failures non-fatal", async () => {
    state.screenshotError = new Error("canvas export blocked");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: "return await itsalive.dom.screenshot();", requestId: "screenshot-failure" } }));
    await nextTask();
    state.screenshotError = undefined;

    const response = state.posts.find(({ requestId }) => requestId === "screenshot-failure");
    expect(response?.payload.type).toBe("result");
    expect(String(response?.payload.result)).toContain("[screenshot unavailable:");
    expect(state.posts.some(({ requestId, payload }) => requestId === "screenshot-failure" && payload.type === "execution.error")).toBe(false);
  });

  it("returns only the current execution error instead of recursively embedding prior logs", async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: 'throw new Error("first failure");', requestId: "error-one" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: 'throw new Error("second failure");', requestId: "error-two" } }));
    await nextTask();

    const second = state.posts.find(({ requestId }) => requestId === "error-two");
    expect(second?.payload.type).toBe("execution.error");
    expect(second?.payload.error).toEqual(expect.objectContaining({ name: "Error", message: "second failure" }));
    expect(second?.payload.error).not.toHaveProperty("cause");
    expect(JSON.stringify(second)).not.toContain("first failure");
  });

  it("clears origin storage through the private shell command", async () => {
    localStorage.setItem("app", "state");
    sessionStorage.setItem("app", "session");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "storage.clear", requestId: "clear" } }));
    await nextTask();
    expect(localStorage.getItem("app")).toBeNull();
    expect(sessionStorage.getItem("app")).toBeNull();
    await vi.waitFor(() => expect(state.posts).toContainEqual({ payload: { type: "result", result: { cleared: true } }, requestId: "clear" }));
  });

  it("fails clearly instead of overwriting an existing namespace", async () => {
    const { installRuntimeApi } = await import("../src/app/runtime");
    const target = {} as Window;
    Object.defineProperty(target, "itsalive", { value: { unrelated: true }, configurable: true });
    expect(() => installRuntimeApi(target, window.itsalive)).toThrow("window.itsalive already exists");
    expect((target.itsalive as unknown as { unrelated: boolean }).unrelated).toBe(true);
  });


});
