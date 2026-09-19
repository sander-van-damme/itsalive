import type { AppDocumentRecord, AppRecord, HistoryEntry, LogEntry, ScheduleRecord } from "./types";

const DB_NAME = "itsalive-shell-v4";
const DB_VERSION = 1;

type Store = "apps" | "documents" | "history" | "logs" | "schedules";

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
        db.createObjectStore("apps", { keyPath: "id" });
        db.createObjectStore("documents", { keyPath: "appId" });
        const history = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        history.createIndex("appId", "appId");
        const logs = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        logs.createIndex("appId", "appId");
        const schedules = db.createObjectStore("schedules", { keyPath: "id" });
        schedules.createIndex("appId", "appId");
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
    const completed = transactionDone(tx);
    const key = await request(tx.objectStore(store).put(value));
    await completed;
    return key;
  }

  async delete(store: Store, key: IDBValidKey): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(store, "readwrite");
    const completed = transactionDone(tx);
    tx.objectStore(store).delete(key);
    await completed;
  }

  async all<T>(store: Store): Promise<T[]> {
    const db = await this.open();
    return request(db.transaction(store).objectStore(store).getAll());
  }

  async byIndex<T>(store: Store, index: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const db = await this.open();
    return request(db.transaction(store).objectStore(store).index(index).getAll(query));
  }

  async deleteApp(id: string): Promise<void> {
    const db = await this.open();
    // Diagnostics intentionally outlive app deletion so a just-failed test can
    // still be exported after the user removes the app itself.
    const tx = db.transaction(["apps", "documents", "history", "schedules"], "readwrite");
    const completed = transactionDone(tx);
    tx.objectStore("apps").delete(id);
    tx.objectStore("documents").delete(id);
    for (const store of ["history", "schedules"] as const) {
      const cursor = tx.objectStore(store).index("appId").openKeyCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row) { tx.objectStore(store).delete(row.primaryKey); row.continue(); }
      };
    }
    await completed;
  }

  apps = {
    list: () => this.all<AppRecord>("apps"),
    get: (id: string) => this.get<AppRecord>("apps", id),
    put: (app: AppRecord) => this.put("apps", app),
    delete: (id: string) => this.deleteApp(id),
  };
  documents = {
    get: (appId: string) => this.get<AppDocumentRecord>("documents", appId),
    put: (document: AppDocumentRecord) => this.put("documents", document),
    delete: (appId: string) => this.delete("documents", appId),
  };
  history = {
    add: async (entry: HistoryEntry) => Number(await this.put("history", entry)),
    all: () => this.all<HistoryEntry>("history"),
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
