const DB_NAME = "itsalive-app-v2";
const DB_VERSION = 1;
export const STORES = { document: "document", tools: "tools" } as const;
export type AppStore = typeof STORES[keyof typeof STORES];

let database: Promise<IDBDatabase> | undefined;

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openAppDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, DB_VERSION);
    opening.onupgradeneeded = () => {
      for (const name of Object.values(STORES)) opening.result.createObjectStore(name);
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("Unable to open app database"));
    opening.onblocked = () => reject(new Error("App database open is blocked by another tab"));
  });
  return database;
}

export async function dbGet<T>(store: AppStore, key: IDBValidKey): Promise<T | undefined> {
  const db = await openAppDatabase();
  return request(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function dbSet<T>(store: AppStore, key: IDBValidKey, value: T): Promise<T> {
  const db = await openAppDatabase();
  const tx = db.transaction(store, "readwrite");
  const completed = transactionDone(tx);
  tx.objectStore(store).put(value, key);
  await completed;
  return value;
}

export async function dbDelete(store: AppStore, key: IDBValidKey): Promise<void> {
  const db = await openAppDatabase();
  const tx = db.transaction(store, "readwrite");
  const completed = transactionDone(tx);
  tx.objectStore(store).delete(key);
  await completed;
}

export async function dbQuery<T>(store: AppStore, options: { prefix?: string; limit?: number } = {}) {
  const db = await openAppDatabase();
  const source = db.transaction(store).objectStore(store);
  const output: Array<{ key: IDBValidKey; value: T }> = [];
  const limit = Math.max(0, Math.min(options.limit ?? 100, 1000));
  await new Promise<void>((resolve, reject) => {
    const cursor = source.openCursor();
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row || output.length >= limit) return resolve();
      if (!options.prefix || String(row.key).startsWith(options.prefix)) output.push({ key: row.key, value: row.value });
      row.continue();
    };
  });
  return output;
}
