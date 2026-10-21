import {
  DEPENDENCY_CACHE_NAME,
  digest as dependencyDigest,
} from "../compiler/cache";
import { encodeGraph, decodeGraph, type EncodedGraph } from "./codec";
import type { Repository, ShellSnapshot } from "./repository";
import { validateShellSnapshot } from "./repository";
import {
  exportOriginStorage,
  validateOriginSnapshot,
  type OriginSnapshot,
  type StorageReport,
} from "../runtime/origin-storage";

export interface BackupOriginSession {
  request<T = unknown>(method: string, payload?: unknown): Promise<T>;
  close(): void;
}
export type OpenBackupOrigin = (appId: string) => Promise<BackupOriginSession>;
export interface BackupProgress {
  phase: "shell" | "origin" | "archive" | "validate" | "restore";
  completed: number;
  total: number;
  appId?: string;
  detail: string;
}
export interface BackupOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BackupProgress) => void;
  maxBytes?: number;
}
export interface BackupManifest {
  createdAt: number;
  format: "itsalive-backup";
  version: 2;
  shell: ShellSnapshot;
  origins: { appId: string; snapshot: OriginSnapshot | null; error?: string }[];
  dependencies: {
    url: string;
    integrity: string;
    bytes: EncodedGraph | null;
    error?: string;
  }[];
  disclosure: string[];
}
interface Envelope {
  format: "itsalive-backup";
  version: 2;
  sha256: string;
  payload: string;
}
const DEFAULT_LIMIT = 128 * 1024 * 1024;
export const BACKUP_DISCLOSURES = [
  "This archive includes application source, conversations, diagnostic history and accessible app-origin data. Generated-app data can contain secrets that the platform cannot reliably identify. Store the archive privately.",
  "Shell-managed provider credentials are excluded. Backups are integrity checked but are not encrypted or cryptographically authenticated.",
  "Close all other app tabs first. Browser APIs cannot guarantee a single atomic snapshot across every origin or storage type.",
  "Cookies, session-only storage, protected credentials, permissions, service workers, opaque cached responses and other inaccessible browser state are not restored. Read each origin report for failures and skipped data.",
  "This implementation constructs the archive in memory and limits it to 128 MiB by default. Large data may require more browser memory; streaming archives are not yet supported.",
];
async function digest(payload: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
function progress(options: BackupOptions, update: BackupProgress): void {
  options.signal?.throwIfAborted();
  options.onProgress?.(update);
}
async function originRequest<T>(
  session: BackupOriginSession,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return session.request<T>(method, payload);
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void session.request("cancel").catch(() => undefined);
      reject(
        signal.reason ?? new DOMException("Operation cancelled", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([session.request<T>(method, payload), cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
async function captureDependencies(
  shell: ShellSnapshot,
  options: BackupOptions,
): Promise<BackupManifest["dependencies"]> {
  const locks = new Map<string, string>();
  for (const revision of shell.revisions)
    for (const lock of Object.values(revision.project.lock)) {
      const old = locks.get(lock.url);
      if (old && old !== lock.integrity)
        throw new Error(`Conflicting dependency locks for ${lock.url}`);
      locks.set(lock.url, lock.integrity);
    }
  const cache =
    typeof caches === "undefined"
      ? undefined
      : await caches.open(DEPENDENCY_CACHE_NAME);
  const result: BackupManifest["dependencies"] = [];
  for (const [url, integrity] of locks) {
    options.signal?.throwIfAborted();
    try {
      const response = await cache?.match(url);
      if (!response)
        throw new Error(
          "Dependency is absent from the shell cache; online download will be required after restoration",
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if ((await dependencyDigest(bytes)) !== integrity)
        throw new Error(
          "Cached dependency failed its source lock integrity check",
        );
      result.push({ url, integrity, bytes: await encodeGraph(bytes) });
    } catch (error) {
      result.push({
        url,
        integrity,
        bytes: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
export async function exportBackup(
  repository: Repository,
  openOrigin: OpenBackupOrigin,
  options: BackupOptions = {},
): Promise<Blob> {
  progress(options, {
    phase: "shell",
    completed: 0,
    total: 1,
    detail: "Capturing shell records",
  });
  const shell = await repository.exportData();
  const origins: BackupManifest["origins"] = [];
  for (const [index, app] of shell.apps.entries()) {
    progress(options, {
      phase: "origin",
      completed: index,
      total: shell.apps.length,
      appId: app.id,
      detail: `Reading ${app.name}`,
    });
    let session: BackupOriginSession | undefined;
    try {
      session = await openOrigin(app.id);
      options.signal?.throwIfAborted();
      const snapshot = await originRequest<OriginSnapshot>(
        session,
        "backup",
        null,
        options.signal,
      );
      options.signal?.throwIfAborted();
      validateOriginSnapshot(snapshot);
      origins.push({ appId: app.id, snapshot });
    } catch (error) {
      options.signal?.throwIfAborted();
      origins.push({
        appId: app.id,
        snapshot: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session?.close();
    }
  }
  progress(options, {
    phase: "archive",
    completed: 0,
    total: 1,
    detail: "Checking archive integrity",
  });
  const manifest: BackupManifest = {
    createdAt: Date.now(),
    format: "itsalive-backup",
    version: 2,
    shell,
    origins,
    dependencies: await captureDependencies(shell, options),
    disclosure: BACKUP_DISCLOSURES,
  };
  const payload = JSON.stringify(manifest);
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (bytes > (options.maxBytes ?? DEFAULT_LIMIT))
    throw new Error(
      "Backup exceeds the archive memory limit. Export a smaller dataset or use browser site-data tools.",
    );
  const envelope: Envelope = {
    format: "itsalive-backup",
    version: 2,
    sha256: await digest(payload),
    payload,
  };
  const blob = new Blob([JSON.stringify(envelope)], {
    type: "application/json",
  });
  if (blob.size > (options.maxBytes ?? DEFAULT_LIMIT))
    throw new Error("Backup envelope exceeds the archive size limit");
  progress(options, {
    phase: "archive",
    completed: 1,
    total: 1,
    detail:
      "Archive ready; inspect its manifest for skipped storage or failures",
  });
  return blob;
}
export async function inspectBackup(
  blob: Blob,
  options: BackupOptions = {},
): Promise<BackupManifest> {
  progress(options, {
    phase: "validate",
    completed: 0,
    total: 1,
    detail: "Validating archive before changing storage",
  });
  if (blob.size > (options.maxBytes ?? DEFAULT_LIMIT))
    throw new Error("Archive exceeds the import limit");
  const envelope = JSON.parse(await blob.text()) as Envelope;
  if (
    !envelope ||
    envelope.format !== "itsalive-backup" ||
    envelope.version !== 2 ||
    typeof envelope.payload !== "string" ||
    typeof envelope.sha256 !== "string" ||
    (await digest(envelope.payload)) !== envelope.sha256
  )
    throw new Error(
      "Backup is corrupted, has failed its SHA-256 check, or uses an unsupported format",
    );
  const manifest = JSON.parse(envelope.payload) as BackupManifest;
  if (
    !manifest ||
    manifest.format !== "itsalive-backup" ||
    manifest.version !== 2 ||
    !Array.isArray(manifest.origins) ||
    !Array.isArray(manifest.dependencies)
  )
    throw new Error("Invalid backup manifest");
  validateShellSnapshot(manifest.shell);
  const appIds = new Set(manifest.shell.apps.map((app) => app.id));
  const seen = new Set<string>();
  for (const origin of manifest.origins) {
    if (!origin || !appIds.has(origin.appId) || seen.has(origin.appId))
      throw new Error("Invalid origin/application mapping");
    seen.add(origin.appId);
    if (origin.snapshot !== null) validateOriginSnapshot(origin.snapshot);
    else if (typeof origin.error !== "string")
      throw new Error("Missing origin data without failure report");
  }
  if (seen.size !== appIds.size)
    throw new Error("Backup omits an application origin");
  const locked = new Map<string, string>();
  for (const revision of manifest.shell.revisions)
    for (const lock of Object.values(revision.project.lock)) {
      const prior = locked.get(lock.url);
      if (prior && prior !== lock.integrity)
        throw new Error("Conflicting dependency integrity locks");
      locked.set(lock.url, lock.integrity);
    }
  const dependencies = new Set<string>();
  for (const dependency of manifest.dependencies) {
    if (
      !dependency ||
      dependencies.has(dependency.url) ||
      locked.get(dependency.url) !== dependency.integrity ||
      new URL(dependency.url).origin !== "https://esm.sh"
    )
      throw new Error("Invalid dependency backup");
    dependencies.add(dependency.url);
    if (dependency.bytes !== null) {
      const bytes = decodeGraph(dependency.bytes);
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > 8 * 1024 * 1024 ||
        (await dependencyDigest(bytes)) !== dependency.integrity
      )
        throw new Error("Dependency backup failed integrity validation");
    } else if (typeof dependency.error !== "string")
      throw new Error("Missing dependency without a failure report");
  }
  if (dependencies.size !== locked.size)
    throw new Error("Backup omits locked dependencies");
  options.signal?.throwIfAborted();
  return manifest;
}
export interface RestoreResult {
  manifest: BackupManifest;
  reports: { appId: string; reports: StorageReport[] }[];
}
export async function restoreBackup(
  blob: Blob,
  repository: Repository,
  openOrigin: OpenBackupOrigin,
  options: BackupOptions = {},
): Promise<RestoreResult> {
  const manifest = await inspectBackup(blob, options);
  const reports: RestoreResult["reports"] = [];
  // Origin restore is not a cross-origin transaction. A later error can leave earlier origins restored.
  // Commit shell pointers last, so incomplete restoration cannot advertise healthy application state.
  for (const [index, origin] of manifest.origins.entries()) {
    progress(options, {
      phase: "restore",
      completed: index,
      total: manifest.origins.length,
      appId: origin.appId,
      detail: "Restoring application-origin data",
    });
    if (!origin.snapshot) {
      reports.push({
        appId: origin.appId,
        reports: [
          {
            storage: "origin",
            status: "skipped",
            detail: origin.error ?? "No origin data available",
          },
        ],
      });
      continue;
    }
    const session = await openOrigin(origin.appId);
    try {
      const result = await originRequest<StorageReport[]>(
        session,
        "restore",
        origin.snapshot,
        options.signal,
      );
      options.signal?.throwIfAborted();
      reports.push({ appId: origin.appId, reports: result });
      const failures = result.filter((row) => row.status === "failed");
      if (failures.length)
        throw new Error(
          `Origin restore failed: ${failures.map((row) => `${row.storage}: ${row.detail}`).join("; ")}. Shell records were not changed; earlier origin writes may already have completed.`,
        );
    } finally {
      session.close();
    }
  }
  progress(options, {
    phase: "restore",
    completed: manifest.origins.length,
    total: manifest.origins.length,
    detail: "Committing shell records",
  });
  if (manifest.dependencies.some((dependency) => dependency.bytes !== null)) {
    if (typeof caches === "undefined")
      throw new Error(
        "Cache Storage unavailable: cannot restore locked dependencies",
      );
    const cache = await caches.open(DEPENDENCY_CACHE_NAME);
    for (const dependency of manifest.dependencies)
      if (dependency.bytes !== null) {
        options.signal?.throwIfAborted();
        const bytes = decodeGraph(dependency.bytes) as Uint8Array;
        await cache.put(dependency.url, new Response(bytes.slice().buffer));
      }
  }
  options.signal?.throwIfAborted();
  await repository.importData(manifest.shell);
  return { manifest, reports };
}
// Kept as a type-safe test seam for browser acceptance fixtures; no application source is needed.
export const captureCurrentOrigin = exportOriginStorage;
