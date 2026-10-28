import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { Diagnostics, redact } from "../src/shell/diagnostics";
import { Repository } from "../src/storage/repository";
import type { Diagnostic } from "../src/shared/types";

function recorder() {
  const records: Diagnostic[] = [];
  const diagnostics = new Diagnostics({
    appendDiagnostic: async (record: Diagnostic) => {
      records.push(record);
    },
  } as unknown as Repository);
  return { records, diagnostics };
}

describe("diagnostic evidence and explicit content capture", () => {
  it("keeps transport context out of persisted records and uses the current content setting", async () => {
    const { records, diagnostics } = recorder();
    const context = {
      appId: "app",
      correlationId: "operation",
      signal: new AbortController().signal,
      privateExtra: "not diagnostic metadata",
    };
    diagnostics.debug = true;
    await diagnostics.record(
      "voice.error.presented",
      { providerMessage: "private provider response" },
      context,
    );
    diagnostics.debug = false;
    await diagnostics.record(
      "voice.error.presented",
      {
        providerMessage: "private provider response",
        providerError: { message: "private source" },
      },
      context,
    );
    expect(records[0]).not.toHaveProperty("signal");
    expect(records[0]).not.toHaveProperty("privateExtra");
    expect(records[0]!.data).toEqual({
      providerMessage: "private provider response",
    });
    expect(JSON.stringify(records[1])).not.toContain("private");
    expect(records[1]!.correlationId).toBe("operation");
    expect(() => structuredClone(records)).not.toThrow();
  });
  it("keeps ordinary logs free of prompts and runtime content until debug is enabled", async () => {
    const { records, diagnostics } = recorder();
    const context = { appId: "app", correlationId: "request" };
    await diagnostics.record(
      "runtime.diagnostic",
      {
        event: "console.error",
        message: "private patient record",
        errors: ["private state"],
      },
      context,
    );
    await diagnostics.record(
      "revision.applied",
      {
        message: "private original goal",
        files: ["private filename"],
        editToVisibleMs: 42,
      },
      context,
    );
    await diagnostics.record(
      "coding.failed",
      {
        message: "SyntaxError: private source fragment",
        reason: "invalid_tool_arguments",
      },
      context,
    );
    await diagnostics.record(
      "ai.request.content",
      { messages: [{ content: "private prompt" }] },
      context,
      "DEBUG",
    );
    expect(JSON.stringify(records)).not.toContain("private");
    expect(records.map(({ data }) => data)).toEqual([
      { kind: "console.error", errorCount: 1 },
      { fileCount: 1, editToVisibleMs: 42 },
      { errorClass: "SyntaxError", reason: "invalid_tool_arguments" },
    ]);
    expect(records.every((record) => record.correlationId === "request")).toBe(
      true,
    );
    expect(records[0]).toMatchObject({ level: "INFO", severity: "error" });
  });

  it("preserves full prompt, model, tool and structured error evidence in debug without silent caps", async () => {
    const { records, diagnostics } = recorder();
    diagnostics.debug = true;
    const content = "useful source\n".repeat(4000);
    const messages = Array.from({ length: 151 }, (_, i) => ({
      role: "user",
      content: `${i}: ${content}`,
    }));
    const cause = new Error("Cold candidate passed, hot apply failed");
    const failure = new TypeError("Cannot read string position", { cause });
    await diagnostics.record(
      "ai.request.content",
      { messages, schema: { type: "object" } },
      { correlationId: "workflow" },
      "DEBUG",
    );
    await diagnostics.record(
      "coding.tool.content",
      {
        name: "write_file",
        arguments: { source: content },
        output: { verified: true },
      },
      { correlationId: "workflow" },
      "DEBUG",
    );
    await diagnostics.record(
      "revision.failed",
      {
        error: failure,
        candidateRevisionId: "candidate",
        baseRevisionId: "working",
      },
      { correlationId: "workflow" },
    );
    expect(records[0]!.data).toEqual({ messages, schema: { type: "object" } });
    expect(records[1]!.data).toMatchObject({
      arguments: { source: content },
      output: { verified: true },
    });
    expect(records[2]!.data).toMatchObject({
      error: {
        name: "TypeError",
        message: failure.message,
        stack: failure.stack,
        cause: { message: cause.message },
      },
      candidateRevisionId: "candidate",
    });
  });

  it("withholds source-bearing exception text in ordinary mode while retaining its type and accounting status", async () => {
    const { records, diagnostics } = recorder();
    await diagnostics.record("ai.failure", {
      error: new SyntaxError("private source fragment"),
      status: 400,
      costStatus: "unknown",
    });
    expect(JSON.stringify(records)).not.toContain("private source fragment");
    expect(records[0]!.data).toMatchObject({
      error: { name: "SyntaxError", message: "[content not captured]" },
      status: 400,
      costStatus: "unknown",
    });
  });

  it("removes credentials at any depth in both modes while retaining public error and usage fields", () => {
    for (const capture of [false, true]) {
      const value = redact(
        {
          headers: {
            authorization: "arbitrary-private-credential",
            "content-type": "application/json",
          },
          "x-api-key": "arbitrary-private-credential",
          idToken: "arbitrary-private-credential",
          client_secret: "arbitrary-private-credential",
          oauthToken: "arbitrary-private-credential",
          "set-cookie": "private-session",
          nested: {
            message:
              "Request https://example.test/?access_token=private-query failed",
            source: "source is useful in debug",
          },
          status: "incomplete",
          reason: "max_output_tokens",
          inputTokens: 145000,
          check: { compiled: true, verified: false },
        },
        "",
        0,
        capture,
      );
      expect(JSON.stringify(value)).not.toContain("private");
      expect(JSON.stringify(value)).toContain("max_output_tokens");
      expect(JSON.stringify(value)).toContain("145000");
      expect(JSON.stringify(value).includes("source is useful in debug")).toBe(
        capture,
      );
    }
  });

  it("awaits fire-and-forget log writes and takes accounting and diagnostics from one persisted snapshot", async () => {
    const repo = new Repository(`diagnostic-snapshot-${crypto.randomUUID()}`);
    const diagnostics = new Diagnostics(repo);
    diagnostics.debug = true;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    void diagnostics.record("coding.started", { requestId: "one" });
    void diagnostics.record("coding.complete", { requestId: "one" });
    clock.mockRestore();
    await repo.setSetting("ai.usage", [{ id: "one", costUSD: 0.02 }]);
    const snapshot = await diagnostics.snapshot();
    expect(snapshot.diagnostics.map((row) => row.event)).toEqual([
      "coding.started",
      "coding.complete",
    ]);
    expect(snapshot.diagnostics.map((row) => row.timestamp)).toEqual([
      1000, 1000,
    ]);
    expect(snapshot.diagnostics).toMatchObject([
      { sequence: 1 },
      { sequence: 2 },
    ]);
    expect(snapshot.usage).toEqual([{ id: "one", costUSD: 0.02 }]);
    expect(snapshot.metadata).toMatchObject({
      debugEnabled: true,
      contentTruncated: false,
      pendingWrites: 0,
      failedWrites: 0,
      retainedEvents: 2,
    });
    await repo.close();
  });

  it("exports a visible persistence failure instead of causing an unhandled logging rejection", async () => {
    const diagnostics = new Diagnostics({
      appendDiagnostic: async () => {
        throw new Error("Storage quota exceeded");
      },
      diagnosticSnapshot: async () => ({
        diagnostics: [],
        usage: [],
        retention: { maxEntries: 2000, droppedCount: 0 },
        capturedAt: 1,
      }),
    } as unknown as Repository);
    void diagnostics.record("coding.failed", { message: "lost evidence" });
    const snapshot = await diagnostics.snapshot();
    expect(snapshot.metadata).toMatchObject({
      failedWrites: 1,
      pendingWrites: 0,
      lastPersistenceFailure: { message: "Storage quota exceeded" },
    });
  });

  it("marks legacy retention and content completeness unknown rather than certifying previously clipped rows", async () => {
    const repo = new Repository(`legacy-diagnostics-${crypto.randomUUID()}`);
    await repo.importData({
      version: 2,
      apps: [],
      revisions: [],
      conversations: [],
      settings: [],
      diagnostics: [
        {
          id: "legacy",
          timestamp: 1,
          event: "legacy.imported",
          level: "INFO",
          correlationId: "legacy",
        },
      ],
    });
    const diagnostics = new Diagnostics(repo);
    const before = await diagnostics.snapshot();
    expect(before.metadata.contentTruncated).toBeNull();
    expect(before.metadata.retention).toMatchObject({
      earlierDroppedCount: "unknown",
    });
    await diagnostics.record("new.event");
    expect((await diagnostics.snapshot()).metadata.retention).toMatchObject({
      earlierDroppedCount: "unknown",
    });
    await repo.close();
  });

  it("prunes the oldest session sequence when the retention boundary shares one timestamp", async () => {
    const repo = new Repository(`same-time-retention-${crypto.randomUUID()}`);
    const event = (sequence: number) => ({
      id: `row-${String(3000 - sequence).padStart(4, "0")}`,
      timestamp: 1,
      sessionId: "same-session",
      sequence,
      event: "test",
      level: "INFO" as const,
      correlationId: "test",
    });
    await repo.importData({
      version: 2,
      apps: [],
      revisions: [],
      conversations: [],
      settings: [],
      diagnostics: Array.from({ length: 2000 }, (_, i) => event(i + 1)),
    });
    await repo.appendDiagnostic(event(2001));
    const retained = await repo.listDiagnostics();
    expect(retained).toHaveLength(2000);
    expect(retained[0]).toMatchObject({ sequence: 2 });
    expect(retained.at(-1)).toMatchObject({ sequence: 2001 });
    await repo.close();
  });
});
