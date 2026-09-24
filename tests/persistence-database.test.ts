// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { installAutosave, restoreAppDocument, serializeAppDocument } from "../src/runtime/persistence";
import { APP_CLEANUP_HEADER, clearAppOrigin, deleteApp } from "../src/shell/core/app-deletion";
import { ShellDatabase } from "../src/shell/core/database";
import { DiagnosticLog, buildDiagnosticExport } from "../src/shell/core/diagnostic-log";

const APP_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("runtime document persistence client", () => {
  it("separates app setup from markup and hydrates Alpine only after setup is restored", async () => {
    document.documentElement.lang = "en";
    document.head.innerHTML = '<title>Saved app</title><script data-app-runtime src="/bootstrap.js"></script><script data-app-setup>window.__restoredSetup = true;</script>';
    document.body.innerHTML = '<main id="itsalive-root" x-data="restoredApp()"><input value="old"><textarea>old</textarea></main>';
    const input = document.querySelector("input")!;
    const textarea = document.querySelector("textarea")!;
    input.value = "current";
    textarea.value = "current text";

    const snapshot = serializeAppDocument();
    expect(snapshot.html).toContain('value="current"');
    expect(snapshot.html).toContain("current text");
    expect(snapshot.html).not.toContain("bootstrap.js");
    expect(snapshot.html).not.toContain("data-app-setup");
    expect(snapshot.scripts).toEqual([
      expect.objectContaining({ placement: "head", attributes: expect.objectContaining({ "data-app-setup": "" }), content: "window.__restoredSetup = true;" }),
    ]);

    delete (window as unknown as Record<string, unknown>).__restoredSetup;
    document.title = "Changed";
    document.body.replaceChildren();
    const order: string[] = [];
    const target = window as unknown as Record<string, unknown>;
    target.Alpine = {
      stopObservingMutations: () => order.push("paused"),
      startObservingMutations: () => order.push("resumed"),
      initTree: () => order.push(`hydrated:${String(Boolean(document.querySelector("script[data-app-setup]")))}`),
    };

    await restoreAppDocument(snapshot);

    expect(document.title).toBe("Saved app");
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("current");
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("current text");
    expect(order).toEqual(["paused", "hydrated:true", "resumed"]);
    expect(document.querySelector("script[data-app-setup]")).not.toBeNull();
    document.querySelector("script[data-app-setup]")?.remove();
    delete target.Alpine;
    delete target.__restoredSetup;
  });

  it("debounces document snapshots through the supplied shell persistence callback", async () => {
    document.body.innerHTML = '<main id="itsalive-root">Initial</main>';
    const persist = vi.fn();
    const autosave = installAutosave(persist, 1);

    document.getElementById("itsalive-root")!.textContent = "Updated";
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(persist).toHaveBeenCalled();
    expect(persist.mock.calls.at(-1)?.[0]).toMatchObject({ html: expect.stringContaining("Updated"), scripts: [] });

    autosave.disconnect();
  });

  it("removes every installed autosave listener when disconnected", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const autosave = installAutosave(() => undefined);
    const listeners = added.mock.calls.filter(([type]) => ["input", "change", "pagehide"].includes(type as string));

    autosave.disconnect();

    expect(listeners).toHaveLength(3);
    for (const [type, listener] of listeners) {
      expect(removed.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true);
    }
    added.mockRestore();
    removed.mockRestore();
  });
});

describe("shell persistence", () => {
  it("persists apps, documents, history, logs, and schedules in the root database", async () => {
    const databaseName = `shell-${crypto.randomUUID()}`;
    const db = new ShellDatabase(databaseName);
    const connection = await db.open();
    expect([...connection.objectStoreNames]).toEqual(["apps", "behaviorEpisodes", "documents", "history", "logs", "schedules"]);
    expect([...connection.transaction("behaviorEpisodes").objectStore("behaviorEpisodes").indexNames]).toEqual(["appId"]);
    expect([...connection.transaction("history").objectStore("history").indexNames]).toEqual(["appId"]);
    expect([...connection.transaction("logs").objectStore("logs").indexNames]).toEqual(["appId"]);

    await db.apps.put({
      id: APP_ID,
      name: "Test",
      prompt: "Build",
      createdAt: 1,
      updatedAt: 1,
      behaviorSummary: "Prefers fast feedback.",
      behaviorSummaryUpdatedAt: 2,
    });
    await db.documents.put({ appId: APP_ID, html: "<!doctype html><main>saved</main>", scripts: [], updatedAt: 2 });
    await db.behaviorEpisodes.put({
      id: "episode-1",
      appId: APP_ID,
      createdAt: 2,
      lastSeenAt: 2,
      kind: "unresolved-need",
      fingerprint: "click|button|check",
      signal: "Repeated unchanged interaction.",
      interactionType: "click",
      targetTag: "button",
      actionCount: 5,
      documentChangeCount: 0,
      frustrationSignal: true,
      occurrences: 1,
      retentionProbability: 0.9,
      classificationConfidence: 0.9,
    });
    await db.history.add({ appId: APP_ID, timestamp: 3, role: "user", kind: "chat", content: "hello" });
    await db.logs.add({ appId: APP_ID, timestamp: 4, level: "info", source: "test", message: "saved" });
    await db.schedules.put({ id: `${APP_ID}:daily`, appId: APP_ID, expression: "0 8 * * *", registeredAt: 5, nextRun: 6 });

    const reloadedShell = new ShellDatabase(databaseName);
    expect(await reloadedShell.apps.get(APP_ID)).toMatchObject({
      name: "Test",
      behaviorSummary: "Prefers fast feedback.",
    });
    expect(await reloadedShell.documents.get(APP_ID)).toMatchObject({ html: "<!doctype html><main>saved</main>", scripts: [] });
    expect(await reloadedShell.behaviorEpisodes.forApp(APP_ID)).toEqual([expect.objectContaining({ id: "episode-1", kind: "unresolved-need" })]);
    expect(await reloadedShell.history.forApp(APP_ID)).toHaveLength(1);
    expect(await reloadedShell.logs.forApp(APP_ID)).toHaveLength(1);
    expect(await reloadedShell.schedules.forApp(APP_ID)).toHaveLength(1);
  });

  it("deletes the shell-owned document with app product data while retaining diagnostics", async () => {
    const db = new ShellDatabase(`shell-${crypto.randomUUID()}`);
    const otherId = "650e8400-e29b-41d4-a716-446655440000";
    for (const id of [APP_ID, otherId]) {
      await db.apps.put({ id, name: id, prompt: "Build", createdAt: 1, updatedAt: 1 });
      await db.documents.put({ appId: id, html: `<main>${id}</main>`, scripts: [], updatedAt: 2 });
      await db.behaviorEpisodes.put({
        id: `${id}:episode`,
        appId: id,
        createdAt: 2,
        lastSeenAt: 2,
        kind: "session-evidence",
        fingerprint: `click|button|${id}`,
        signal: "Selected evidence",
        interactionType: "click",
        targetTag: "button",
        actionCount: 3,
        documentChangeCount: 0,
        frustrationSignal: false,
        occurrences: 1,
        retentionProbability: 0.8,
        classificationConfidence: 0.8,
      });
      await db.history.add({ appId: id, timestamp: 3, role: "user", kind: "chat", content: id });
      await db.logs.add({ appId: id, timestamp: 4, level: "info", source: "test", message: id });
      await db.schedules.put({ id: `${id}:daily`, appId: id, expression: "0 8 * * *", registeredAt: 5 });
    }

    await db.apps.delete(APP_ID);

    expect(await db.apps.get(APP_ID)).toBeUndefined();
    expect(await db.documents.get(APP_ID)).toBeUndefined();
    expect(await db.behaviorEpisodes.forApp(APP_ID)).toEqual([]);
    expect(await db.history.forApp(APP_ID)).toEqual([]);
    expect(await db.logs.forApp(APP_ID)).toHaveLength(1);
    expect(await db.schedules.forApp(APP_ID)).toEqual([]);
    expect(await db.documents.get(otherId)).toBeDefined();
    expect(await db.behaviorEpisodes.forApp(otherId)).toHaveLength(1);
  });

  it("keeps recorded diagnostics readable after shell reload and app deletion", async () => {
    const databaseName = `shell-${crypto.randomUUID()}`;
    const firstShell = new ShellDatabase(databaseName);
    await firstShell.apps.put({ id: APP_ID, name: "Test", prompt: "Build", createdAt: 1, updatedAt: 1 });
    await firstShell.documents.put({ appId: APP_ID, html: "<main>saved</main>", scripts: [], updatedAt: 2 });
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
});

describe("app deletion cleanup", () => {
  it("forgets shell state before attempting best-effort origin cleanup", async () => {
    const db = new ShellDatabase(`shell-${crypto.randomUUID()}`);
    await db.apps.put({ id: APP_ID, name: "Test", prompt: "Build", createdAt: 1, updatedAt: 1 });
    await db.documents.put({ appId: APP_ID, html: "<main>saved</main>", scripts: [], updatedAt: 2 });

    const cleanup = vi.fn(async () => {
      expect(await db.apps.get(APP_ID)).toBeUndefined();
      expect(await db.documents.get(APP_ID)).toBeUndefined();
      throw new Error("offline");
    });
    const report = vi.fn();

    await deleteApp(db, APP_ID, cleanup, report);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(await db.apps.get(APP_ID)).toBeUndefined();
  });

  it("uses a credentialed, preflighted cleanup request without depending on an iframe", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(null, { status: 204 });
    });
    await clearAppOrigin(APP_ID, fetcher as typeof fetch, "https:");

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://${APP_ID}.itsalive.org/__clear`);
    expect(init).toMatchObject({
      method: "POST",
      mode: "cors",
      credentials: "include",
      headers: { [APP_CLEANUP_HEADER]: "1" },
    });
  });
});
