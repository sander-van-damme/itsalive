import type { AppRecord, Credential, HistoryEntry, LogEntry, ModelConfig, ScheduleRecord } from "./types";

const DB_NAME = "itsalive-shell";
const DB_VERSION = 2;

type LegacyApp = Omit<AppRecord, "id"> & { slug: string };
type LegacyAssociated = Record<string, unknown> & { appSlug?: string; appId?: string; id?: IDBValidKey };

export function migrateLegacyRecords(apps: LegacyApp[], associated: LegacyAssociated[][]): { apps: AppRecord[]; associated: LegacyAssociated[][] } {
  const ids = new Map(apps.map(app => [app.slug, crypto.randomUUID()]));
  return {
    apps: apps.map(({ slug, ...app }) => ({ ...app, id: ids.get(slug)! })),
    associated: associated.map(rows => rows.map(row => {
      const legacy = row.appSlug ?? row.appId;
      const appId = legacy && ids.get(legacy);
      const rest = { ...row };
      delete rest.appSlug;
      if (!appId) return rest;
      const migrated = { ...rest, appId };
      if (typeof migrated.id === "string" && migrated.id.startsWith(`${legacy}:`)) migrated.id = `${appId}:${migrated.id.slice(legacy!.length + 1)}`;
      return migrated;
    })),
  };
}

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
      open.onupgradeneeded = event => {
        const db = open.result;
        if (event.oldVersion === 1) {
          const names = ["apps", "history", "logs", "schedules"] as const;
          const reads = names.map(name => open.transaction!.objectStore(name).getAll());
          let complete = 0;
          for (const read of reads) read.onsuccess = () => {
            if (++complete !== reads.length) return;
            const migrated = migrateLegacyRecords(reads[0]!.result as LegacyApp[], [reads[1]!.result, reads[2]!.result, reads[3]!.result]);
            for (const name of names) db.deleteObjectStore(name);
            const appStore = db.createObjectStore("apps", { keyPath: "id" });
            const historyStore = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
            historyStore.createIndex("appTimestamp", ["appId", "timestamp"]); historyStore.createIndex("appId", "appId");
            const logsStore = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
            logsStore.createIndex("timestamp", "timestamp"); logsStore.createIndex("appId", "appId");
            const schedulesStore = db.createObjectStore("schedules", { keyPath: "id" }); schedulesStore.createIndex("appId", "appId");
            migrated.apps.forEach(row => appStore.put(row));
            migrated.associated[0]!.forEach(row => historyStore.put(row));
            migrated.associated[1]!.forEach(row => logsStore.put(row));
            migrated.associated[2]!.forEach(row => schedulesStore.put(row));
          };
          return;
        }
        if (!db.objectStoreNames.contains("apps")) db.createObjectStore("apps", { keyPath: "id" });
        if (!db.objectStoreNames.contains("credentials")) db.createObjectStore("credentials", { keyPath: "id" });
        if (!db.objectStoreNames.contains("models")) db.createObjectStore("models", { keyPath: "id" });
        if (!db.objectStoreNames.contains("schedules")) {
          const store = db.createObjectStore("schedules", { keyPath: "id" });
          store.createIndex("appId", "appId");
        }
        if (!db.objectStoreNames.contains("history")) {
          const store = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
          store.createIndex("appTimestamp", ["appId", "timestamp"]);
          store.createIndex("appId", "appId");
        }
        if (!db.objectStoreNames.contains("logs")) {
          const store = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp");
          store.createIndex("appId", "appId");
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
    get: (id: string) => this.get<AppRecord>("apps", id),
    put: (app: AppRecord) => this.put("apps", app),
    delete: (id: string) => this.delete("apps", id),
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
    forApp: (id: string) => this.byIndex<HistoryEntry>("history", "appId", id),
  };
  logs = {
    add: async (entry: LogEntry) => Number(await this.put("logs", entry)),
    all: () => this.all<LogEntry>("logs"),
    forApp: (id: string) => this.byIndex<LogEntry>("logs", "appId", id),
  };
  schedules = {
    list: () => this.all<ScheduleRecord>("schedules"),
    forApp: (id: string) => this.byIndex<ScheduleRecord>("schedules", "appId", id),
    put: (item: ScheduleRecord) => this.put("schedules", item),
    delete: (id: string) => this.delete("schedules", id),
  };
}
