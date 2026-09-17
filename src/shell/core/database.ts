import type { AppRecord, Credential, HistoryEntry, LogEntry, ModelConfig, ScheduleRecord } from "./types";

const DB_NAME = "itsalive-shell";
const DB_VERSION = 1;

type Store = "apps" | "history" | "credentials" | "models" | "logs" | "schedules";

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

export class ShellDatabase {
  private connection?: Promise<IDBDatabase>;

  constructor(private readonly name = DB_NAME) {}

  open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    this.connection = new Promise((resolve, reject) => {
      const open = indexedDB.open(this.name, DB_VERSION);
      open.onerror = () => reject(open.error ?? new Error("Could not open shell database"));
      open.onblocked = () => reject(new Error("Shell database upgrade is blocked by another tab"));
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("apps")) db.createObjectStore("apps", { keyPath: "slug" });
        if (!db.objectStoreNames.contains("credentials")) db.createObjectStore("credentials", { keyPath: "id" });
        if (!db.objectStoreNames.contains("models")) db.createObjectStore("models", { keyPath: "id" });
        if (!db.objectStoreNames.contains("schedules")) {
          const store = db.createObjectStore("schedules", { keyPath: "id" });
          store.createIndex("appSlug", "appSlug");
        }
        if (!db.objectStoreNames.contains("history")) {
          const store = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
          store.createIndex("appTimestamp", ["appSlug", "timestamp"]);
          store.createIndex("appSlug", "appSlug");
        }
        if (!db.objectStoreNames.contains("logs")) {
          const store = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp");
          store.createIndex("appSlug", "appSlug");
        }
      };
      open.onsuccess = () => {
        open.result.onversionchange = () => open.result.close();
        resolve(open.result);
      };
    });
    return this.connection;
  }

  async get<T>(store: Store, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.open();
    return request(db.transaction(store).objectStore(store).get(key));
  }

  async put<T>(store: Store, value: T): Promise<IDBValidKey> {
    const db = await this.open();
    const tx = db.transaction(store, "readwrite");
    const key = await request(tx.objectStore(store).put(value));
    await transactionDone(tx);
    return key;
  }

  async delete(store: Store, key: IDBValidKey): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    await transactionDone(tx);
  }

  async all<T>(store: Store): Promise<T[]> {
    const db = await this.open();
    return request(db.transaction(store).objectStore(store).getAll());
  }

  async byIndex<T>(store: Store, index: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const db = await this.open();
    return request(db.transaction(store).objectStore(store).index(index).getAll(query));
  }

  apps = {
    list: () => this.all<AppRecord>("apps"),
    get: (slug: string) => this.get<AppRecord>("apps", slug),
    put: (app: AppRecord) => this.put("apps", app),
    delete: (slug: string) => this.delete("apps", slug),
  };
  credentials = {
    list: () => this.all<Credential>("credentials"),
    get: (id: string) => this.get<Credential>("credentials", id),
    put: (item: Credential) => this.put("credentials", item),
    delete: (id: string) => this.delete("credentials", id),
  };
  models = {
    list: () => this.all<ModelConfig>("models"),
    get: (id: string) => this.get<ModelConfig>("models", id),
    put: (item: ModelConfig) => this.put("models", item),
    delete: (id: string) => this.delete("models", id),
  };
  history = {
    add: async (entry: HistoryEntry) => Number(await this.put("history", entry)),
    forApp: (slug: string) => this.byIndex<HistoryEntry>("history", "appSlug", slug),
  };
  logs = {
    add: async (entry: LogEntry) => Number(await this.put("logs", entry)),
    all: () => this.all<LogEntry>("logs"),
    forApp: (slug: string) => this.byIndex<LogEntry>("logs", "appSlug", slug),
  };
  schedules = {
    list: () => this.all<ScheduleRecord>("schedules"),
    forApp: (slug: string) => this.byIndex<ScheduleRecord>("schedules", "appSlug", slug),
    put: (item: ScheduleRecord) => this.put("schedules", item),
    delete: (id: string) => this.delete("schedules", id),
  };
}
