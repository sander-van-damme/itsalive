import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CodingCheckpoint } from "../ai/checkpoint";
import type { UsageRecord } from "../ai/types";
import { credentialField, redactCredentials } from "../shared/redaction";
import type {
  AppRecord,
  ChatMessage,
  Diagnostic,
  Json,
  Revision,
} from "../shared/types";

interface DatabaseSchema extends DBSchema {
  codingDrafts: { key: string; value: CodingCheckpoint };
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
  /** Absent in earlier v2 archives; new backups preserve resumable candidate work. */
  codingDrafts?: CodingCheckpoint[];
}
export interface DiagnosticRetention {
  maxEntries: number;
  /** Count since retention metadata began; older ring pruning may be unknowable. */
  droppedCount: number;
  earlierDroppedCount?: "unknown";
  firstRecordedAt?: number;
  lastRecordedAt?: number;
  lastPrunedAt?: number;
}
const DIAGNOSTIC_LIMIT = 2000;
const RETENTION_KEY = "diagnostics.retention";
function diagnosticOrder(a: Diagnostic, b: Diagnostic): number {
  const sequence = (row: Diagnostic) =>
    (row as Diagnostic & { sequence?: number }).sequence ?? 0;
  return (
    a.timestamp - b.timestamp ||
    (a.sessionId ?? "").localeCompare(b.sessionId ?? "") ||
    sequence(a) - sequence(b) ||
    a.id.localeCompare(b.id)
  );
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isCredentialSetting(key: string): boolean {
  const field = key.split(/[.:]/).at(-1) ?? key;
  return (
    /^itsalive\.chatgpt(?:\.|$)/i.test(key) ||
    credentialField.test(field) ||
    field.toLowerCase() === "tokens"
  );
}
/** Defense in depth. Arbitrary generated-app state is deliberately not filtered. */
export function redact(value: unknown): unknown {
  return redactCredentials(value);
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
function validateCheckpoint(checkpoint: CodingCheckpoint): void {
  if (
    !checkpoint ||
    checkpoint.version !== 1 ||
    typeof checkpoint.id !== "string" ||
    !checkpoint.id ||
    typeof checkpoint.intent !== "string" ||
    !checkpoint.intent.trim() ||
    typeof checkpoint.originalRequest !== "string" ||
    typeof checkpoint.correlationId !== "string" ||
    typeof checkpoint.baseRevisionId !== "string" ||
    !["coding-simple", "coding-standard", "coding-complex"].includes(
      checkpoint.role,
    ) ||
    !["working", "paused"].includes(checkpoint.status) ||
    !Number.isFinite(checkpoint.createdAt) ||
    !Number.isFinite(checkpoint.updatedAt) ||
    !Number.isInteger(checkpoint.turns) ||
    checkpoint.turns < 0 ||
    !Number.isInteger(checkpoint.toolCalls) ||
    checkpoint.toolCalls < 0 ||
    typeof checkpoint.finishRequested !== "boolean" ||
    typeof checkpoint.summary !== "string" ||
    !Array.isArray(checkpoint.changedFiles) ||
    checkpoint.changedFiles.some(
      (name) =>
        typeof name !== "string" ||
        name.startsWith("/") ||
        name.split("/").includes(".."),
    )
  )
    throw new Error("Invalid coding checkpoint");
  validateRevision({
    id: checkpoint.id,
    appId: checkpoint.appId,
    parent: checkpoint.baseRevisionId,
    createdAt: checkpoint.createdAt,
    message: checkpoint.intent,
    project: checkpoint.project,
  });
  const validCalls = (calls: unknown): boolean =>
    Array.isArray(calls) &&
    calls.every(
      (call) =>
        call &&
        typeof call === "object" &&
        typeof call.id === "string" &&
        typeof call.name === "string" &&
        typeof call.arguments === "string",
    );
  const validMessages = (messages: unknown): boolean =>
    Array.isArray(messages) &&
    messages.every(
      (message) =>
        message &&
        typeof message === "object" &&
        ["system", "user", "assistant", "tool"].includes(message.role) &&
        typeof message.content === "string" &&
        (message.toolCallId === undefined ||
          typeof message.toolCallId === "string") &&
        (message.toolCalls === undefined || validCalls(message.toolCalls)) &&
        (message.responseItems === undefined ||
          Array.isArray(message.responseItems)),
    );
  if (
    !validMessages(checkpoint.messages) ||
    (checkpoint.archivedContexts !== undefined &&
      (!Array.isArray(checkpoint.archivedContexts) ||
        !checkpoint.archivedContexts.every(validMessages)))
  )
    throw new Error("Invalid checkpoint conversation");
  if (
    checkpoint.pending &&
    (!validCalls(checkpoint.pending.calls) ||
      !Number.isInteger(checkpoint.pending.next) ||
      checkpoint.pending.next < 0 ||
      checkpoint.pending.next > checkpoint.pending.calls.length ||
      typeof checkpoint.pending.incomplete !== "boolean")
  )
    throw new Error("Invalid checkpoint continuation");
  if (
    checkpoint.receipts !== undefined &&
    (!checkpoint.receipts ||
      typeof checkpoint.receipts !== "object" ||
      Array.isArray(checkpoint.receipts) ||
      Object.values(checkpoint.receipts).some(
        (receipt) =>
          !receipt ||
          typeof receipt.name !== "string" ||
          typeof receipt.arguments !== "string" ||
          typeof receipt.output !== "string" ||
          typeof receipt.ok !== "boolean",
      ))
  )
    throw new Error("Invalid checkpoint receipts");
  if (
    checkpoint.lastFailure !== undefined &&
    (!checkpoint.lastFailure || typeof checkpoint.lastFailure.kind !== "string")
  )
    throw new Error("Invalid checkpoint failure");
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
  const messageIds = new Set<string>();
  for (const message of snapshot.conversations) {
    if (
      !message ||
      !appIds.has(message.appId) ||
      typeof message.id !== "string" ||
      messageIds.has(message.id) ||
      typeof message.content !== "string" ||
      !["user", "assistant"].includes(message.role) ||
      !Number.isFinite(message.createdAt)
    )
      throw new Error("Invalid conversation");
    messageIds.add(message.id);
  }
  const diagnosticIds = new Set<string>();
  for (const diagnostic of snapshot.diagnostics) {
    if (
      !diagnostic ||
      typeof diagnostic.id !== "string" ||
      diagnosticIds.has(diagnostic.id) ||
      !Number.isFinite(diagnostic.timestamp) ||
      typeof diagnostic.event !== "string" ||
      typeof diagnostic.correlationId !== "string" ||
      !["INFO", "DEBUG"].includes(diagnostic.level)
    )
      throw new Error("Invalid diagnostic");
    diagnosticIds.add(diagnostic.id);
  }
  const settingKeys = new Set<string>();
  for (const setting of snapshot.settings) {
    if (
      !setting ||
      typeof setting.key !== "string" ||
      settingKeys.has(setting.key) ||
      isCredentialSetting(setting.key)
    )
      throw new Error("Invalid or secret-bearing platform setting");
    settingKeys.add(setting.key);
    if (setting.key === "ai.usage") {
      if (!Array.isArray(setting.value))
        throw new Error("Invalid usage ledger");
      const usageIds = new Set<string>();
      for (const record of setting.value) {
        if (
          !record ||
          typeof record.id !== "string" ||
          !record.id ||
          usageIds.has(record.id) ||
          !Number.isFinite(record.timestamp) ||
          !Number.isFinite(record.costUSD) ||
          record.costUSD < 0
        )
          throw new Error("Invalid or duplicate usage record");
        usageIds.add(record.id);
      }
    }
  }
  if (
    snapshot.codingDrafts !== undefined &&
    !Array.isArray(snapshot.codingDrafts)
  )
    throw new Error("Invalid coding drafts");
  const draftApps = new Set<string>();
  for (const draft of snapshot.codingDrafts ?? []) {
    validateCheckpoint(draft);
    const app = snapshot.apps.find((candidate) => candidate.id === draft.appId);
    if (
      !app ||
      draftApps.has(draft.appId) ||
      app.currentRevision !== draft.baseRevisionId
    )
      throw new Error("Duplicate, orphaned or stale coding draft");
    draftApps.add(draft.appId);
  }
}
export class Repository {
  private readonly database: Promise<IDBPDatabase<DatabaseSchema>>;
  constructor(name = "itsalive-v2") {
    this.database = openDB<DatabaseSchema>(name, 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
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
        }
        if (oldVersion < 2)
          db.createObjectStore("codingDrafts", { keyPath: "appId" });
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
  async renameApp(appId: string, name: string): Promise<void> {
    if (!name.trim()) throw new Error("Enter an application name.");
    const tx = (await this.database).transaction("apps", "readwrite");
    const app = await tx.store.get(appId);
    if (!app) throw new Error("Application no longer exists");
    await tx.store.put({ ...app, name: name.trim() });
    await tx.done;
  }
  async getCodingCheckpoint(
    appId: string,
  ): Promise<CodingCheckpoint | undefined> {
    return (await this.database).get("codingDrafts", appId);
  }
  async saveCodingCheckpoint(checkpoint: CodingCheckpoint): Promise<void> {
    validateCheckpoint(checkpoint);
    const tx = (await this.database).transaction(
      ["apps", "codingDrafts"],
      "readwrite",
    );
    try {
      const app = await tx.objectStore("apps").get(checkpoint.appId);
      if (!app || app.currentRevision !== checkpoint.baseRevisionId)
        throw new Error(
          "This draft belongs to an earlier application version.",
        );
      const previous = await tx
        .objectStore("codingDrafts")
        .get(checkpoint.appId);
      if (
        previous &&
        previous.id !== checkpoint.id &&
        previous.createdAt >= checkpoint.createdAt
      )
        throw new Error("A newer coding draft already exists.");
      await tx.objectStore("codingDrafts").put(checkpoint);
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
  async clearCodingCheckpoint(
    appId: string,
    checkpointId: string,
  ): Promise<void> {
    const tx = (await this.database).transaction("codingDrafts", "readwrite");
    if ((await tx.store.get(appId))?.id === checkpointId)
      await tx.store.delete(appId);
    await tx.done;
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
    const tx = db.transaction(
      ["apps", "revisions", "codingDrafts"],
      "readwrite",
    );
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
      await tx.objectStore("codingDrafts").delete(appId);
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
    const tx = db.transaction(
      ["apps", "chat", "revisions", "codingDrafts"],
      "readwrite",
    );
    await tx.objectStore("apps").delete(id);
    await tx.objectStore("codingDrafts").delete(id);
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
    const tx = db.transaction(["diagnostics", "settings"], "readwrite");
    const store = tx.objectStore("diagnostics");
    const clean = redact(diagnostic) as Diagnostic;
    await store.put(clean);
    const retainedCount = await store.count();
    let excess = Math.max(0, retainedCount - DIAGNOSTIC_LIMIT);
    const dropped = excess;
    let cursor = excess ? await store.index("timestamp").openCursor() : null;
    while (excess > 0 && cursor) {
      const timestamp = cursor.value.timestamp;
      const simultaneous: Diagnostic[] = [];
      do {
        simultaneous.push(cursor.value);
        cursor = await cursor.continue();
      } while (cursor && cursor.value.timestamp === timestamp);
      for (const oldest of simultaneous
        .sort(diagnosticOrder)
        .slice(0, excess)) {
        await store.delete(oldest.id);
        excess--;
      }
    }
    const previous = (await tx.objectStore("settings").get(RETENTION_KEY))
      ?.value as DiagnosticRetention | undefined;
    await tx.objectStore("settings").put({
      key: RETENTION_KEY,
      value: {
        maxEntries: DIAGNOSTIC_LIMIT,
        droppedCount: (previous?.droppedCount ?? 0) + dropped,
        ...(previous?.earlierDroppedCount === "unknown" ||
        (!previous && retainedCount > 1)
          ? { earlierDroppedCount: "unknown" as const }
          : {}),
        firstRecordedAt: previous?.firstRecordedAt ?? diagnostic.timestamp,
        lastRecordedAt: diagnostic.timestamp,
        ...(previous?.lastPrunedAt === undefined
          ? {}
          : { lastPrunedAt: previous.lastPrunedAt }),
        ...(dropped ? { lastPrunedAt: diagnostic.timestamp } : {}),
      } satisfies DiagnosticRetention,
    });
    await tx.done;
  }
  /** A single transaction prevents diagnostics and accounting from straddling different snapshots. */
  async diagnosticSnapshot(): Promise<{
    diagnostics: Diagnostic[];
    usage: UsageRecord[];
    retention: DiagnosticRetention;
    capturedAt: number;
  }> {
    const tx = (await this.database).transaction(["diagnostics", "settings"]);
    const [diagnostics, usage, retention] = await Promise.all([
      tx.objectStore("diagnostics").index("timestamp").getAll(),
      tx.objectStore("settings").get("ai.usage"),
      tx.objectStore("settings").get(RETENTION_KEY),
    ]);
    await tx.done;
    return {
      diagnostics: diagnostics.sort(diagnosticOrder),
      usage: Array.isArray(usage?.value) ? usage.value : [],
      retention: (retention?.value as DiagnosticRetention | undefined) ?? {
        maxEntries: DIAGNOSTIC_LIMIT,
        droppedCount: 0,
        ...(diagnostics.length
          ? { earlierDroppedCount: "unknown" as const }
          : {}),
      },
      capturedAt: Date.now(),
    };
  }
  async listDiagnostics(appId?: string): Promise<Diagnostic[]> {
    const all = await (
      await this.database
    ).getAllFromIndex("diagnostics", "timestamp");
    return (appId ? all.filter((row) => row.appId === appId) : all).sort(
      diagnosticOrder,
    );
  }
  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await (await this.database).get("settings", key))?.value as
      | T
      | undefined;
  }
  async setSetting(key: string, value: unknown): Promise<void> {
    if (isCredentialSetting(key))
      throw new Error(
        "Store credentials separately from portable platform settings",
      );
    await (await this.database).put("settings", { key, value });
  }
  /** Merge one request atomically so separate tabs cannot overwrite each other's ledger. */
  async recordUsage(record: UsageRecord): Promise<void> {
    const tx = (await this.database).transaction("settings", "readwrite");
    const stored = await tx.store.get("ai.usage");
    const records: UsageRecord[] = Array.isArray(stored?.value)
      ? stored.value
      : [];
    const index = records.findIndex((entry) => entry.id === record.id);
    // A delayed pending write must never erase a settled usage result.
    if (index < 0) records.push(record);
    else if (
      record.status !== "pending" ||
      records[index]!.status === "pending"
    )
      records[index] = record;
    await tx.store.put({ key: "ai.usage", value: records });
    await tx.done;
  }
  async exportData(): Promise<ShellSnapshot> {
    const db = await this.database;
    const tx = db.transaction([
      "apps",
      "revisions",
      "chat",
      "diagnostics",
      "settings",
      "codingDrafts",
    ]);
    const [
      apps,
      revisions,
      conversations,
      diagnostics,
      settings,
      codingDrafts,
    ] = await Promise.all([
      tx.objectStore("apps").getAll(),
      tx.objectStore("revisions").getAll(),
      tx.objectStore("chat").getAll(),
      tx.objectStore("diagnostics").getAll(),
      tx.objectStore("settings").getAll(),
      tx.objectStore("codingDrafts").getAll(),
    ]);
    await tx.done;
    return {
      version: 2,
      apps,
      revisions,
      conversations,
      codingDrafts: codingDrafts.map(
        (draft) => redact(draft) as CodingCheckpoint,
      ),
      diagnostics: diagnostics
        .sort(diagnosticOrder)
        .map((row) => redact(row) as Diagnostic),
      settings: settings
        .filter((row) => !isCredentialSetting(row.key))
        .map((row) => ({ key: row.key, value: redact(row.value) })),
    };
  }
  /** Replace shell data atomically, only after every origin has restored successfully. Credentials are outside this database. */
  async importData(snapshot: ShellSnapshot): Promise<void> {
    validateShellSnapshot(snapshot);
    const db = await this.database;
    const tx = db.transaction(
      ["apps", "revisions", "chat", "diagnostics", "settings", "codingDrafts"],
      "readwrite",
    );
    for (const name of [
      "apps",
      "revisions",
      "chat",
      "diagnostics",
      "settings",
      "codingDrafts",
    ] as const)
      await tx.objectStore(name).clear();
    for (const app of snapshot.apps) await tx.objectStore("apps").put(app);
    for (const revision of snapshot.revisions)
      await tx.objectStore("revisions").put(revision);
    for (const message of snapshot.conversations)
      await tx.objectStore("chat").put(message);
    for (const row of snapshot.diagnostics)
      await tx.objectStore("diagnostics").put(redact(row) as Diagnostic);
    for (const setting of snapshot.settings)
      await tx
        .objectStore("settings")
        .put({ key: setting.key, value: redact(setting.value) });
    for (const draft of snapshot.codingDrafts ?? [])
      await tx
        .objectStore("codingDrafts")
        .put(redact(draft) as CodingCheckpoint);
    await tx.done;
  }
  async close(): Promise<void> {
    (await this.database).close();
  }
}
