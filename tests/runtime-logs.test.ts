import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ShellDatabase } from "../src/shell/core/database";
import { MAX_RUNTIME_LOG_QUERY, queryRuntimeLogs } from "../src/shell/core/runtime-logs";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ID = "650e8400-e29b-41d4-a716-446655440000";

describe("shell-owned runtime log history", () => {
  it("returns only app-runtime diagnostic sources for the requested app", async () => {
    const name = `logs-${crypto.randomUUID()}`;
    const db = new ShellDatabase(name);
    await db.logs.add({ appId: APP_ID, timestamp: 1, level: "info", source: "app", message: "console output" });
    await db.logs.add({ appId: APP_ID, timestamp: 2, level: "error", source: "agent", message: "execution failed", details: { stack: "x" } });
    await db.logs.add({ appId: APP_ID, timestamp: 3, level: "warn", source: "cron", message: "cron failed" });
    await db.logs.add({ appId: APP_ID, timestamp: 4, level: "info", source: "jev", message: "internal decision" });
    await db.logs.add({ appId: APP_ID, timestamp: 5, level: "debug", source: "console", message: "shell console" });
    await db.logs.add({ appId: OTHER_ID, timestamp: 6, level: "error", source: "app", message: "other app" });

    const reloaded = new ShellDatabase(name);
    const result = await queryRuntimeLogs(reloaded, APP_ID);

    expect(result.map(row => row.message)).toEqual(["console output", "execution failed", "cron failed"]);
    expect(result[1]).toEqual({
      timestamp: 2,
      level: "error",
      source: "agent",
      message: "execution failed",
      details: { stack: "x" },
    });
    expect(result.some(row => row.message === "internal decision")).toBe(false);
    expect(result.some(row => row.message === "other app")).toBe(false);
  });

  it("filters levels and returns the newest bounded records in chronological order", async () => {
    const db = new ShellDatabase(`logs-${crypto.randomUUID()}`);
    for (let index = 0; index < 5; index++) {
      await db.logs.add({
        appId: APP_ID,
        timestamp: index + 1,
        level: index % 2 ? "error" : "info",
        source: "app",
        message: `entry-${index + 1}`,
      });
    }

    expect((await queryRuntimeLogs(db, APP_ID, { limit: 2 })).map(row => row.message)).toEqual(["entry-4", "entry-5"]);
    expect((await queryRuntimeLogs(db, APP_ID, { level: "error", limit: 10 })).map(row => row.message)).toEqual(["entry-2", "entry-4"]);
    expect(MAX_RUNTIME_LOG_QUERY).toBe(200);
  });
});
