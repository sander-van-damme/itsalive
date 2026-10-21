import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeGraph } from "../src/storage/codec";
import {
  restoreOriginStorage,
  type OriginSnapshot,
} from "../src/runtime/origin-storage";

async function open(name: string, version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("records", { keyPath: "id" });
      store.createIndex("name", "name", { unique: true });
      store.put({ id: 1, name: "existing" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function read(db: IDBDatabase): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction("records").objectStore("records").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function snapshot(
  name: string,
  records: { key: number; value: { id: number; name: string } }[],
  version = 1,
): Promise<OriginSnapshot> {
  return {
    version: 2,
    origin: "http://example.localhost",
    capturedAt: 1,
    localStorage: null,
    caches: [],
    opfs: [],
    reports: [],
    databases: [
      {
        name,
        version,
        stores: [
          {
            name: "records",
            keyPath: "id",
            autoIncrement: false,
            indexes: [
              {
                name: "name",
                keyPath: "name",
                unique: true,
                multiEntry: false,
              },
            ],
            records: await encodeGraph(records),
          },
        ],
      },
    ],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("native IndexedDB restore transactions", () => {
  it("retains existing records when imported unique-index values conflict", async () => {
    vi.stubGlobal("navigator", {});
    const name = `atomic-${crypto.randomUUID()}`;
    const database = await open(name);
    database.close();
    const source = await snapshot(name, [
      { key: 2, value: { id: 2, name: "duplicate" } },
      { key: 3, value: { id: 3, name: "duplicate" } },
    ]);
    const result = await restoreOriginStorage(source);
    expect(
      result.find((row) => row.storage === `indexedDB:${name}`)?.status,
    ).toBe("failed");
    const restored = await open(name);
    expect(await read(restored)).toEqual([{ id: 1, name: "existing" }]);
    restored.close();
  });
  it("replaces the same schema and data atomically", async () => {
    vi.stubGlobal("navigator", {});
    const name = `replace-${crypto.randomUUID()}`;
    const database = await open(name);
    database.close();
    const result = await restoreOriginStorage(
      await snapshot(name, [{ key: 2, value: { id: 2, name: "restored" } }]),
    );
    expect(
      result.find((row) => row.storage === `indexedDB:${name}`)?.status,
    ).toBe("restored");
    const restored = await open(name);
    expect(await read(restored)).toEqual([{ id: 2, name: "restored" }]);
    restored.close();
  });
  it("cancels a blocked upgrade without a delayed destructive operation", async () => {
    vi.stubGlobal("navigator", {});
    const name = `cancel-${crypto.randomUUID()}`;
    const heldConnection = await open(name);
    const controller = new AbortController();
    const operation = restoreOriginStorage(
      await snapshot(name, [{ key: 9, value: { id: 9, name: "new" } }], 2),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(operation).rejects.toThrow();
    heldConnection.close();
    const after = await open(name);
    expect(after.version).toBe(1);
    expect(await read(after)).toEqual([{ id: 1, name: "existing" }]);
    after.close();
  });
  it("refuses newer destination versions without changing their contents", async () => {
    vi.stubGlobal("navigator", {});
    const name = `newer-${crypto.randomUUID()}`;
    const database = await open(name, 2);
    database.close();
    const result = await restoreOriginStorage(await snapshot(name, []));
    expect(result.find((row) => row.status === "failed")?.detail).toContain(
      "newer",
    );
    const after = await open(name, 2);
    expect(await read(after)).toEqual([{ id: 1, name: "existing" }]);
    after.close();
  });
});
