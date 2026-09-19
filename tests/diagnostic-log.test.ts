import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticLog, buildDiagnosticExport } from "../src/shell/core/diagnostic-log";
import type { HistoryEntry, LogEntry } from "../src/shell/core/types";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_APP_ID = "650e8400-e29b-41d4-a716-446655440000";

function quietConsole(): void {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "trace").mockImplementation(() => undefined);
  vi.spyOn(console, "table").mockImplementation(() => undefined);
  vi.spyOn(console, "dir").mockImplementation(() => undefined);
  vi.spyOn(console, "group").mockImplementation(() => undefined);
  vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
  vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
}

function fakeDb(entries: LogEntry[]) {
  return {
    logs: {
      add: vi.fn(async (entry: LogEntry) => {
        entries.push(entry);
        return entries.length;
      }),
    },
  };
}

describe("DiagnosticLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists nested LLM console traces with full sanitized diagnostics and the agent app id", async () => {
    quietConsole();
    const entries: LogEntry[] = [];
    const logger = new DiagnosticLog(fakeDb(entries) as never, () => undefined);
    const uninstall = logger.installConsoleCapture();

    console.groupCollapsed(`[itsalive:agent] Run · ${APP_ID}`);
    console.groupCollapsed("[itsalive:agent] Turn 1/12");
    console.groupCollapsed("[itsalive:llm] agent turn 1 · openrouter/openrouter/auto");
    console.info("Request", {
      system: "full system prompt",
      messages: [{ role: "user", content: "full user message" }],
      authorization: "Bearer secret-token",
    });
    console.info("Response (12ms)", {
      text: "full assistant response",
      raw: { apiKey: "another-secret" },
    });
    console.groupEnd();
    console.groupEnd();
    console.groupEnd();

    await logger.flush();
    uninstall();

    const request = entries.find(entry => entry.source === "llm" && entry.message === "Request");
    const response = entries.find(entry => entry.source === "llm" && entry.message === "Response (12ms)");
    expect(request).toMatchObject({ appId: APP_ID, level: "info", source: "llm", message: "Request" });
    expect(response).toMatchObject({ appId: APP_ID, level: "info", source: "llm", message: "Response (12ms)" });

    const trace = JSON.stringify([request?.details, response?.details]);
    expect(trace).toContain("full system prompt");
    expect(trace).toContain("full user message");
    expect(trace).toContain("full assistant response");
    expect(trace).toContain("[redacted]");
    expect(trace).not.toContain("secret-token");
    expect(trace).not.toContain("another-secret");
  });

  it("writes explicit diagnostics exactly once even while console capture is installed", async () => {
    quietConsole();
    const entries: LogEntry[] = [];
    const logger = new DiagnosticLog(fakeDb(entries) as never, () => APP_ID);
    const uninstall = logger.installConsoleCapture();

    await logger.write("info", "runtime", "Saved", { value: 42 });
    await logger.flush();
    uninstall();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      appId: APP_ID,
      level: "info",
      source: "runtime",
      message: "Saved",
      details: { value: 42 },
    });
  });
});

describe("buildDiagnosticExport", () => {
  it("merges active-app chat with persisted console logs in chronological order", () => {
    const logs: LogEntry[] = [
      { timestamp: 2, level: "info", source: "llm", message: "Request", details: { prompt: "hello" }, appId: APP_ID },
      { timestamp: 3, level: "warn", source: "shell", message: "global warning" },
      { timestamp: 4, level: "error", source: "other", message: "other app", appId: OTHER_APP_ID },
    ];
    const history: HistoryEntry[] = [
      { timestamp: 1, appId: APP_ID, role: "user", kind: "chat", content: "hello\nworld" },
      { timestamp: 5, appId: APP_ID, role: "assistant", kind: "chat", content: "done" },
      { timestamp: 6, appId: APP_ID, role: "agent", kind: "javascript", content: "return 1" },
      { timestamp: 7, appId: OTHER_APP_ID, role: "user", kind: "chat", content: "not selected" },
    ];

    const lines = buildDiagnosticExport(logs, history, APP_ID).split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("[chat:user] hello\\nworld");
    expect(lines[1]).toContain("[llm] Request");
    expect(lines[1]).toContain('{"prompt":"hello"}');
    expect(lines[2]).toContain("[shell] global warning");
    expect(lines[3]).toContain("[chat:assistant] done");
    expect(lines.join("\n")).not.toContain("other app");
    expect(lines.join("\n")).not.toContain("not selected");
  });

  it("exports diagnostics across apps when no app filter is supplied", () => {
    const logs: LogEntry[] = [
      { timestamp: 1, level: "info", source: "agent", message: "first app", appId: APP_ID },
      { timestamp: 2, level: "error", source: "agent", message: "deleted app failure", appId: OTHER_APP_ID },
    ];

    const output = buildDiagnosticExport(logs, []);

    expect(output).toContain("first app");
    expect(output).toContain("deleted app failure");
  });
});
