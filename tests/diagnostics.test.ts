import { describe, expect, it } from "vitest";
import { Diagnostics, redact } from "../src/shell/diagnostics";
import type { Repository } from "../src/storage/repository";
import type { Diagnostic } from "../src/shared/types";

describe("private diagnostic evidence", () => {
  it("keeps runtime and revision outcomes without exporting private generated output or goals", async () => {
    const records: Diagnostic[] = [];
    const diagnostics = new Diagnostics({
      appendDiagnostic: async (record: Diagnostic) => {
        records.push(record);
      },
    } as unknown as Repository);
    diagnostics.debug = true;
    const context = { appId: "app", correlationId: "request" };
    await diagnostics.record(
      "runtime.diagnostic",
      {
        event: "console.error",
        message: "private patient record",
        errors: ["private state"],
      },
      context,
      "DEBUG",
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
    expect(JSON.stringify(records)).not.toContain("private");
    expect(records.map(({ data }) => data)).toEqual([
      { kind: "console.error", errorCount: 1 },
      { fileCount: 1, editToVisibleMs: 42 },
      { errorClass: "SyntaxError", reason: "invalid_tool_arguments" },
    ]);
    expect(records.every((record) => record.correlationId === "request")).toBe(
      true,
    );
  });
  it("removes credentials and private content at every nesting level", () => {
    const value = redact({
      headers: { authorization: "arbitrary-private-credential" },
      "x-api-key": "arbitrary-private-credential",
      idToken: "arbitrary-private-credential",
      client_secret: "arbitrary-private-credential",
      oauthToken: "arbitrary-private-credential",
      "set-cookie": "private-session",
      nested: {
        source: "private application source",
        messages: [{ content: "private conversation" }],
        toolArguments: { content: "private tool source" },
        visibleText: "private saved user data",
        message:
          "Request https://example.test/?access_token=private-query failed",
      },
      status: "incomplete",
      reason: "max_output_tokens",
      inputTokens: 145000,
      check: { compiled: true, verified: false, diagnosticCount: 2 },
    });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("private");
    expect(serialized).toContain("max_output_tokens");
    expect(serialized).toContain("145000");
    expect(serialized).toContain('"verified":false');
  });

  it("retains correlated INFO failures and enables safe DEBUG metadata independently", async () => {
    const records: Diagnostic[] = [];
    const repo = {
      appendDiagnostic: async (record: Diagnostic) => {
        records.push(record);
      },
    } as unknown as Repository;
    const diagnostics = new Diagnostics(repo);
    const context = { appId: "app", correlationId: "request" };
    await diagnostics.record(
      "coding.check",
      { compiled: true, verified: false },
      context,
    );
    await diagnostics.record(
      "coding.stage",
      { durationMs: 21 },
      context,
      "DEBUG",
    );
    expect(records).toHaveLength(1);
    diagnostics.debug = true;
    await diagnostics.record(
      "coding.stage",
      { durationMs: 21, prompt: "private" },
      context,
      "DEBUG",
    );
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      level: "DEBUG",
      correlationId: "request",
      data: { durationMs: 21, prompt: "[redacted]" },
    });
    expect(
      records.every((record) => record.sessionId === diagnostics.sessionId),
    ).toBe(true);
  });
});
