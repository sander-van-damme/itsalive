import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { Repository, validateShellSnapshot } from "../src/storage/repository";
import { encodeGraph, decodeGraph } from "../src/storage/codec";
import type { AppRecord, Revision } from "../src/shared/types";
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
