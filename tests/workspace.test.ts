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
  return { request, close: vi.fn() } as unknown as FrameSession & {
    request: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
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
