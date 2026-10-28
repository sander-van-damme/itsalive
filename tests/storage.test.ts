import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { Repository, validateShellSnapshot } from "../src/storage/repository";
import { encodeGraph, decodeGraph } from "../src/storage/codec";
import type { AppRecord, Revision } from "../src/shared/types";
import type { UsageRecord } from "../src/ai/types";
const appId = "39bca62c-8c5d-4f4f-9b7f-181555ef7b1c";
const revision = (id: string, parent: string | null = null): Revision => ({
  id,
  appId,
  parent,
  createdAt: Date.now(),
  message: id,
  project: {
    entry: "src/App.tsx",
    files: { "src/App.tsx": "export default function App() {return null}" },
    dependencies: {},
    lock: {},
  },
});
const app = (currentRevision = "first"): AppRecord => ({
  id: appId,
  name: "Example",
  currentRevision,
  createdAt: Date.now(),
  state: { count: 4 },
});
async function repository(): Promise<Repository> {
  const repo = new Repository(`test-${crypto.randomUUID()}`);
  await repo.saveRevision(revision("first"));
  await repo.saveApp(app());
  return repo;
}
describe("transactional source repository", () => {
  it("merges concurrent tab usage and never overwrites settled charges with pending data", async () => {
    const name = `usage-${crypto.randomUUID()}`;
    const first = new Repository(name);
    const second = new Repository(name);
    const usage = (
      id: string,
      status: UsageRecord["status"],
      costUSD: number,
    ): UsageRecord => ({
      id,
      timestamp: Date.now(),
      role: "application",
      provider: "openai",
      model: "gpt-6-luna",
      appId,
      correlationId: id,
      inputTokens: status === "pending" ? 0 : 1000,
      outputTokens: status === "pending" ? 0 : 200,
      cachedTokens: 0,
      costUSD,
      costStatus: status === "pending" ? "unknown" : "estimated",
      usageStatus: status === "pending" ? "unknown" : "reported",
      estimated: true,
      latencyMs: 20,
      status,
    });
    try {
      await Promise.all([
        first.recordUsage(usage("one", "pending", 0)),
        second.recordUsage(usage("two", "pending", 0)),
      ]);
      await Promise.all([
        first.recordUsage(usage("one", "success", 0.1)),
        second.recordUsage(usage("two", "failed", 0.2)),
      ]);
      await second.recordUsage(usage("one", "pending", 0));
      const records = await first.getSetting<UsageRecord[]>("ai.usage");
      expect(records).toHaveLength(2);
      expect(records?.find((record) => record.id === "one")).toMatchObject({
        status: "success",
        costUSD: 0.1,
      });
      expect(records?.find((record) => record.id === "two")).toMatchObject({
        status: "failed",
        costUSD: 0.2,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });
  it("allows exactly one concurrent candidate and keeps immutable revisions", async () => {
    const repo = await repository();
    const result = await Promise.allSettled([
      repo.commitRevision(appId, "first", revision("second", "first")),
      repo.commitRevision(appId, "first", revision("third", "first")),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect((await repo.getApp(appId))?.currentRevision).toBe("second");
    expect(await repo.getRevision("third")).toBeUndefined();
    await expect(
      repo.saveRevision({ ...revision("first"), message: "overwrite" }),
    ).rejects.toThrow("immutable");
    expect((await repo.getRevision("first"))?.message).toBe("first");
    await repo.close();
  });
  it("round-trips source, revision history, state, conversations and safe settings atomically", async () => {
    const repo = await repository();
    await repo.commitRevision(appId, "first", revision("next", "first"));
    await repo.appendChat({
      id: "message",
      appId,
      role: "user",
      content: "Build a counter",
      createdAt: 1,
    });
    await repo.setSetting("models", {
      coding: "test/model",
      apiKey: "sk-never-export-this-secret",
    });
    await repo.appendDiagnostic({
      id: "log",
      timestamp: 1,
      level: "DEBUG",
      event: "provider",
      correlationId: "c",
      data: {
        authorization: "Bearer secret",
        text: "sk-dont-print-this-token",
      },
    });
    const exported = await repo.exportData();
    expect(JSON.stringify(exported)).not.toContain("sk-never");
    expect(JSON.stringify(exported)).not.toContain("Bearer secret");
    const clean = new Repository(`test-clean-${crypto.randomUUID()}`);
    await clean.importData(exported);
    expect(await clean.listApps()).toEqual(await repo.listApps());
    expect(await clean.listChat(appId)).toHaveLength(1);
    expect(await clean.listRevisions(appId)).toHaveLength(2);
    await expect(
      clean.importData({ ...exported, revisions: [] }),
    ).rejects.toThrow("missing current");
    expect(await clean.listRevisions(appId)).toHaveLength(2);
    await repo.close();
    await clean.close();
  });
  it("rejects malformed app identities and credential keys", async () => {
    const repo = await repository();
    await expect(repo.saveApp({ ...app(), id: "../../shell" })).rejects.toThrow(
      "Invalid application",
    );
    await expect(repo.setSetting("apiKey", "secret")).rejects.toThrow(
      "credentials separately",
    );
    const snapshot = await repo.exportData();
    snapshot.revisions[0]!.project.entry = "missing.ts";
    expect(() => validateShellSnapshot(snapshot)).toThrow("source project");
    await repo.close();
  });
  it("updates durable state without racing the revision pointer and rejects cyclic or cross-app history", async () => {
    const repo = await repository();
    await Promise.all([
      repo.commitRevision(appId, "first", revision("second", "first")),
      repo.updateState(appId, { count: 99 }),
    ]);
    expect(await repo.getApp(appId)).toMatchObject({
      currentRevision: "second",
      state: { count: 99 },
    });
    const snapshot = await repo.exportData();
    snapshot.revisions.find((row) => row.id === "first")!.parent = "second";
    expect(() => validateShellSnapshot(snapshot)).toThrow("Cyclic");
    snapshot.revisions.find((row) => row.id === "first")!.parent = null;
    snapshot.revisions.find((row) => row.id === "second")!.appId =
      "838c9402-bac2-49f4-952b-e65fe1e8ed2c";
    expect(() => validateShellSnapshot(snapshot)).toThrow(
      "different application",
    );
    await repo.close();
  });
  it("bounds diagnostics and deletes only the requested app records", async () => {
    const repo = await repository();
    for (let i = 0; i < 2005; i++)
      await repo.appendDiagnostic({
        id: String(i),
        timestamp: i,
        event: "test",
        level: "INFO",
        correlationId: "test",
      });
    expect(await repo.listDiagnostics()).toHaveLength(2000);
    expect((await repo.listDiagnostics())[0]?.timestamp).toBe(5);
    expect((await repo.diagnosticSnapshot()).retention).toMatchObject({
      droppedCount: 5,
      maxEntries: 2000,
      firstRecordedAt: 0,
      lastRecordedAt: 2004,
    });
    await repo.deleteApp(appId);
    expect(await repo.listApps()).toEqual([]);
    expect(await repo.listRevisions(appId)).toEqual([]);
    await repo.close();
  });
});
describe("portable structured-clone codec", () => {
  it("preserves cycles, shared references, maps, binary offsets, blobs and special scalar values", async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const child = { label: "shared" };
    const source: Record<string, unknown> = {
      child,
      same: child,
      number: NaN,
      infinity: Infinity,
      negativeZero: -0,
      big: 42n,
      date: new Date("2026-10-21T00:00:00Z"),
      set: new Set([1, "a"]),
      map: new Map([[child, child]]),
      view: new Uint16Array(buffer, 2, 1),
      buffer,
      blob: new Blob(["hello"], { type: "text/plain" }),
      undefined,
    };
    source.self = source;
    const restored = decodeGraph(
      JSON.parse(JSON.stringify(await encodeGraph(source))),
    ) as typeof source;
    expect(restored.self).toBe(restored);
    expect(restored.child).toBe(restored.same);
    expect(restored.number).toBeNaN();
    expect(Object.is(restored.negativeZero, -0)).toBe(true);
    expect(restored.big).toBe(42n);
    expect((restored.view as Uint16Array).buffer).toBe(restored.buffer);
    expect((restored.view as Uint16Array).byteOffset).toBe(2);
    expect((restored.map as Map<unknown, unknown>).get(restored.child)).toBe(
      restored.child,
    );
    expect(await (restored.blob as Blob).text()).toBe("hello");
  });
  it("does not mutate Object.prototype and rejects unknown graph constructors", async () => {
    const data = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"text"}',
    );
    const restored = decodeGraph(await encodeGraph(data)) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(restored, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() =>
      decodeGraph({
        root: { ref: 0 },
        nodes: [{ type: "Function", value: "alert(1)" }],
      }),
    ).toThrow();
  });
});

import type { CodingCheckpoint } from "../src/ai/checkpoint";
function checkpoint(): CodingCheckpoint {
  return {
    version: 1,
    id: crypto.randomUUID(),
    appId,
    baseRevisionId: "first",
    intent: "Build a violin trainer",
    originalRequest: "I want to learn violin scales",
    role: "coding-standard",
    correlationId: "trace",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    project: revision("draft").project,
    changedFiles: ["src/App.tsx"],
    messages: [{ role: "user", content: "Private candidate context" }],
    turns: 3,
    toolCalls: 7,
    finishRequested: false,
    summary: "",
    status: "paused",
  };
}
describe("private recoverable candidate storage", () => {
  it("persists across reload and portable backup, then atomically invalidates after commit", async () => {
    const name = `draft-${crypto.randomUUID()}`;
    let repo = new Repository(name);
    await repo.createApp(app(), revision("first"));
    const draft = checkpoint();
    await repo.saveCodingCheckpoint(draft);
    await repo.close();
    repo = new Repository(name);
    expect(await repo.getCodingCheckpoint(appId)).toEqual(draft);
    const exported = await repo.exportData();
    expect(exported.codingDrafts).toEqual([draft]);
    const restored = new Repository(`draft-restored-${crypto.randomUUID()}`);
    await restored.importData(exported);
    expect(await restored.getCodingCheckpoint(appId)).toEqual(draft);
    await restored.close();
    expect((await repo.getApp(appId))?.currentRevision).toBe("first");
    await repo.commitRevision(appId, "first", revision("complete", "first"));
    expect(await repo.getCodingCheckpoint(appId)).toBeUndefined();
    await expect(repo.saveCodingCheckpoint(draft)).rejects.toThrow(
      "earlier application version",
    );
    await repo.close();
  });

  it("keeps drafts on failed commits and clears them only for their owning app or requested session", async () => {
    const repo = await repository();
    const draft = checkpoint();
    await repo.saveCodingCheckpoint(draft);
    await expect(
      repo.commitRevision(appId, "wrong", revision("bad", "wrong")),
    ).rejects.toThrow("Stale");
    expect(await repo.getCodingCheckpoint(appId)).toEqual(draft);
    await repo.clearCodingCheckpoint(appId, "another-session");
    expect(await repo.getCodingCheckpoint(appId)).toEqual(draft);
    await repo.deleteApp(appId);
    expect(await repo.getCodingCheckpoint(appId)).toBeUndefined();
    await repo.close();
  });

  it("discards private drafts when restoring a workspace and preserves concurrent name, state and revision updates", async () => {
    const repo = await repository();
    const saved = await repo.exportData();
    await repo.saveCodingCheckpoint(checkpoint());
    await repo.importData(saved);
    expect(await repo.getCodingCheckpoint(appId)).toBeUndefined();
    await Promise.all([
      repo.renameApp(appId, "Violin Trainer"),
      repo.updateState(appId, { practiced: 4 }),
      repo.commitRevision(appId, "first", revision("next", "first")),
    ]);
    expect(await repo.getApp(appId)).toMatchObject({
      name: "Violin Trainer",
      state: { practiced: 4 },
      currentRevision: "next",
    });
    await repo.close();
  });

  it("upgrades existing databases without losing source, state or settings", async () => {
    const name = `legacy-${crypto.randomUUID()}`;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("apps", { keyPath: "id" });
        db.createObjectStore("revisions", { keyPath: "id" });
        db.createObjectStore("chat", { keyPath: "id" }).createIndex(
          "appId",
          "appId",
        );
        db.createObjectStore("diagnostics", { keyPath: "id" }).createIndex(
          "timestamp",
          "timestamp",
        );
        db.createObjectStore("settings", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction(
        ["apps", "revisions", "settings"],
        "readwrite",
      );
      tx.objectStore("apps").put(app());
      tx.objectStore("revisions").put(revision("first"));
      tx.objectStore("settings").put({ key: "debug", value: true });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();
    const repo = new Repository(name);
    expect((await repo.getApp(appId))?.state).toEqual({ count: 4 });
    expect(await repo.getSetting("debug")).toBe(true);
    await repo.saveCodingCheckpoint(checkpoint());
    expect((await repo.getCodingCheckpoint(appId))?.baseRevisionId).toBe(
      "first",
    );
    await repo.close();
  });
});
