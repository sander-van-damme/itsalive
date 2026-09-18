// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  posts: [] as Array<{ payload: Record<string, unknown>; requestId?: string }>,
  rows: new Map<string, unknown>(),
  restoredWithApi: false,
}));

vi.mock("../src/app/bridge", () => ({
  idFromHostname: () => "test-app",
  AppBridge: class {
    post(payload: Record<string, unknown>, requestId?: string) { state.posts.push({ payload, requestId }); }
    validate(event: MessageEvent) { return event.data; }
    acceptResponse() { return false; }
    async request(payload: Record<string, unknown>) {
      if (payload.type === "llm.request") return { type: "llm.response", result: "answer" };
      if (payload.type === "history.request") return { type: "history.response", results: ["match"] };
      throw new Error(`Unexpected request: ${String(payload.type)}`);
    }
  },
}));

vi.mock("../src/app/db", () => {
  const api = {
    get: async (key: IDBValidKey) => state.rows.get(String(key)),
    set: async (key: IDBValidKey, value: unknown) => { state.rows.set(String(key), value); return value; },
    delete: async (key: IDBValidKey) => { state.rows.delete(String(key)); },
    query: async () => [],
  };
  return {
    appDatabaseApi: api,
    STORES: { document: "document", data: "data", tools: "tools" },
    dbGet: async (_store: string, key: IDBValidKey) => state.rows.get(String(key)),
    dbSet: async (_store: string, key: IDBValidKey, value: unknown) => { state.rows.set(String(key), value); return value; },
    dbDelete: async (_store: string, key: IDBValidKey) => { state.rows.delete(String(key)); },
    dbQuery: async () => [...state.rows.values()].map((value, index) => ({ key: index, value })),
  };
});

vi.mock("../src/app/logs", () => ({
  installLogging: () => {
    const entries: unknown[] = [];
    return { add: (...entry: unknown[]) => entries.push(entry), get: () => entries };
  },
}));

vi.mock("../src/app/persistence", () => ({
  loadSavedDocument: async () => { state.restoredWithApi = window.itsalive?.apiVersion === 1; },
  installAutosave: () => ({ disconnect: vi.fn() }),
}));

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
const nativeHistory = window.history;

describe("app runtime namespace", () => {
  beforeAll(async () => {
    state.posts.length = 0;
    const { startAppRuntime } = await import("../src/app/runtime");
    await startAppRuntime({ rootOrigin: "https://itsalive.test", appId: "test-app" });
  });

  it("installs one immutable, versioned facade without replacing native history", () => {
    expect(window.history).toBe(nativeHistory);
    expect(Object.keys(window.itsalive)).toEqual([
      "apiVersion", "db", "llm", "history", "tools", "agent", "dom", "logs", "cron", "reload", "done",
    ]);
    expect(window.itsalive.apiVersion).toBe(1);
    expect(Object.isFrozen(window.itsalive)).toBe(true);
    expect(Object.isFrozen(window.itsalive.dom)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(window, "itsalive")).toMatchObject({ writable: false, configurable: false, enumerable: false });
    for (const legacy of ["app", "agent", "tools", "cron", "inspectDom", "ref", "screenshot", "getLogs", "done"]) {
      expect(Object.prototype.hasOwnProperty.call(window, legacy)).toBe(false);
    }
    expect(state.restoredWithApi).toBe(true);
    expect(state.posts.some(({ payload }) => payload.type === "status" && payload.status === "ready")).toBe(true);
  });

  it("preserves bridge-backed LLM, history, wake, cron, DOM, logs, and completion behavior", async () => {
    expect(await window.itsalive.llm.ask("question")).toBe("answer");
    expect(await window.itsalive.history.search({ query: "old" })).toEqual(["match"]);
    await window.itsalive.agent.wake("continue");
    expect(state.posts.some(({ payload }) => payload.type === "wake" && payload.reason === "continue")).toBe(true);
    expect(window.itsalive.cron("daily", "0 8 * * *", () => "fired")).toEqual({ id: "daily", schedule: "0 8 * * *" });
    expect(window.itsalive.dom).toEqual(expect.objectContaining({ inspect: expect.any(Function), ref: expect.any(Function), screenshot: expect.any(Function) }));
    expect(window.itsalive.logs.get()).toEqual([]);

    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: "return itsalive.apiVersion;", requestId: "version" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "execute", code: 'return itsalive.done("ok");', requestId: "done" } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "cron.fire", callbackId: "daily", requestId: "cron" } }));
    await nextTask();
    expect(state.posts).toContainEqual({ payload: { type: "result", result: 1 }, requestId: "version" });
    expect(state.posts).toContainEqual({ payload: { type: "result", done: true, message: "ok" }, requestId: "done" });
    expect(state.posts).toContainEqual({ payload: { type: "result", result: "fired" }, requestId: "cron" });
  });

  it("passes the canonical namespace to custom tools as env.itsalive", async () => {
    await window.itsalive.tools.create({
      name: "runtimeVersion",
      description: "Read the runtime API version",
      code: "return async function(_args, env) { return { version: env.itsalive.apiVersion, legacy: 'app' in env }; }",
    });
    await expect(window.itsalive.tools.call("runtimeVersion")).resolves.toEqual({ version: 1, legacy: false });
  });

  it("fails clearly instead of overwriting an existing namespace", async () => {
    const { installRuntimeApi } = await import("../src/app/runtime");
    const target = {} as Window;
    Object.defineProperty(target, "itsalive", { value: { unrelated: true }, configurable: true });
    expect(() => installRuntimeApi(target, window.itsalive)).toThrow("window.itsalive already exists");
    expect((target.itsalive as unknown as { unrelated: boolean }).unrelated).toBe(true);
  });

  it("uses the namespace for shell tool inventory execution", async () => {
    const shell = await readFile(`${process.cwd()}/src/shell/main.ts`, "utf8");
    expect(shell).toContain('return await itsalive.tools.search("");');
    expect(shell).not.toContain('return await tools.search("");');
  });
});
