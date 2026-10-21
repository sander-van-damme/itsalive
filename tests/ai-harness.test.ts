import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  CodingHarness,
  ScriptedProvider,
  demoAIConfig,
} from "../src/ai";
import type { AIResponse, ToolCall } from "../src/ai";
import type { BuildArtifact, BuildResult, Project } from "../src/shared/types";
const project: Project = {
  entry: "src/App.tsx",
  dependencies: {},
  lock: {},
  files: {
    "src/App.tsx": "export default function App(){return <h1>Original</h1>}",
  },
};
const artifact: BuildArtifact = {
  entry: project.entry,
  modules: {},
  css: "",
  revisionId: "candidate",
  metrics: {},
};
const context = { appId: "app", correlationId: "trace" };
const tool = (name: string, args: unknown): ToolCall => ({
  id: crypto.randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
const turn = (...toolCalls: ToolCall[]): AIResponse => ({
  text: "",
  toolCalls,
});
function callbacks() {
  return {
    compile: vi.fn(
      async (candidate: Project): Promise<BuildResult> => ({
        ok: true,
        artifact,
        project: candidate,
      }),
    ),
    verify: vi.fn(async () => ({
      text: "New title",
      errors: [],
      revisionId: "candidate",
    })),
    commit: vi.fn(async () => "accepted"),
    inspect: vi.fn(async () => ({
      text: "Original",
      errors: [],
      revisionId: "base",
    })),
  };
}

describe("file-oriented coding harness", () => {
  it("repairs a broken candidate without committing or mutating the working project", async () => {
    const provider = new ScriptedProvider([
      turn(tool("write_file", { path: "src/App.tsx", content: "broken" })),
      turn(tool("finish", { summary: "Attempt" })),
      turn(
        tool("write_file", {
          path: "src/App.tsx",
          content: "export default function App(){return <h1>Fixed</h1>}",
        }),
      ),
      turn(tool("finish", { summary: "Fixed title" })),
    ]);
    const host = callbacks();
    host.compile.mockImplementation(async (candidate) =>
      candidate.files[project.entry] === "broken"
        ? {
            ok: false,
            diagnostics: [{ file: project.entry, message: "Syntax error" }],
          }
        : {
            ok: true,
            artifact,
            project: {
              ...candidate,
              lock: {
                example: { url: "https://example.com/a.js", integrity: "hash" },
              },
            },
          },
    );
    const result = await new CodingHarness(
      new AIService(demoAIConfig(), { providers: { demo: provider } }),
      host,
    ).run({
      project,
      baseRevisionId: "base",
      intent: "Fix title",
      authorized: true,
      context,
    });
    expect(host.commit).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(1);
    expect(result.project.files[project.entry]).toContain("Fixed");
    expect(project.files[project.entry]).toContain("Original");
    expect(result.project.lock.example?.integrity).toBe("hash");
    expect(JSON.stringify(provider.requests[2]?.input.messages)).toContain(
      "Syntax error",
    );
    expect(host.commit).toHaveBeenCalledWith(
      expect.anything(),
      artifact,
      "base",
    );
  });
  it("requires user authorization before any model or tool operation", async () => {
    const provider = new ScriptedProvider([]);
    const host = callbacks();
    const harness = new CodingHarness(
      new AIService(demoAIConfig(), { providers: { demo: provider } }),
      host,
    );
    await expect(
      harness.run({
        project,
        baseRevisionId: "base",
        intent: "Change",
        authorized: false,
        context,
      }),
    ).rejects.toThrow("explicit");
    expect(provider.requests).toHaveLength(0);
    expect(host.compile).not.toHaveBeenCalled();
  });
  it("returns invalid path errors to the model and never edits outside the candidate", async () => {
    const provider = new ScriptedProvider([
      turn(tool("write_file", { path: "../credentials", content: "oops" })),
      turn(
        tool("patch_file", {
          path: "src/App.tsx",
          find: "Original",
          replace: "Safe",
        }),
      ),
      turn(tool("finish", { summary: "Safe edit" })),
    ]);
    const result = await new CodingHarness(
      new AIService(demoAIConfig(), { providers: { demo: provider } }),
      callbacks(),
    ).run({
      project,
      baseRevisionId: "base",
      intent: "Title",
      authorized: true,
      context,
    });
    expect(JSON.stringify(provider.requests[1]?.input.messages)).toContain(
      "traversal",
    );
    expect(Object.keys(result.project.files)).toEqual(["src/App.tsx"]);
  });
  it("honors revision conflict failures at commit", async () => {
    const provider = new ScriptedProvider([
      turn(
        tool("patch_file", {
          path: "src/App.tsx",
          find: "Original",
          replace: "New",
        }),
        tool("finish", { summary: "Title" }),
      ),
    ]);
    const host = callbacks();
    host.commit.mockRejectedValue(new Error("Stale revision"));
    await expect(
      new CodingHarness(
        new AIService(demoAIConfig(), { providers: { demo: provider } }),
        host,
      ).run({
        project,
        baseRevisionId: "base",
        intent: "Title",
        authorized: true,
        context,
      }),
    ).rejects.toThrow("Stale");
  });
  it("runs the demo through real file tools, compilation, verification and commit", async () => {
    const host = callbacks();
    const result = await new CodingHarness(
      new AIService(demoAIConfig()),
      host,
    ).run({
      project,
      baseRevisionId: "base",
      intent: 'Change the title to "A better title"',
      authorized: true,
      context,
    });
    expect(result.project.files[project.entry]).toContain("A better title");
    expect(host.compile).toHaveBeenCalled();
    expect(host.verify).toHaveBeenCalled();
    expect(host.commit).toHaveBeenCalledTimes(1);
  });
});
