import { encodeGraph, decodeGraph, type EncodedGraph } from "../storage/codec";

export interface StorageReport {
  storage: string;
  status: "captured" | "restored" | "skipped" | "failed" | "warning";
  detail: string;
}
interface IndexSnapshot {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}
interface StoreSnapshot {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSnapshot[];
  records: EncodedGraph;
}
interface DatabaseSnapshot {
  name: string;
  version: number;
  stores: StoreSnapshot[];
}
interface CacheSnapshot {
  name: string;
  entries: {
    url: string;
    headers: [string, string][];
    status: number;
    statusText: string;
    responseHeaders: [string, string][];
    body: EncodedGraph;
  }[];
}
export interface OriginSnapshot {
  version: 2;
  origin: string;
  capturedAt: number;
  localStorage: [string, string][] | null;
  databases: DatabaseSnapshot[];
  caches: CacheSnapshot[];
  opfs: { path: string[]; body: EncodedGraph }[];
  reports: StorageReport[];
}
export interface OriginStorageOptions {
  signal?: AbortSignal;
}
function check(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () =>
      reject(value.error ?? new Error("IndexedDB request failed"));
  });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const operation = indexedDB.open(name);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new Error(
          `Database ${name} is blocked by another tab. Close other application tabs.`,
        ),
      );
    }, 8000);
    operation.onsuccess = () => {
      clearTimeout(timer);
      if (settled) operation.result.close();
      else {
        operation.result.onversionchange = () => operation.result.close();
        resolve(operation.result);
      }
    };
    operation.onerror = () => {
      clearTimeout(timer);
      reject(operation.error);
    };
    operation.onupgradeneeded = () => {
      operation.transaction?.abort();
      clearTimeout(timer);
      reject(new Error(`Database ${name} disappeared during backup`));
    };
  });
}
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const operation = indexedDB.deleteDatabase(name);
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Cannot replace database ${name}: another tab has an open connection`,
          ),
        ),
      8000,
    );
    operation.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    operation.onerror = () => {
      clearTimeout(timer);
      reject(operation.error);
    };
  });
}
async function requireTrustedOrigin(): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    navigator.serviceWorker.controller
  )
    throw new Error(
      "Backup/restore refused: a service worker controls this application origin. Remove the worker in browser site settings, close all app tabs, and retry so the trusted bootstrap can run.",
    );
}
async function exportDatabase(
  name: string,
  signal?: AbortSignal,
): Promise<DatabaseSnapshot> {
  const db = await openDatabase(name);
  try {
    check(signal);
    const names = [...db.objectStoreNames];
    const stores: StoreSnapshot[] = [];
    if (!names.length) return { name, version: db.version, stores };
    // All stores in one readonly transaction provide a consistent snapshot of this database.
    const tx = db.transaction(names, "readonly");
    const done = transactionDone(tx);
    const pending = names.map(async (name) => {
      const store = tx.objectStore(name);
      const indexes = [...store.indexNames].map((name) => {
        const index = store.index(name);
        return {
          name,
          keyPath: index.keyPath,
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      });
      const [keys, values] = await Promise.all([
        request(store.getAllKeys()),
        request(store.getAll()),
      ]);
      return {
        name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes,
        keys,
        values,
      };
    });
    const rows = await Promise.all(pending);
    await done;
    for (const row of rows) {
      check(signal);
      stores.push({
        name: row.name,
        keyPath: row.keyPath,
        autoIncrement: row.autoIncrement,
        indexes: row.indexes,
        records: await encodeGraph(
          row.keys.map((key, i) => ({ key, value: row.values[i] })),
        ),
      });
    }
    return { name, version: db.version, stores };
  } finally {
    db.close();
  }
}
export async function exportOriginStorage(
  options: OriginStorageOptions = {},
): Promise<OriginSnapshot> {
  const { signal } = options;
  check(signal);
  await requireTrustedOrigin();
  const snapshot: OriginSnapshot = {
    version: 2,
    origin: location.origin,
    capturedAt: Date.now(),
    localStorage: null,
    databases: [],
    caches: [],
    opfs: [],
    reports: [],
  };
  const report = (
    storage: string,
    status: StorageReport["status"],
    detail: string,
  ) => snapshot.reports.push({ storage, status, detail });
  try {
    snapshot.localStorage = Array.from(
      { length: localStorage.length },
      (_, i) => localStorage.key(i),
    )
      .filter((key): key is string => key !== null)
      .map((key) => [key, localStorage.getItem(key) ?? ""]);
    report(
      "localStorage",
      "captured",
      `${snapshot.localStorage.length} entries`,
    );
  } catch (error) {
    report("localStorage", "failed", message(error));
  }
  check(signal);
  if (typeof indexedDB.databases !== "function")
    report(
      "indexedDB",
      "skipped",
      "This browser cannot enumerate databases. No guarantee of complete origin backup.",
    );
  else
    try {
      for (const db of await indexedDB.databases())
        if (db.name) {
          check(signal);
          try {
            snapshot.databases.push(await exportDatabase(db.name, signal));
            report(
              `indexedDB:${db.name}`,
              "captured",
              "Database schemas, indexes, keys and values",
            );
          } catch (error) {
            check(signal);
            report(`indexedDB:${db.name}`, "failed", message(error));
          }
        }
    } catch (error) {
      check(signal);
      report("indexedDB", "failed", message(error));
    }
  check(signal);
  if (typeof caches === "undefined")
    report(
      "CacheStorage",
      "skipped",
      "Cache Storage unavailable in this browser/context",
    );
  else
    try {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        const entries: CacheSnapshot["entries"] = [];
        for (const req of await cache.keys()) {
          check(signal);
          const response = await cache.match(req);
          if (!response) continue;
          if (
            response.type === "opaque" ||
            response.type === "opaqueredirect" ||
            response.status === 0
          ) {
            report(
              `cache:${name}:${req.url}`,
              "skipped",
              "Opaque responses cannot be read through browser APIs",
            );
            continue;
          }
          try {
            entries.push({
              url: req.url,
              headers: [...req.headers],
              status: response.status,
              statusText: response.statusText,
              responseHeaders: [...response.headers],
              body: await encodeGraph(await response.blob()),
            });
          } catch (error) {
            report(`cache:${name}:${req.url}`, "failed", message(error));
          }
        }
        snapshot.caches.push({ name, entries });
        report(
          `cache:${name}`,
          "captured",
          `${entries.length} accessible responses`,
        );
      }
    } catch (error) {
      check(signal);
      report("CacheStorage", "failed", message(error));
    }
  check(signal);
  if (!navigator.storage?.getDirectory)
    report("OPFS", "skipped", "Origin Private File System unavailable");
  else
    try {
      const visit = async (
        directory: FileSystemDirectoryHandle,
        path: string[],
      ): Promise<void> => {
        for await (const [name, handle] of (
          directory as FileSystemDirectoryHandle & {
            entries(): AsyncIterable<[string, FileSystemHandle]>;
          }
        ).entries()) {
          check(signal);
          if (handle.kind === "directory")
            await visit(handle as FileSystemDirectoryHandle, [...path, name]);
          else
            snapshot.opfs.push({
              path: [...path, name],
              body: await encodeGraph(
                await (handle as FileSystemFileHandle).getFile(),
              ),
            });
        }
      };
      await visit(await navigator.storage.getDirectory(), []);
      report(
        "OPFS",
        "captured",
        `${snapshot.opfs.length} files (empty directories are not retained)`,
      );
    } catch (error) {
      check(signal);
      report("OPFS", "failed", message(error));
    }
  report(
    "cookies",
    "skipped",
    "Cookie values lack reliable attributes and lifetime information; HttpOnly cookies are inaccessible. Credentials and cookies are not restored.",
  );
  report(
    "sessionStorage",
    "skipped",
    "Session-only state is not durable and is intentionally excluded.",
  );
  report(
    "browser-managed",
    "skipped",
    "Permissions, credentials, service-worker registrations, HTTP cache and protected browser state cannot be portably restored.",
  );
  report(
    "consistency",
    "warning",
    "Close other app tabs before backup. Each IndexedDB database is consistent, but browser APIs cannot atomically snapshot all storage types or prevent concurrent writes from other contexts.",
  );
  report(
    "indexedDB-key-generator",
    "warning",
    "Browser APIs cannot read an auto-increment generator after its highest keys were deleted; restoration advances from the largest surviving key.",
  );
  return snapshot;
}
export function validateOriginSnapshot(snapshot: OriginSnapshot): void {
  if (
    !snapshot ||
    snapshot.version !== 2 ||
    typeof snapshot.origin !== "string" ||
    !Array.isArray(snapshot.databases) ||
    !Array.isArray(snapshot.caches) ||
    !Array.isArray(snapshot.opfs) ||
    !Array.isArray(snapshot.reports)
  )
    throw new Error("Malformed origin backup");
  if (
    snapshot.localStorage !== null &&
    (!Array.isArray(snapshot.localStorage) ||
      snapshot.localStorage.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 2 ||
          row.some((value) => typeof value !== "string"),
      ))
  )
    throw new Error("Invalid localStorage backup");
  const names = new Set<string>();
  for (const db of snapshot.databases) {
    if (
      !db ||
      typeof db.name !== "string" ||
      names.has(db.name) ||
      !Number.isSafeInteger(db.version) ||
      db.version < 1 ||
      !Array.isArray(db.stores)
    )
      throw new Error("Invalid IndexedDB backup");
    names.add(db.name);
    const storeNames = new Set<string>();
    for (const store of db.stores) {
      if (
        typeof store.name !== "string" ||
        storeNames.has(store.name) ||
        typeof store.autoIncrement !== "boolean" ||
        !Array.isArray(store.indexes)
      )
        throw new Error("Invalid object store");
      storeNames.add(store.name);
      if (
        !(
          store.keyPath === null ||
          typeof store.keyPath === "string" ||
          (Array.isArray(store.keyPath) &&
            store.keyPath.every((key) => typeof key === "string"))
        )
      )
        throw new Error("Invalid key path");
      for (const index of store.indexes)
        if (
          typeof index.name !== "string" ||
          typeof index.unique !== "boolean" ||
          typeof index.multiEntry !== "boolean" ||
          !(
            typeof index.keyPath === "string" ||
            (Array.isArray(index.keyPath) &&
              index.keyPath.every((key) => typeof key === "string"))
          )
        )
          throw new Error("Invalid index");
      const records = decodeGraph(store.records);
      if (
        !Array.isArray(records) ||
        records.some(
          (row) =>
            !row ||
            typeof row !== "object" ||
            !("key" in row) ||
            !("value" in row),
        )
      )
        throw new Error("Invalid database records");
    }
  }
  const cacheNames = new Set<string>();
  for (const cache of snapshot.caches) {
    if (
      typeof cache.name !== "string" ||
      cacheNames.has(cache.name) ||
      !Array.isArray(cache.entries)
    )
      throw new Error("Invalid cache");
    cacheNames.add(cache.name);
    for (const entry of cache.entries) {
      const url = new URL(entry.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !Number.isInteger(entry.status) ||
        entry.status < 200 ||
        entry.status > 599 ||
        !(decodeGraph(entry.body) instanceof Blob)
      )
        throw new Error("Invalid cached response");
      new Headers(entry.headers);
      new Headers(entry.responseHeaders);
    }
  }
  const paths = new Set<string>();
  for (const file of snapshot.opfs) {
    if (
      !Array.isArray(file.path) ||
      !file.path.length ||
      file.path.some(
        (part) =>
          typeof part !== "string" ||
          !part ||
          part === "." ||
          part === ".." ||
          /[\\/\0]/.test(part),
      ) ||
      paths.has(file.path.join("/")) ||
      !(decodeGraph(file.body) instanceof Blob)
    )
      throw new Error("Invalid OPFS file");
    paths.add(file.path.join("/"));
  }
}
function populateStore(store: IDBObjectStore, source: StoreSnapshot): void {
  for (const record of decodeGraph(source.records) as {
    key: IDBValidKey;
    value: unknown;
  }[]) {
    if (source.keyPath === null) store.put(record.value, record.key);
    else store.put(record.value);
  }
}
function sameSchema(
  database: IDBDatabase,
  snapshot: DatabaseSnapshot,
): boolean {
  const names = [...database.objectStoreNames];
  if (
    names.length !== snapshot.stores.length ||
    snapshot.stores.some((store) => !names.includes(store.name))
  )
    return false;
  if (!names.length) return true;
  const transaction = database.transaction(names);
  return snapshot.stores.every((source) => {
    const store = transaction.objectStore(source.name);
    return (
      JSON.stringify(store.keyPath) === JSON.stringify(source.keyPath) &&
      store.autoIncrement === source.autoIncrement &&
      store.indexNames.length === source.indexes.length &&
      source.indexes.every((index) => {
        if (!store.indexNames.contains(index.name)) return false;
        const actual = store.index(index.name);
        return (
          JSON.stringify(actual.keyPath) === JSON.stringify(index.keyPath) &&
          actual.unique === index.unique &&
          actual.multiEntry === index.multiEntry
        );
      })
    );
  });
}
async function restoreDatabase(
  snapshot: DatabaseSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  check(signal);
  let upgraded = false;
  // Never queue an uncancellable deleteDatabase against a user origin. Upgrades
  // can be aborted even when an open connection delays the upgrade transaction.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const operation = indexedDB.open(snapshot.name, snapshot.version);
    let cancelled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      cancelled = true;
      cleanup();
      try {
        operation.transaction?.abort();
      } catch {
        /* no transaction yet */
      }
      reject(error);
    };
    const abort = () =>
      fail(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `Database ${snapshot.name} is blocked. Close other app tabs and retry.`,
          ),
        ),
      8000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    operation.onupgradeneeded = () => {
      if (cancelled || signal?.aborted) {
        operation.transaction?.abort();
        return;
      }
      upgraded = true;
      try {
        for (const name of [...operation.result.objectStoreNames])
          operation.result.deleteObjectStore(name);
        for (const source of snapshot.stores) {
          const store = operation.result.createObjectStore(source.name, {
            keyPath: source.keyPath,
            autoIncrement: source.autoIncrement,
          });
          for (const index of source.indexes)
            store.createIndex(index.name, index.keyPath, {
              unique: index.unique,
              multiEntry: index.multiEntry,
            });
          populateStore(store, source);
        }
      } catch (error) {
        fail(error);
      }
    };
    operation.onsuccess = () => {
      cleanup();
      if (cancelled) operation.result.close();
      else resolve(operation.result);
    };
    operation.onerror = () => {
      cleanup();
      reject(
        operation.error?.name === "VersionError"
          ? new Error(
              `Database ${snapshot.name} is newer than this backup. Restore into a clean profile or clear this app's site data first.`,
            )
          : operation.error,
      );
    };
  });
  try {
    check(signal);
    if (upgraded) return;
    if (!sameSchema(db, snapshot))
      throw new Error(
        `Database ${snapshot.name} has a different schema at the same version. Restore into a clean profile or clear this app's site data first.`,
      );
    if (!snapshot.stores.length) return;
    const tx = db.transaction(
      snapshot.stores.map((store) => store.name),
      "readwrite",
    );
    const done = transactionDone(tx);
    const abort = () => {
      try {
        tx.abort();
      } catch {
        /* completed */
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (const source of snapshot.stores) {
        check(signal);
        const store = tx.objectStore(source.name);
        store.clear();
        populateStore(store, source);
      }
      await done;
    } catch (error) {
      abort();
      void done.catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  } finally {
    db.close();
  }
}
export async function restoreOriginStorage(
  snapshot: OriginSnapshot,
  options: OriginStorageOptions = {},
): Promise<StorageReport[]> {
  const { signal } = options;
  check(signal);
  validateOriginSnapshot(snapshot);
  await requireTrustedOrigin();
  const reports: StorageReport[] = [];
  const perform = async (storage: string, work: () => Promise<void>) => {
    check(signal);
    try {
      await work();
      reports.push({
        storage,
        status: "restored",
        detail: "Restored successfully",
      });
    } catch (error) {
      check(signal);
      reports.push({ storage, status: "failed", detail: message(error) });
    }
  };
  if (snapshot.localStorage !== null)
    await perform("localStorage", async () => {
      localStorage.clear();
      for (const [key, value] of snapshot.localStorage!)
        localStorage.setItem(key, value);
    });
  for (const db of snapshot.databases)
    await perform(`indexedDB:${db.name}`, () => restoreDatabase(db, signal));
  for (const source of snapshot.caches)
    await perform(`cache:${source.name}`, async () => {
      await caches.delete(source.name);
      const cache = await caches.open(source.name);
      for (const entry of source.entries) {
        check(signal);
        await cache.put(
          new Request(entry.url, { headers: entry.headers }),
          new Response(
            [204, 205, 304].includes(entry.status)
              ? null
              : (decodeGraph(entry.body) as Blob),
            {
              status: entry.status,
              statusText: entry.statusText,
              headers: entry.responseHeaders,
            },
          ),
        );
      }
    });
  if (snapshot.opfs.length)
    await perform("OPFS", async () => {
      const root = await navigator.storage.getDirectory();
      for (const file of snapshot.opfs) {
        check(signal);
        let directory = root;
        for (const part of file.path.slice(0, -1))
          directory = await directory.getDirectoryHandle(part, {
            create: true,
          });
        const handle = await directory.getFileHandle(file.path.at(-1)!, {
          create: true,
        });
        const writer = await handle.createWritable();
        try {
          await writer.write(decodeGraph(file.body) as Blob);
          await writer.close();
        } catch (error) {
          await writer.abort();
          throw error;
        }
      }
    });
  reports.push({
    storage: "restore-scope",
    status: "warning",
    detail:
      "Recorded databases/caches/files were replaced; unrelated origin databases, caches and files were retained. Cookie, permission and service-worker state was not restored.",
  });
  return reports;
}
/** Best-effort disposal for throwaway verification origins only; never call on a user app. */
export async function clearOriginStorage(): Promise<StorageReport[]> {
  const reports: StorageReport[] = [];
  const clear = async (storage: string, operation: () => Promise<void>) => {
    try {
      await operation();
      reports.push({
        storage,
        status: "restored",
        detail: "Cleared disposable origin",
      });
    } catch (error) {
      reports.push({ storage, status: "failed", detail: message(error) });
    }
  };
  await clear("localStorage", async () => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await clear("indexedDB", async () => {
    if (!indexedDB.databases)
      throw new Error("Database enumeration unavailable");
    for (const database of await indexedDB.databases())
      if (database.name) await deleteDatabase(database.name);
  });
  await clear("CacheStorage", async () => {
    if (typeof caches !== "undefined")
      for (const name of await caches.keys()) await caches.delete(name);
  });
  await clear("OPFS", async () => {
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of (
        root as FileSystemDirectoryHandle & {
          entries(): AsyncIterable<[string, FileSystemHandle]>;
        }
      ).entries())
        await root.removeEntry(name, { recursive: true });
    }
  });
  await clear("serviceWorker", async () => {
    if ("serviceWorker" in navigator)
      for (const registration of await navigator.serviceWorker.getRegistrations())
        await registration.unregister();
  });
  return reports;
}
