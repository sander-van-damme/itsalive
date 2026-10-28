import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { Workspace } from "../src/shell/workspace";
import type { FrameSession } from "../src/shell/frame";
import type {
  AppRecord,
  BuildArtifact,
  Project,
  Revision,
} from "../src/shared/types";

const mocks = vi.hoisted(() => ({ mount: vi.fn(), compile: vi.fn() }));
vi.mock("../src/shell/frame", () => ({ FrameSession: { mount: mocks.mount } }));
vi.mock("../src/compiler", () => ({
  BrowserCompiler: class {
    compile = mocks.compile;
  },
}));

const project: Project = {
  entry: "src/App.tsx",
  dependencies: {},
  lock: {},
  files: { "src/App.tsx": "export default function App(){return null}" },
};
function artifact(revisionId: string): BuildArtifact {
  return {
    entry: project.entry,
    revisionId,
    modules: {},
    css: "",
    metrics: {},
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function frame(
  request = vi.fn(async (_method: string): Promise<unknown> => ({})),
) {
  return {
    request,
    close: vi.fn(),
    setVisible: vi.fn(),
  } as unknown as FrameSession & {
    request: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
  };
}
const workspaces: Workspace[] = [];
function workspace() {
  const instance = new Workspace({
    replaceChildren: vi.fn(),
  } as unknown as HTMLElement);
  workspaces.push(instance);
  return instance;
}
async function app(workspace: Workspace, name: string) {
  const id = crypto.randomUUID();
  const revision: Revision = {
    id: crypto.randomUUID(),
    appId: id,
    parent: null,
    createdAt: Date.now(),
    message: name,
    project: structuredClone(project),
  };
  const app: AppRecord = {
    id,
    name,
    createdAt: Date.now(),
    currentRevision: revision.id,
    state: { owner: name },
  };
  await workspace.repo.createApp(app, revision);
  return { app, revision, artifact: artifact(revision.id) };
}
function select(
  workspace: Workspace,
  fixture: Awaited<ReturnType<typeof app>>,
  session: FrameSession,
) {
  workspace.current = structuredClone(fixture.app);
  workspace.revision = structuredClone(fixture.revision);
  workspace.artifact = fixture.artifact;
  workspace.frame = session;
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, callback: () => Promise<unknown>) =>
        callback(),
    },
  });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  mocks.mount.mockReset();
  mocks.compile
    .mockReset()
    .mockImplementation(async (input: Project, id: string) => ({
      ok: true,
      artifact: artifact(id),
      project: input,
    }));
});
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.repo.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace asynchronous application ownership", () => {
  it("distinguishes successful rendering from failed measured quality in candidate diagnostics", async () => {
    const work = workspace();
    const host = { className: "", setAttribute: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: () => host,
      body: { append: vi.fn() },
    });
    const inspection = {
      text: "Instruction",
      errors: [],
      revisionId: "candidate",
      quality: {
        scope: "visible-current-view" as const,
        checkedTextElements: 1,
        checkedControls: 0,
        inconclusive: [],
        issues: [
          {
            code: "text-contrast" as const,
            severity: "error" as const,
            element: "p",
            message: "Low contrast",
            actual: 2.3,
            expected: 4.5,
          },
        ],
      },
    };
    mocks.mount.mockResolvedValue(
      frame(
        vi.fn(async (method: string) =>
          method === "inspect" ? inspection : undefined,
        ),
      ),
    );
    expect(await work.verify(artifact("candidate"))).toEqual(inspection);
    const diagnostic = (await work.repo.listDiagnostics()).find(
      (row) => row.event === "candidate.verified",
    );
    expect(diagnostic?.data).toMatchObject({
      passed: false,
      runtimePassed: true,
      qualityPassed: false,
      qualityErrorCount: 1,
    });
    expect(host.remove).toHaveBeenCalledOnce();
  });
  it("keeps recent runtimes mounted so switching apps preserves transient activity", async () => {
    const work = workspace();
    const a = await app(work, "A");
    const b = await app(work, "B");
    const aFrame = frame(vi.fn(async () => a.app.state));
    const bFrame = frame(vi.fn(async () => b.app.state));
    mocks.mount.mockResolvedValueOnce(aFrame).mockResolvedValueOnce(bFrame);
    await work.openApp(a.app.id);
    await work.openApp(b.app.id);
    await work.openApp(a.app.id);
    expect(mocks.mount).toHaveBeenCalledTimes(2);
    expect(work.frame).toBe(aFrame);
    expect(aFrame.close).not.toHaveBeenCalled();
    expect(bFrame.close).not.toHaveBeenCalled();
    expect(aFrame.setVisible).toHaveBeenLastCalledWith(true);
    expect(bFrame.setVisible).toHaveBeenLastCalledWith(false);
  });

  it("bounds mounted app resources and saves durable state before suspending an older runtime", async () => {
    const work = workspace();
    const fixtures = await Promise.all(
      ["A", "B", "C", "D", "E"].map((name) => app(work, name)),
    );
    const frames = fixtures.map((fixture) =>
      frame(vi.fn(async () => ({ ...fixture.app.state, saved: true }))),
    );
    for (const session of frames) mocks.mount.mockResolvedValueOnce(session);
    for (const fixture of fixtures) await work.openApp(fixture.app.id);
    expect(frames[0]!.close).toHaveBeenCalledOnce();
    expect(
      frames.slice(1).every((session) => session.close.mock.calls.length === 0),
    ).toBe(true);
    expect((await work.repo.getApp(fixtures[0]!.app.id))?.state.saved).toBe(
      true,
    );
  });

  it("preserves live apply failure evidence and verifies rollback before allowing repair", async () => {
    const work = workspace();
    const fixture = await app(work, "Practice");
    const candidate = artifact("candidate-id");
    const active = frame(
      vi.fn(async (method: string) => {
        if (method === "apply")
          throw new Error("Hook order changed in Practice");
        if (method === "inspect")
          return {
            text: "Old app",
            errors: [],
            revisionId: fixture.revision.id,
          };
        return fixture.app.state;
      }),
    );
    select(work, fixture, active);
    vi.spyOn(work, "verify").mockResolvedValue({
      text: "Cold check passed",
      errors: [],
      revisionId: candidate.revisionId,
    });
    await expect(
      work.applyProject(
        project,
        fixture.revision.id,
        "Practice change",
        candidate,
        "operation-id",
      ),
    ).rejects.toMatchObject({
      name: "LiveApplicationError",
      message: "Hook order changed in Practice",
      detail: {
        stage: "live-apply",
        rollbackSucceeded: true,
        baseRevisionId: fixture.revision.id,
        candidateRevisionId: candidate.revisionId,
      },
    });
    expect(
      active.request.mock.calls.filter(([method]) => method === "apply"),
    ).toHaveLength(1);
    expect(active.request).toHaveBeenCalledWith(
      "restore-state",
      fixture.app.state,
    );
    expect((await work.repo.getApp(fixture.app.id))?.currentRevision).toBe(
      fixture.revision.id,
    );
    const events = await work.repo.listDiagnostics();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "revision.failed",
        correlationId: "operation-id",
        revisionId: candidate.revisionId,
      }),
    );
  });
  it("changes observation consent without remounting the app or rewriting its state", async () => {
    const work = workspace();
    const fixture = await app(work, "Practice");
    const active = frame();
    select(work, fixture, active);
    await work.setObservation(true);
    expect(active.request).toHaveBeenCalledWith("set-observation", true);
    expect(work.observe).toBe(true);
    await work.setObservation(false);
    expect(active.request).toHaveBeenLastCalledWith("set-observation", false);
    expect(work.observe).toBe(false);
    expect(active.close).not.toHaveBeenCalled();
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(work.frame).toBe(active);
    expect(work.current?.state).toEqual(fixture.app.state);
  });

  it("cancellation during verification never reaches live apply or persistence", async () => {
    const work = workspace();
    const fixture = await app(work, "Practice");
    const active = frame(vi.fn(async () => fixture.app.state));
    select(work, fixture, active);
    const checked = deferred<{
      text: string;
      errors: string[];
      revisionId: string;
    }>();
    const verify = vi.spyOn(work, "verify").mockReturnValue(checked.promise);
    const applying = vi.fn();
    work.onApplying = applying;
    const committed = vi.spyOn(work.repo, "commitRevision");
    const controller = new AbortController();
    const editing = work.applyProject(
      project,
      fixture.revision.id,
      "Cancelled change",
      undefined,
      "cancel-operation",
      controller.signal,
    );
    const rejected = expect(editing).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    controller.abort();
    checked.resolve({ text: "Verified", errors: [], revisionId: "candidate" });
    await rejected;
    expect(
      active.request.mock.calls.some(([method]) => method === "apply"),
    ).toBe(false);
    expect(applying).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    expect((await work.repo.getApp(fixture.app.id))?.currentRevision).toBe(
      fixture.revision.id,
    );
  });

  it("finishes an already-started atomic application even if cancellation arrives", async () => {
    const work = workspace();
    const fixture = await app(work, "Practice");
    const applied = deferred<unknown>();
    const active = frame(
      vi.fn(async (method: string) =>
        method === "apply" ? applied.promise : fixture.app.state,
      ),
    );
    select(work, fixture, active);
    vi.spyOn(work, "verify").mockResolvedValue({
      text: "Verified",
      errors: [],
      revisionId: "candidate",
    });
    const applying = vi.fn();
    work.onApplying = applying;
    const controller = new AbortController();
    const editing = work.applyProject(
      project,
      fixture.revision.id,
      "Atomic change",
      undefined,
      "atomic-operation",
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(active.request).toHaveBeenCalledWith("apply", expect.any(Object)),
    );
    expect(applying).toHaveBeenLastCalledWith(fixture.app.id, true);
    controller.abort();
    applied.resolve({});
    const revisionId = await editing;
    expect((await work.repo.getApp(fixture.app.id))?.currentRevision).toBe(
      revisionId,
    );
    expect(applying).toHaveBeenLastCalledWith(fixture.app.id, false);
  });

  it("persists a delayed snapshot to its originating app after the selection changes", async () => {
    const work = workspace();
    const a = await app(work, "A");
    const b = await app(work, "B");
    const snapshot = deferred<AppRecord["state"]>();
    const sourceFrame = frame(vi.fn(() => snapshot.promise));
    select(work, a, sourceFrame);
    const flushing = work.flushState();
    select(work, b, frame());
    snapshot.resolve({ owner: "A", count: 42 });
    await flushing;
    expect((await work.repo.getApp(a.app.id))?.state).toEqual({
      owner: "A",
      count: 42,
    });
    expect((await work.repo.getApp(b.app.id))?.state).toEqual({ owner: "B" });
    expect(work.current?.state).toEqual({ owner: "B" });
  });

  it("rejects an edit if the selected frame changes while its pre-apply snapshot is pending", async () => {
    const work = workspace();
    const a = await app(work, "A");
    const b = await app(work, "B");
    const snapshot = deferred<AppRecord["state"]>();
    const sourceFrame = frame(
      vi
        .fn()
        .mockResolvedValueOnce(a.app.state)
        .mockReturnValueOnce(snapshot.promise),
    );
    const destinationFrame = frame();
    select(work, a, sourceFrame);
    vi.spyOn(work, "verify").mockResolvedValue({
      text: "Verified",
      errors: [],
      revisionId: "candidate",
    });
    const editing = work.applyProject(project, a.revision.id, "Change A");
    const rejection = expect(editing).rejects.toThrow(
      "Application changed before applying",
    );
    await vi.waitFor(() =>
      expect(sourceFrame.request).toHaveBeenCalledTimes(2),
    );
    select(work, b, destinationFrame);
    snapshot.resolve(a.app.state);
    await rejection;
    expect(destinationFrame.request).not.toHaveBeenCalled();
    expect((await work.repo.getApp(a.app.id))?.currentRevision).toBe(
      a.revision.id,
    );
    expect((await work.repo.getApp(b.app.id))?.currentRevision).toBe(
      b.revision.id,
    );
    expect(work.revision?.id).toBe(b.revision.id);
  });

  it("does not redirect a completed apply or its bookkeeping into a newly selected application", async () => {
    const work = workspace();
    const a = await app(work, "A");
    const b = await app(work, "B");
    const applied = deferred<unknown>();
    const sourceFrame = frame(
      vi.fn((method: string) =>
        method === "apply" ? applied.promise : Promise.resolve(a.app.state),
      ),
    );
    const destinationFrame = frame();
    select(work, a, sourceFrame);
    vi.spyOn(work, "verify").mockResolvedValue({
      text: "Verified",
      errors: [],
      revisionId: "candidate",
    });
    const editing = work.applyProject(project, a.revision.id, "Change A");
    await vi.waitFor(() =>
      expect(sourceFrame.request).toHaveBeenCalledWith(
        "apply",
        expect.any(Object),
      ),
    );
    select(work, b, destinationFrame);
    applied.resolve({});
    const accepted = await editing;
    expect((await work.repo.getApp(a.app.id))?.currentRevision).toBe(accepted);
    expect((await work.repo.getApp(b.app.id))?.currentRevision).toBe(
      b.revision.id,
    );
    expect(work.current?.id).toBe(b.app.id);
    expect(work.current?.currentRevision).toBe(b.revision.id);
    expect(work.artifact?.revisionId).toBe(b.revision.id);
    expect(destinationFrame.request).not.toHaveBeenCalled();
  });

  it("an older open request cannot close the frame mounted by a newer open request", async () => {
    const work = workspace();
    const a = await app(work, "A");
    const b = await app(work, "B");
    const c = await app(work, "C");
    const first = deferred<AppRecord["state"]>();
    const second = deferred<AppRecord["state"]>();
    const oldFrame = frame(
      vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    );
    const latestFrame = frame();
    select(work, a, oldFrame);
    mocks.mount.mockResolvedValue(latestFrame);
    const openingB = work.openApp(b.app.id);
    const openingC = work.openApp(c.app.id);
    second.resolve(a.app.state);
    await openingC;
    first.resolve(a.app.state);
    await openingB;
    expect(work.current?.id).toBe(c.app.id);
    expect(work.frame).toBe(latestFrame);
    expect(latestFrame.close).not.toHaveBeenCalled();
    expect(mocks.mount).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("itsalive.lastApp")).toBe(c.app.id);
  });
});

it("does not misreport a committed revision when saving later app activity fails", async () => {
  const work = workspace();
  const fixture = await app(work, "Practice");
  const active = frame(vi.fn(async () => fixture.app.state));
  select(work, fixture, active);
  vi.spyOn(work, "verify").mockResolvedValue({
    text: "Verified",
    errors: [],
    revisionId: "candidate",
  });
  const original = work.repo.updateState.bind(work.repo);
  let writes = 0;
  vi.spyOn(work.repo, "updateState").mockImplementation(async (id, state) => {
    if (++writes === 2) throw new Error("Storage write failed");
    return original(id, state);
  });
  const warning = vi.fn();
  work.onWarning = warning;
  const accepted = await work.applyProject(
    project,
    fixture.revision.id,
    "Change practice",
    artifact("committed-candidate"),
  );
  expect(accepted).toBe("committed-candidate");
  expect((await work.repo.getApp(fixture.app.id))?.currentRevision).toBe(
    accepted,
  );
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("activity could not be saved"),
  );
  expect(await work.repo.listDiagnostics()).toContainEqual(
    expect.objectContaining({
      event: "revision.state-save.failed",
      revisionId: accepted,
    }),
  );
});
