// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installAutosave,
  restoreInitialDocument,
  serializeAppDocument,
} from "../src/runtime/persistence";
import { ShellDatabase } from "../src/shell/core/database";
import { deleteApp } from "../src/shell/core/app-deletion";
import { DiagnosticLog, buildDiagnosticExport } from "../src/shell/core/diagnostic-log";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("runtime document projection", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.title = "";
    vi.restoreAllMocks();
  });

  it("restores shell-provided HTML and rehydrates durable controls", async () => {
    const html = '<!doctype html><html lang="nl"><head><title>Saved app</title></head><body><main id="saved"><input value="durable"></main></body></html>';
    expect(await restoreInitialDocument(html)).toBe(true);
    expect(document.title).toBe("Saved app");
    expect(document.documentElement.lang).toBe("nl");
    expect(document.querySelector<HTMLInputElement>("#saved input")?.value).toBe("durable");
  });

  it("serializes live controls while excluding platform runtime nodes", () => {
    document.head.innerHTML = '<script data-app-runtime src="/bootstrap.js"></script><style data-app-runtime>.runtime{}</style>';
    document.body.innerHTML = '<main id="itsalive-root"><input type="checkbox"><textarea></textarea></main>';
    const input = document.querySelector<HTMLInputElement>("input")!;
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
    input.checked = true;
    textarea.value = "live value";

    const html = serializeAppDocument();

    expect(html).toContain('checked=""');
    expect(html).toContain("live value");
    expect(html).not.toContain("bootstrap.js");
    expect(html).not.toContain(".runtime");
  });

  it("serializes writes and removes every installed autosave listener", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let calls = 0;
    const writer = vi.fn(async () => {
      calls++;
      order.push(`start-${calls}`);
      if (calls === 1) await first;
      order.push(`end-${calls}`);
    });

    document.body.innerHTML = '<main id="itsalive-root">one</main>';
    const autosave = installAutosave(writer);
    const firstSave = autosave.save();
    document.querySelector("main")!.textContent = "two";
    const secondSave = autosave.save();

    await Promise.resolve();
    expect(order).toEqual(["start-1"]);
    releaseFirst();
    await Promise.all([firstSave, secondSave]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);

    const listeners = added.mock.calls.filter(([type]) => ["input", "change", "pagehide"].includes(String(type)));
    autosave.disconnect();
    expect(listeners).toHaveLength(3);
    for (const [type, listener] of listeners) {
      expect(removed.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true);
    }
  });
});

describe("shell persistence", () => {
  it("owns apps, documents, history, logs, and schedules", async () => {
    const db = new ShellDatabase(`shell-${crypto.randomUUID()}`);
    const connection = await db.open();
    expect([...connection.objectStoreNames]).toEqual(["apps", "documents", "history", "logs", "schedules"]);
    expect([...connection.transaction("history").objectStore("history").indexNames]).toEqual(["appId"]);
    expect([...connection.transaction("logs").objectStore("logs").indexNames]).toEqual(["appId"]);

    await db.apps.put({ id: APP_ID, name: "Test", prompt: "Build", createdAt: 1, updatedAt: 1 });
    await db.documents.put({ appId: APP_ID, html: "<main>saved</main>", updatedAt: 2 });
    await db.history.add({ appId: APP_ID, timestamp: 3, role: "user", kind: "chat", content: "hello" });
    await db.logs.add({ appId: APP_ID, timestamp: 4, level: "info", source: "test", message: "saved" });
    await db.schedules.put({ id: `${APP_ID}:daily`, appId: APP_ID, expression: "0 8 * * *", registeredAt: 5, nextRun: 6 });

    expect(await db.apps.get(APP_ID)).toMatchObject({ name: "Test" });
    expect(await db.documents.get(APP_ID)).toMatchObject({ html: "<main>saved</main>" });
    expect(await db.history.forApp(APP_ID)).toHaveLength(1);
    expect(await db.logs.forApp(APP_ID)).toHaveLength(1);
    expect(await db.schedules.forApp(APP_ID)).toHaveLength(1);
  });

  it("keeps the saved document across shell wrapper reloads", async () => {
    const databaseName = `shell-${crypto.randomUUID()}`;
    const firstShell = new ShellDatabase(databaseName);
    await firstShell.documents.put({ appId: APP_ID, html: "<main>durable</main>", updatedAt: 10 });

    const reloadedShell = new ShellDatabase(databaseName);
    expect(await reloadedShell.documents.get(APP_ID)).toEqual({
      appId: APP_ID,
      html: "<main>durable</main>",
      updatedAt: 10,
    });
  });

  it("deletes product data including the document while retaining diagnostics", async () => {
    const db = new ShellDatabase(`shell-${crypto.randomUUID()}`);
    const otherId = "650e8400-e29b-41d4-a716-446655440000";
    for (const id of [APP_ID, otherId]) {
      await db.apps.put({ id, name: id, prompt: "Build", createdAt: 1, updatedAt: 1 });
      await db.documents.put({ appId: id, html: `<main>${id}</main>`, updatedAt: 2 });
      await db.history.add({ appId: id, timestamp: 3, role: "user", kind: "chat", content: id });
      await db.logs.add({ appId: id, timestamp: 4, level: "info", source: "test", message: id });
      await db.schedules.put({ id: `${id}:daily`, appId: id, expression: "0 8 * * *", registeredAt: 5 });
    }

    await db.apps.delete(APP_ID);

    expect(await db.apps.get(APP_ID)).toBeUndefined();
    expect(await db.documents.get(APP_ID)).toBeUndefined();
    expect(await db.history.forApp(APP_ID)).toEqual([]);
    expect(await db.logs.forApp(APP_ID)).toHaveLength(1);
    expect(await db.schedules.forApp(APP_ID)).toEqual([]);
    expect(await db.apps.get(otherId)).toBeDefined();
    expect(await db.documents.get(otherId)).toBeDefined();
  });

  it("keeps recorded diagnostics readable after shell reload and app deletion", async () => {
    const databaseName = `shell-${crypto.randomUUID()}`;
    const firstShell = new ShellDatabase(databaseName);
    await firstShell.apps.put({ id: APP_ID, name: "Test", prompt: "Build", createdAt: 1, updatedAt: 1 });
    await firstShell.documents.put({ appId: APP_ID, html: "<main>app</main>", updatedAt: 2 });
    await firstShell.history.add({ appId: APP_ID, timestamp: 3, role: "user", kind: "chat", content: "build something" });

    const diagnostics = new DiagnosticLog(firstShell, () => APP_ID);
    await diagnostics.write("info", "logging", "Diagnostic storage self-check", { probe: "roundtrip" }, APP_ID);
    await diagnostics.flush();

    const reloadedShell = new ShellDatabase(databaseName);
    expect(await reloadedShell.logs.forApp(APP_ID)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "logging", message: "Diagnostic storage self-check" }),
    ]));

    await reloadedShell.apps.delete(APP_ID);
    expect(await reloadedShell.apps.get(APP_ID)).toBeUndefined();
    expect(await reloadedShell.documents.get(APP_ID)).toBeUndefined();

    const exported = buildDiagnosticExport(await reloadedShell.logs.all(), await reloadedShell.history.all());
    expect(exported).toContain("Diagnostic storage self-check");
    expect(exported).toContain("roundtrip");
  });

  it("deletes shell state before best-effort origin cleanup and continues on cleanup failure", async () => {
    const db = new ShellDatabase(`shell-${crypto.randomUUID()}`);
    await db.apps.put({ id: APP_ID, name: "Test", prompt: "Build", createdAt: 1, updatedAt: 1 });
    await db.documents.put({ appId: APP_ID, html: "<main>app</main>", updatedAt: 2 });
    const report = vi.fn();
    const clear = vi.fn(async () => {
      expect(await db.apps.get(APP_ID)).toBeUndefined();
      expect(await db.documents.get(APP_ID)).toBeUndefined();
      throw new Error("blocked");
    });

    await deleteApp(db, APP_ID, clear, report);

    expect(clear).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(await db.apps.get(APP_ID)).toBeUndefined();
  });
});
