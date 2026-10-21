import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AppRecord,
  ChatMessage,
  Diagnostic,
  Json,
  Revision,
} from "../shared/types";

interface DatabaseSchema extends DBSchema {
  apps: { key: string; value: AppRecord };
  revisions: { key: string; value: Revision };
  chat: { key: string; value: ChatMessage; indexes: { appId: string } };
  diagnostics: {
    key: string;
    value: Diagnostic;
    indexes: { timestamp: number };
  };
  settings: { key: string; value: { key: string; value: unknown } };
}
export interface ShellSnapshot {
  version: 2;
  apps: AppRecord[];
  revisions: Revision[];
  conversations: ChatMessage[];
  diagnostics: Diagnostic[];
  settings: { key: string; value: unknown }[];
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const secretField =
  /^(?:api[-_]?key|authorization|password|token|access[-_]?token|refresh[-_]?token|credentials?|secret)$/i;
/** Defense in depth. Arbitrary generated-app state is deliberately not filtered. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[depth limit]";
  if (typeof value === "string")
    return value
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted]")
      .slice(0, 12_000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          key,
          secretField.test(key) ? "[redacted]" : redact(item, depth + 1),
        ]),
    );
  return value;
}
function validateRevision(revision: Revision): void {
  if (
    !revision ||
    !uuid.test(revision.appId) ||
    typeof revision.id !== "string" ||
    !revision.id ||
    typeof revision.message !== "string" ||
    !Number.isFinite(revision.createdAt) ||
    (revision.parent !== null && typeof revision.parent !== "string")
  )
    throw new Error("Invalid revision");
  const p = revision.project;
  if (
    !p ||
    typeof p.entry !== "string" ||
    !p.files ||
    typeof p.files !== "object" ||
    !Object.hasOwn(p.files, p.entry) ||
    Object.entries(p.files).some(
      ([name, source]) =>
        !name ||
        name.startsWith("/") ||
        name.split("/").includes("..") ||
        typeof source !== "string",
    )
  )
    throw new Error("Invalid source project");
  if (
    !p.dependencies ||
    typeof p.dependencies !== "object" ||
    Object.values(p.dependencies).some((value) => typeof value !== "string") ||
    !p.lock ||
    typeof p.lock !== "object"
  )
    throw new Error("Invalid dependency manifest");
  for (const [key, lock] of Object.entries(p.lock))
    if (
      !lock ||
      typeof lock.url !== "string" ||
      key !== lock.url ||
      !/^https:\/\/esm\.sh\//.test(lock.url) ||
      typeof lock.integrity !== "string" ||
      !/^sha256-[A-Za-z0-9+/]{43}=$/.test(lock.integrity)
    )
      throw new Error("Invalid dependency lock");
}
function validateApp(app: AppRecord): void {
  if (
    !app ||
    !uuid.test(app.id) ||
    typeof app.name !== "string" ||
    !app.name.trim() ||
    typeof app.currentRevision !== "string" ||
    !Number.isFinite(app.createdAt) ||
    !app.state ||
    typeof app.state !== "object" ||
    Array.isArray(app.state)
  )
    throw new Error("Invalid application record");
}
export function validateShellSnapshot(snapshot: ShellSnapshot): void {
  if (
    !snapshot ||
    snapshot.version !== 2 ||
    !["apps", "revisions", "conversations", "diagnostics", "settings"].every(
      (key) => Array.isArray(snapshot[key as keyof ShellSnapshot]),
    )
  )
    throw new Error("Unsupported or malformed shell backup");
  const appIds = new Set<string>();
  const revisionIds = new Set<string>();
  const byRevision = new Map<string, Revision>();
  for (const revision of snapshot.revisions) {
    validateRevision(revision);
    if (revisionIds.has(revision.id)) throw new Error("Duplicate revision");
    revisionIds.add(revision.id);
    byRevision.set(revision.id, revision);
  }
  for (const app of snapshot.apps) {
    validateApp(app);
    if (appIds.has(app.id) || !revisionIds.has(app.currentRevision))
      throw new Error("Duplicate app or missing current revision");
    if (byRevision.get(app.currentRevision)?.appId !== app.id)
      throw new Error("Current revision belongs to a different application");
    appIds.add(app.id);
  }
  const checked = new Set<string>();
  for (const revision of snapshot.revisions) {
    if (!appIds.has(revision.appId))
      throw new Error("Revision belongs to an unknown application");
    if (revision.parent && !revisionIds.has(revision.parent))
      throw new Error("Incomplete revision history");
    const visiting = new Set<string>();
    let current: Revision | undefined = revision;
    while (current && !checked.has(current.id)) {
      if (visiting.has(current.id)) throw new Error("Cyclic revision history");
      visiting.add(current.id);
      const parent: Revision | undefined = current.parent
        ? byRevision.get(current.parent)
        : undefined;
      if (parent && parent.appId !== current.appId)
        throw new Error("Revision parent belongs to a different application");
      current = parent;
    }
    for (const id of visiting) checked.add(id);
  }
  for (const message of snapshot.conversations)
    if (
      !message ||
      !appIds.has(message.appId) ||
      typeof message.id !== "string" ||
      typeof message.content !== "string" ||
      !["user", "assistant"].includes(message.role) ||
      !Number.isFinite(message.createdAt)
    )
      throw new Error("Invalid conversation");
  for (const diagnostic of snapshot.diagnostics)
    if (
      !diagnostic ||
      typeof diagnostic.id !== "string" ||
      !Number.isFinite(diagnostic.timestamp) ||
      typeof diagnostic.event !== "string" ||
      typeof diagnostic.correlationId !== "string" ||
      !["INFO", "DEBUG"].includes(diagnostic.level)
    )
      throw new Error("Invalid diagnostic");
  for (const setting of snapshot.settings)
    if (
      !setting ||
      typeof setting.key !== "string" ||
      secretField.test(setting.key)
    )
      throw new Error("Invalid or secret-bearing platform setting");
}
export class Repository {
  private readonly database: Promise<IDBPDatabase<DatabaseSchema>>;
  constructor(name = "itsalive-v2") {
    this.database = openDB<DatabaseSchema>(name, 1, {
      upgrade(db) {
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
      },
      blocking(_current, _blocked, event) {
        (event.target as IDBDatabase).close();
      },
    });
  }
  async listApps(): Promise<AppRecord[]> {
    return (await (await this.database).getAll("apps")).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }
  async getApp(id: string): Promise<AppRecord | undefined> {
    return (await this.database).get("apps", id);
  }
  async createApp(app: AppRecord, revision: Revision): Promise<void> {
    validateApp(app);
    validateRevision(revision);
    if (
      revision.appId !== app.id ||
      revision.id !== app.currentRevision ||
      revision.parent !== null
    )
      throw new Error("Invalid initial app revision");
    const db = await this.database;
    const tx = db.transaction(["apps", "revisions"], "readwrite");
    try {
      await tx.objectStore("revisions").add(revision);
      await tx.objectStore("apps").add(app);
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* completed */
      }
      void tx.done.catch(() => undefined);
      throw error;
    }
  }
  async saveApp(app: AppRecord): Promise<void> {
    validateApp(app);
    const db = await this.database;
    const tx = db.transaction(["apps", "revisions"], "readwrite");
    if (
      (await tx.objectStore("revisions").get(app.currentRevision))?.appId !==
      app.id
    ) {
      tx.abort();
      void tx.done.catch(() => undefined);
      throw new Error(
        "Application revision does not exist or belongs to another app",
      );
    }
    await tx.objectStore("apps").put(app);
    await tx.done;
  }
  async updateState(appId: string, state: Record<string, Json>): Promise<void> {
    const db = await this.database;
    const tx = db.transaction("apps", "readwrite");
    const app = await tx.store.get(appId);
    if (!app) {
      tx.abort();
      void tx.done.catch(() => undefined);
      throw new Error("Application no longer exists");
    }
    validateApp({ ...app, state });
    await tx.store.put({ ...app, state });
    await tx.done;
  }
  async getRevision(id: string): Promise<Revision | undefined> {
    return (await this.database).get("revisions", id);
  }
  async listRevisions(appId: string): Promise<Revision[]> {
    return (await (await this.database).getAll("revisions"))
      .filter((row) => row.appId === appId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async saveRevision(revision: Revision): Promise<void> {
    validateRevision(revision);
    const db = await this.database;
    const tx = db.transaction("revisions", "readwrite");
    const old = await tx.store.get(revision.id);
    if (old && JSON.stringify(old) !== JSON.stringify(revision)) {
      tx.abort();
      void tx.done.catch(() => undefined);
      throw new Error("Revision IDs are immutable");
    }
    if (!old) await tx.store.add(revision);
    await tx.done;
  }
  async commitRevision(
    appId: string,
    expectedCurrent: string,
    revision: Revision,
  ): Promise<void> {
    validateRevision(revision);
    const db = await this.database;
    const tx = db.transaction(["apps", "revisions"], "readwrite");
    try {
      const app = await tx.objectStore("apps").get(appId);
      if (
        !app ||
        revision.appId !== appId ||
        app.currentRevision !== expectedCurrent ||
        revision.parent !== expectedCurrent
      )
        throw new Error(
          "Stale candidate: the application has changed. Rebase the edit before applying it.",
        );
      if (await tx.objectStore("revisions").get(revision.id))
        throw new Error("Revision ID already exists");
      await tx.objectStore("revisions").add(revision);
      await tx
        .objectStore("apps")
        .put({ ...app, currentRevision: revision.id });
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already completed */
      }
      void tx.done.catch(() => undefined);
      throw error;
    }
  }
  async deleteApp(id: string): Promise<void> {
    const db = await this.database;
    const tx = db.transaction(["apps", "chat", "revisions"], "readwrite");
    await tx.objectStore("apps").delete(id);
    for (const key of await tx
      .objectStore("chat")
      .index("appId")
      .getAllKeys(id))
      await tx.objectStore("chat").delete(key);
    for (const revision of await tx.objectStore("revisions").getAll())
      if (revision.appId === id)
        await tx.objectStore("revisions").delete(revision.id);
    await tx.done;
  }
  async appendChat(message: ChatMessage): Promise<void> {
    await (await this.database).put("chat", message);
  }
  async listChat(appId: string): Promise<ChatMessage[]> {
    return (
      await (await this.database).getAllFromIndex("chat", "appId", appId)
    ).sort((a, b) => a.createdAt - b.createdAt);
  }
  async appendDiagnostic(diagnostic: Diagnostic): Promise<void> {
    const db = await this.database;
    const tx = db.transaction("diagnostics", "readwrite");
    const clean = redact(diagnostic) as Diagnostic;
    await tx.store.put(clean);
    let excess = (await tx.store.count()) - 2000;
    let cursor = await tx.store.index("timestamp").openCursor();
    while (excess-- > 0 && cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  async listDiagnostics(appId?: string): Promise<Diagnostic[]> {
    const all = await (
      await this.database
    ).getAllFromIndex("diagnostics", "timestamp");
    return appId ? all.filter((row) => row.appId === appId) : all;
  }
  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await (await this.database).get("settings", key))?.value as
      | T
      | undefined;
  }
  async setSetting(key: string, value: unknown): Promise<void> {
    if (secretField.test(key))
      throw new Error(
        "Store credentials separately from portable platform settings",
      );
    await (await this.database).put("settings", { key, value });
  }
  async exportData(): Promise<ShellSnapshot> {
    const db = await this.database;
    const tx = db.transaction([
      "apps",
      "revisions",
      "chat",
      "diagnostics",
      "settings",
    ]);
    const [apps, revisions, conversations, diagnostics, settings] =
      await Promise.all([
        tx.objectStore("apps").getAll(),
        tx.objectStore("revisions").getAll(),
        tx.objectStore("chat").getAll(),
        tx.objectStore("diagnostics").getAll(),
        tx.objectStore("settings").getAll(),
      ]);
    await tx.done;
    return {
      version: 2,
      apps,
      revisions,
      conversations,
      diagnostics: diagnostics.map((row) => redact(row) as Diagnostic),
      settings: settings
        .filter((row) => !secretField.test(row.key))
        .map((row) => ({ key: row.key, value: redact(row.value) })),
    };
  }
  /** Replace shell data atomically, only after every origin has restored successfully. Credentials are outside this database. */
  async importData(snapshot: ShellSnapshot): Promise<void> {
    validateShellSnapshot(snapshot);
    const db = await this.database;
    const tx = db.transaction(
      ["apps", "revisions", "chat", "diagnostics", "settings"],
      "readwrite",
    );
    for (const name of [
      "apps",
      "revisions",
      "chat",
      "diagnostics",
      "settings",
    ] as const)
      await tx.objectStore(name).clear();
    for (const app of snapshot.apps) await tx.objectStore("apps").put(app);
    for (const revision of snapshot.revisions)
      await tx.objectStore("revisions").put(revision);
    for (const message of snapshot.conversations)
      await tx.objectStore("chat").put(message);
    for (const row of snapshot.diagnostics.slice(-2000))
      await tx.objectStore("diagnostics").put(redact(row) as Diagnostic);
    for (const setting of snapshot.settings)
      await tx
        .objectStore("settings")
        .put({ key: setting.key, value: redact(setting.value) });
    await tx.done;
  }
  async close(): Promise<void> {
    (await this.database).close();
  }
}
