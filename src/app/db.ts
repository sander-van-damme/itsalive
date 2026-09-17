const DB_NAME = "app";
const DB_VERSION = 2;
export const STORES = { document: "document", data: "data", tools: "tools" } as const;

let database: Promise<IDBDatabase> | undefined;

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

export function openAppDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, DB_VERSION);
    opening.onupgradeneeded = () => {
      for (const name of Object.values(STORES)) {
        if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name);
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("Unable to open app database"));
    opening.onblocked = () => reject(new Error("App database upgrade is blocked by another tab"));
  });
  return database;
}

export async function dbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openAppDatabase();
  return request(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function dbSet<T>(store: string, key: IDBValidKey, value: T): Promise<T> {
  const db = await openAppDatabase();
  await request(db.transaction(store, "readwrite").objectStore(store).put(value, key));
  return value;
}

export async function dbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openAppDatabase();
  await request(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export async function dbQuery<T>(store: string = STORES.data, options: { prefix?: string; limit?: number } = {}) {
  const db = await openAppDatabase();
  const tx = db.transaction(store);
  const source = tx.objectStore(store);
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

export const appDatabaseApi = {
  get: <T>(key: IDBValidKey) => dbGet<T>(STORES.data, key),
  set: <T>(key: IDBValidKey, value: T) => dbSet(STORES.data, key, value),
  delete: (key: IDBValidKey) => dbDelete(STORES.data, key),
  query: <T>(options?: { prefix?: string; limit?: number }) => dbQuery<T>(STORES.data, options),
};
