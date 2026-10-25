import type {
  AppRecord,
  BuildArtifact,
  Project,
  Revision,
  RuntimeInspection,
  BehaviorObservation,
} from "../shared/types";
import { BrowserCompiler } from "../compiler";
import { Repository } from "../storage/repository";
import {
  exportBackup,
  restoreBackup,
  inspectBackup,
  type BackupProgress,
} from "../storage/backup";
import { FrameSession } from "./frame";
import { Diagnostics } from "./diagnostics";
import { starterProject } from "./starter";

export class Workspace {
  readonly repo = new Repository();
  readonly compiler = new BrowserCompiler();
  readonly diagnostics = new Diagnostics(this.repo);
  current: AppRecord | null = null;
  revision: Revision | null = null;
  frame: FrameSession | null = null;
  artifact: BuildArtifact | null = null;
  observe = false;
  onChange = () => {};
  onStatus = (_message: string) => {};
  onBehavior = (_observation: BehaviorObservation) => {};
  onBackupProgress = (_progress: BackupProgress) => {};
  backupSummary = "";
  onAI: (
    payload: unknown,
    appId: string,
    signal?: AbortSignal,
  ) => Promise<unknown> = async () => {
    throw new Error("AI is not configured");
  };
  private generation = 0;
  private stateWrites: Promise<void> = Promise.resolve();
  private applying = new Set<string>();
  private backupBusy = false;
  private activeEdits = 0;
  onRestored: () => Promise<void> = async () => {};
  beforeBackup: () => Promise<void> = async () => {};
  get isBackingUp() {
    return this.backupBusy;
  }
  constructor(private container: HTMLElement) {}

  async createApp(name: string, goal?: string): Promise<AppRecord> {
    this.assertAvailable();
    const id = crypto.randomUUID();
    const revision: Revision = {
      id: crypto.randomUUID(),
      appId: id,
      parent: null,
      createdAt: Date.now(),
      message: "Created application",
      project: starterProject(name, goal),
    };
    const app: AppRecord = {
      id,
      name: name.trim() || "Untitled",
      currentRevision: revision.id,
      createdAt: Date.now(),
      state: {},
    };
    await this.repo.createApp(app, revision);
    await this.openApp(id);
    await this.diagnostics.record(
      "app.created",
      { name: app.name },
      { appId: id, revisionId: revision.id },
    );
    return app;
  }

  async renameApp(name: string) {
    const appId = this.current?.id;
    if (!appId) throw new Error("Open an application first");
    await this.repo.renameApp(appId, name);
    if (this.current?.id === appId) this.current.name = name.trim();
    this.onChange();
  }

  async openApp(id: string) {
    this.assertAvailable();
    if (this.current && this.applying.has(this.current.id))
      throw new Error(
        "Wait for this change to finish applying before switching applications",
      );
    const generation = ++this.generation;
    this.onStatus("Opening your application…");
    await this.flushState();
    if (generation !== this.generation) return;
    this.frame?.close();
    this.frame = null;
    const app = await this.repo.getApp(id);
    if (!app) throw new Error("Application not found");
    const revision = await this.repo.getRevision(app.currentRevision);
    if (!revision) throw new Error("Application revision is missing");
    const build = await this.compiler.compile(revision.project, revision.id);
    if (!build.ok)
      throw new Error(build.diagnostics.map((d) => d.message).join("\n"));
    if (generation !== this.generation) return;
    this.current = app;
    this.revision = revision;
    this.artifact = build.artifact;
    this.container.replaceChildren();
    const frame = await FrameSession.mount({
      appId: id,
      container: this.container,
      mode: "app",
      state: app.state,
      observe: this.observe,
      onRequest: async (
        method: string,
        payload: unknown,
        signal: AbortSignal,
      ) => {
        if (method !== "ai")
          throw new Error(`Capability is not available: ${method}`);
        return this.onAI(payload, id, signal);
      },
      onEvent: (event: string, payload: unknown) => {
        if (event === "state" && !this.applying.has(id))
          this.persistState(id, payload);
        if (event === "behavior" && this.observe)
          this.onBehavior(payload as BehaviorObservation);
        if (
          event === "diagnostic" ||
          event === "diagnostics" ||
          event === "error"
        )
          void this.diagnostics.record(`runtime.${event}`, payload, {
            appId: id,
            revisionId: this.revision?.id,
          });
      },
    });
    if (generation !== this.generation) {
      frame.close();
      return;
    }
    this.frame = frame;
    await frame.request("apply", build.artifact);
    localStorage.setItem("itsalive.lastApp", id);
    this.onStatus("Ready");
    this.onChange();
  }

  private persistState(appId: string, payload: unknown) {
    this.stateWrites = this.stateWrites
      .catch(() => {})
      .then(async () => {
        if (!payload || typeof payload !== "object") return;
        const state = payload as AppRecord["state"];
        await this.repo.updateState(appId, state);
        if (this.current?.id === appId) this.current.state = state;
      });
    void this.stateWrites.catch((error) => {
      this.onStatus(
        "Your latest activity could not be saved. Keep this app open and try again.",
      );
      void this.diagnostics.record(
        "state.save.failed",
        { message: String(error) },
        { appId },
      );
    });
  }

  /** Update consent without replacing the running app or its transient activity. */
  async setObservation(enabled: boolean) {
    this.assertAvailable();
    if (!enabled) this.observe = false;
    if (this.frame) await this.frame.request("set-observation", enabled);
    this.observe = enabled;
  }

  async flushState() {
    const frame = this.frame;
    const appId = this.current?.id;
    if (frame && appId) {
      const state = await frame.request<AppRecord["state"]>("snapshot");
      this.persistState(appId, state);
    }
    await this.stateWrites;
  }

  async verify(
    artifact: BuildArtifact,
    trace: { appId?: string; correlationId?: string } = {},
  ): Promise<RuntimeInspection> {
    const started = performance.now();
    const host = document.createElement("div");
    host.className = "verification-host";
    host.setAttribute("aria-hidden", "true");
    document.body.append(host);
    let candidate: FrameSession | undefined;
    const verificationId = crypto.randomUUID();
    try {
      candidate = await FrameSession.mount({
        appId: verificationId,
        container: host,
        mode: "verify",
        state: structuredClone(this.current?.state ?? {}),
        observe: false,
        onRequest: async () => {
          throw new Error(
            "Privileged requests are disabled during verification",
          );
        },
        onEvent: () => {},
      });
      await candidate.request("apply", artifact);
      const inspection = await candidate.request<RuntimeInspection>("inspect");
      if (inspection.errors.length)
        throw new Error(inspection.errors.join("\n"));
      await this.diagnostics.record(
        "candidate.verified",
        {
          passed: true,
          errorCount: inspection.errors.length,
          durationMs: performance.now() - started,
        },
        { appId: this.current?.id, revisionId: artifact.revisionId, ...trace },
      );
      return inspection;
    } catch (error) {
      await this.diagnostics.record(
        "candidate.verification.failed",
        { passed: false, durationMs: performance.now() - started },
        { appId: this.current?.id, revisionId: artifact.revisionId, ...trace },
      );
      throw error;
    } finally {
      if (candidate) {
        candidate.close();
        let cleaner: FrameSession | undefined;
        try {
          cleaner = await FrameSession.mount({
            appId: verificationId,
            container: host,
            mode: "verify",
            state: {},
            observe: false,
          });
          await cleaner.request("cleanup");
        } catch (error) {
          await this.diagnostics.record(
            "verification.cleanup.failed",
            { message: String(error) },
            { revisionId: artifact.revisionId },
          );
        } finally {
          cleaner?.close();
        }
      }
      host.remove();
    }
  }

  async edit(
    files: Record<string, string>,
    dependencies?: Record<string, string>,
    message = "Edited source",
  ) {
    this.assertAvailable();
    if (!this.revision || !this.current)
      throw new Error("Open an application first");
    const project = structuredClone(this.revision.project);
    Object.assign(project.files, files);
    if (dependencies) Object.assign(project.dependencies, dependencies);
    return this.applyProject(project, this.revision.id, message);
  }

  async applyProject(
    project: Project,
    baseRevisionId: string,
    message: string,
    prebuilt?: BuildArtifact,
    correlationId = crypto.randomUUID(),
  ) {
    this.assertAvailable();
    const appId = this.current?.id;
    if (!appId) throw new Error("Open an application first");
    const generation = this.generation;
    const stillActive = () =>
      this.current?.id === appId && this.generation === generation;
    const started = performance.now();
    this.activeEdits++;
    try {
      return await navigator.locks.request(
        `itsalive:revision:${appId}`,
        async () => {
          try {
            await this.flushState();
            const current = await this.repo.getApp(appId);
            if (current?.currentRevision !== baseRevisionId || !stillActive())
              throw new Error(
                "This edit is stale. Reload the latest revision and try again.",
              );
            this.onStatus("Checking your changes…");
            const revisionId = prebuilt?.revisionId ?? crypto.randomUUID();
            const build = prebuilt
              ? { ok: true as const, artifact: prebuilt, project }
              : await this.compiler.compile(project, revisionId);
            if (!build.ok) {
              await this.diagnostics.record(
                "compile.failed",
                {
                  compiled: false,
                  diagnosticCount: build.diagnostics.length,
                  diagnostics: build.diagnostics.map(({ file }) => ({ file })),
                },
                { appId, revisionId, correlationId },
              );
              throw new Error(
                build.diagnostics
                  .map((d) => `${d.file ?? ""}: ${d.message}`)
                  .join("\n"),
              );
            }
            if (!stillActive())
              throw new Error("Application changed while compiling this edit");
            await this.diagnostics.record(
              "compile.completed",
              build.artifact.metrics,
              { appId, revisionId, correlationId },
            );
            await this.verify(build.artifact, { appId, correlationId });
            if (!stillActive() || !this.frame)
              throw new Error("Application changed while checking this edit");
            const frame = this.frame;
            const revision: Revision = {
              id: revisionId,
              appId,
              parent: baseRevisionId,
              createdAt: Date.now(),
              message,
              project: build.project,
            };
            const oldArtifact = this.artifact;
            const oldState =
              await frame.request<AppRecord["state"]>("snapshot");
            if (!stillActive() || this.frame !== frame)
              throw new Error("Application changed before applying this edit");
            this.applying.add(appId);
            try {
              await frame.request("apply", build.artifact);
              await this.repo.commitRevision(appId, baseRevisionId, revision);
            } catch (error) {
              if (stillActive() && this.frame === frame) {
                if (oldArtifact) await frame.request("apply", oldArtifact);
                await frame.request("restore-state", oldState);
              }
              throw error;
            } finally {
              this.applying.delete(appId);
            }
            if (stillActive() && this.frame === frame && this.current) {
              this.artifact = build.artifact;
              this.revision = revision;
              this.current.currentRevision = revision.id;
              await this.flushState();
            }
            await this.diagnostics.record(
              "revision.applied",
              {
                message,
                metrics: build.artifact.metrics,
                editToVisibleMs: performance.now() - started,
                files: Object.keys(project.files),
              },
              { appId, revisionId, correlationId },
            );
            this.onStatus("Changes applied");
            this.onChange();
            return revision.id;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await this.diagnostics.record(
              "revision.failed",
              { message },
              { appId, revisionId: baseRevisionId, correlationId },
            );
            this.onStatus(
              "This change could not be completed. Your previous app is still available.",
            );
            throw error;
          }
        },
      );
    } finally {
      this.activeEdits--;
    }
  }

  async rollback(revisionId: string) {
    this.assertAvailable();
    const revision = await this.repo.getRevision(revisionId);
    if (!revision || revision.appId !== this.current?.id || !this.revision)
      throw new Error("Revision is not part of this application");
    return this.applyProject(
      revision.project,
      this.revision.id,
      `Restore: ${revision.message}`,
    );
  }
  async inspect() {
    if (!this.frame) throw new Error("No running application");
    return this.frame.request<RuntimeInspection>("inspect");
  }
  private async openBackupOrigin(appId: string) {
    const container = document.createElement("div");
    container.className = "verification-host";
    document.body.append(container);
    const session = await FrameSession.mount({
      appId,
      container,
      mode: "backup",
      state: {},
      observe: false,
      onRequest: async () => {
        throw new Error("Backup cannot call AI");
      },
      onEvent: () => {},
    });
    return {
      request: <T = unknown>(method: string, payload?: unknown) =>
        session.request<T>(method, payload),
      close: () => {
        session.close();
        container.remove();
      },
    };
  }
  private assertAvailable() {
    if (this.backupBusy)
      throw new Error(
        "Finish the backup or restore operation before changing applications",
      );
  }
  private async beginBackup() {
    this.assertAvailable();
    if (this.activeEdits)
      throw new Error(
        "Wait for the current change before backing up or restoring",
      );
    this.backupBusy = true;
    ++this.generation;
    try {
      await this.beforeBackup();
      await this.flushState();
      this.frame?.close();
      this.frame = null;
      await this.stateWrites;
    } catch (error) {
      this.backupBusy = false;
      throw error;
    }
  }
  async exportBackup(signal?: AbortSignal) {
    await this.beginBackup();
    const active = this.current?.id;
    try {
      const blob = await exportBackup(
        this.repo,
        (id) => this.openBackupOrigin(id),
        { signal, onProgress: this.onBackupProgress },
      );
      const manifest = await inspectBackup(blob);
      const failed = manifest.origins.filter(
        (origin) => !origin.snapshot,
      ).length;
      const reports = manifest.origins.flatMap(
        (origin) => origin.snapshot?.reports ?? [],
      );
      const missing = manifest.dependencies.filter(
        (resource) => resource.bytes === null,
      ).length;
      this.backupSummary = `Archive created: ${manifest.shell.apps.length} apps. ${failed + reports.filter((r) => r.status === "failed").length} failures, ${reports.filter((r) => r.status === "skipped").length} skipped storage categories, ${missing} uncached dependency resources. See the archive manifest for details.`;
      await this.diagnostics.record("backup.exported", {
        bytes: blob.size,
        summary: this.backupSummary,
      });
      return blob;
    } finally {
      this.backupBusy = false;
      if (active) await this.openApp(active);
    }
  }
  async importBackup(blob: Blob, signal?: AbortSignal) {
    await this.beginBackup();
    try {
      const result = await restoreBackup(
        blob,
        this.repo,
        (id) => this.openBackupOrigin(id),
        { signal, onProgress: this.onBackupProgress },
      );
      const reports = result.reports.flatMap((origin) => origin.reports);
      this.backupSummary = `Restored ${result.manifest.shell.apps.length} apps. ${reports.filter((r) => r.status === "skipped").length} storage categories skipped. Provider keys stay on this device.`;
      await this.diagnostics.record("backup.restored", { bytes: blob.size });
      this.current = null;
      this.revision = null;
      this.artifact = null;
      localStorage.removeItem("itsalive.lastApp");
      await this.onRestored();
    } finally {
      this.backupBusy = false;
      const apps = await this.repo.listApps();
      if (apps[0]) await this.openApp(apps[0].id);
      else {
        this.current = null;
        this.revision = null;
        this.artifact = null;
        this.container.replaceChildren();
      }
      this.onChange();
    }
  }
}
