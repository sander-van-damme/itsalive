import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Repository } from "../src/storage/repository";
import {
  exportBackup,
  inspectBackup,
  restoreBackup,
  type OpenBackupOrigin,
} from "../src/storage/backup";
import { digest as dependencyDigest } from "../src/compiler/cache";
import { encodeGraph } from "../src/storage/codec";
import type { OriginSnapshot } from "../src/runtime/origin-storage";
const appId = "39bca62c-8c5d-4f4f-9b7f-181555ef7b1c";
async function source(): Promise<Repository> {
  const repo = new Repository(`backup-${crypto.randomUUID()}`);
  await repo.saveRevision({
    id: "v1",
    appId,
    parent: null,
    createdAt: 1,
    message: "Initial",
    project: {
      files: { "App.tsx": "export default () => null" },
      entry: "App.tsx",
      dependencies: {},
      lock: {},
    },
  });
  await repo.saveApp({
    id: appId,
    name: "Backup test",
    currentRevision: "v1",
    createdAt: 1,
    state: { count: 8 },
  });
  return repo;
}
const snapshot = (): OriginSnapshot => ({
  version: 2,
  origin: `https://${appId}.itsalive.org`,
  capturedAt: 1,
  localStorage: [["item", "data"]],
  databases: [],
  caches: [],
  opfs: [],
  reports: [
    { storage: "localStorage", status: "captured", detail: "one entry" },
    { storage: "cookies", status: "skipped", detail: "attributes unavailable" },
  ],
});
describe("shell-owned portable archives", () => {
  it("restores origin data before shell records in a clean repository and closes frames", async () => {
    const repo = await source();
    const events: string[] = [];
    const open: OpenBackupOrigin = async (id) => ({
      request: async <T>(method: string, payload?: unknown): Promise<T> => {
        events.push(`${id}:${method}`);
        if (method === "restore") {
          expect(payload).toEqual(snapshot());
          return [
            { storage: "localStorage", status: "restored", detail: "done" },
          ] as T;
        }
        return snapshot() as T;
      },
      close: () => events.push("close"),
    });
    const archive = await exportBackup(repo, open);
    const clean = new Repository(`clean-${crypto.randomUUID()}`);
    const result = await restoreBackup(archive, clean, open);
    expect(result.manifest.shell.apps[0]?.state).toEqual({ count: 8 });
    expect(await clean.listApps()).toHaveLength(1);
    expect(events).toEqual([
      `${appId}:backup`,
      "close",
      `${appId}:restore`,
      "close",
    ]);
    await repo.close();
    await clean.close();
  });
  it("validates integrity and every origin before opening any destination", async () => {
    const repo = await source();
    const open = vi.fn(async () => ({
      request: async <T>() => snapshot() as T,
      close: vi.fn(),
    }));
    const archive = await exportBackup(repo, open);
    const raw = JSON.parse(await archive.text());
    raw.payload = raw.payload.replace("Backup test", "Tampered");
    open.mockClear();
    await expect(
      restoreBackup(new Blob([JSON.stringify(raw)]), repo, open),
    ).rejects.toThrow("SHA-256");
    expect(open).not.toHaveBeenCalled();
    await expect(inspectBackup(archive, { maxBytes: 4 })).rejects.toThrow(
      "limit",
    );
    await repo.close();
  });
  it("reports capture failures and cancellation without claiming complete storage", async () => {
    const repo = await source();
    const failed = await exportBackup(repo, async () => {
      throw new Error("controlled by service worker");
    });
    const manifest = await inspectBackup(failed);
    expect(manifest.origins[0]?.snapshot).toBeNull();
    expect(manifest.origins[0]?.error).toContain("service worker");
    const controller = new AbortController();
    controller.abort();
    const open = vi.fn();
    await expect(
      exportBackup(repo, open, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    await repo.close();
  });
  it("carries locked dependency bytes and restores their cache without network requests", async () => {
    const repo = await source();
    const bytes = new TextEncoder().encode(
      'export const format = () => "cached";',
    );
    const url = "https://esm.sh/example@1.0.0/es2022/example.mjs";
    const integrity = await dependencyDigest(bytes);
    const first = (await repo.getRevision("v1"))!;
    await repo.commitRevision(appId, "v1", {
      ...first,
      id: "v2",
      parent: "v1",
      project: { ...first.project, lock: { [url]: { url, integrity } } },
    });
    const data = new Map<string, Response>([[url, new Response(bytes)]]);
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (url: string) => data.get(url)?.clone(),
        put: async (url: string, response: Response) => {
          data.set(url, response);
        },
      }),
    });
    try {
      const session = async () => ({
        request: async <T>(method: string) =>
          (method === "backup" ? snapshot() : []) as T,
        close() {},
      });
      const archive = await exportBackup(repo, session);
      const manifest = await inspectBackup(archive);
      expect(manifest.dependencies[0]?.integrity).toBe(integrity);
      data.clear();
      const clean = new Repository(`cache-${crypto.randomUUID()}`);
      await restoreBackup(archive, clean, session);
      expect(await data.get(url)?.text()).toBe(new TextDecoder().decode(bytes));
      await clean.close();
    } finally {
      vi.unstubAllGlobals();
      await repo.close();
    }
  });
  it("sends cancellation to an in-flight origin request and closes its frame", async () => {
    const repo = await source();
    const controller = new AbortController();
    const events: string[] = [];
    const operation = exportBackup(
      repo,
      async () => ({
        request: async <T>(method: string): Promise<T> => {
          events.push(method);
          if (method === "backup") {
            setTimeout(() => controller.abort(), 5);
            return new Promise<T>(() => undefined);
          }
          return null as T;
        },
        close: () => events.push("closed"),
      }),
      { signal: controller.signal },
    );
    await expect(operation).rejects.toThrow();
    expect(events).toEqual(["backup", "cancel", "closed"]);
    await repo.close();
  });
  it("does not publish restored shell state after origin failure", async () => {
    const repo = await source();
    const archive = await exportBackup(repo, async () => ({
      request: async <T>() => snapshot() as T,
      close() {},
    }));
    const clean = new Repository(`failed-${crypto.randomUUID()}`);
    await expect(
      restoreBackup(archive, clean, async () => ({
        request: async <T>() =>
          [
            {
              storage: "indexedDB",
              status: "failed",
              detail: "blocked by another tab",
            },
          ] as T,
        close() {},
      })),
    ).rejects.toThrow("Shell records were not changed");
    expect(await clean.listApps()).toEqual([]);
    await repo.close();
    await clean.close();
  });
  it("rejects path traversal in a correctly hashed OPFS archive before changing storage", async () => {
    const repo = await source();
    const origin = snapshot();
    origin.opfs = [
      { path: ["..", "escape"], body: await encodeGraph(new Blob(["evil"])) },
    ];
    const open = async () => ({
      request: async <T>() => origin as T,
      close() {},
    });
    const archive = await exportBackup(repo, open);
    const manifest = await inspectBackup(archive);
    expect(manifest.origins[0]?.error).toContain("Invalid OPFS");
    await repo.close();
  });
});
