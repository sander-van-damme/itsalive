import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  CodingHarness,
  ScriptedProvider,
  demoAIConfig,
} from "../src/ai";
import type { AIResponse, ToolCall } from "../src/ai";
import type {
  BuildArtifact,
  BuildResult,
  Project,
  RuntimeInspection,
} from "../src/shared/types";
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
  it("repairs confirmed rendered accessibility defects before commit while keeping small text advisory", async () => {
    const provider = new ScriptedProvider([
      turn(
        tool("write_file", { path: project.entry, content: "low contrast" }),
        tool("finish", { summary: "First attempt" }),
      ),
      (input) => {
        expect(JSON.stringify(input.messages)).toContain("text-contrast");
        expect(JSON.stringify(input.messages)).toContain("p#instruction");
        return turn(
          tool("write_file", {
            path: project.entry,
            content: "readable contrast",
          }),
          tool("finish", { summary: "Instructions are readable." }),
        );
      },
    ]);
    const host = callbacks();
    const verify = vi
      .fn<() => Promise<RuntimeInspection>>()
      .mockResolvedValueOnce({
        text: "Instruction",
        errors: [],
        revisionId: "candidate",
        quality: {
          scope: "visible-current-view",
          checkedTextElements: 1,
          checkedControls: 0,
          inconclusive: [],
          issues: [
            {
              code: "text-contrast",
              severity: "error",
              element: "p#instruction",
              message: "Text contrast is 2.32:1; use at least 4.5:1.",
              actual: 2.32,
              expected: 4.5,
            },
          ],
        },
      })
      .mockResolvedValue({
        text: "Instruction",
        errors: [],
        revisionId: "candidate",
        quality: {
          scope: "visible-current-view",
          checkedTextElements: 2,
          checkedControls: 0,
          inconclusive: [
            {
              element: "p#gradient",
              reason: "Gradient needs visual inspection.",
            },
          ],
          issues: [
            {
              code: "small-text",
              severity: "warning",
              element: "small",
              message: "Check readable secondary text.",
              actual: 12,
            },
          ],
        },
      });
    const result = await new CodingHarness(
      new AIService(demoAIConfig(), { providers: { demo: provider } }),
      { ...host, verify },
    ).run({
      project,
      baseRevisionId: "base",
      intent: "Improve readability",
      authorized: true,
      context,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(host.commit).toHaveBeenCalledTimes(1);
    expect(result.project.files[project.entry]).toBe("readable contrast");
  });
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

import { AIError, parseResponse } from "../src/ai/providers";
import type { CodingCheckpoint } from "../src/ai/checkpoint";
const codingRequest = () => ({
  project,
  baseRevisionId: "base",
  intent: "Build violin exercises",
  originalRequest: "I want to learn chords and scales on the violin.",
  authorized: true,
  context,
});
function durableHost() {
  const host = callbacks();
  let saved: CodingCheckpoint | undefined;
  return {
    ...host,
    onEvent: vi.fn(),
    onTool: vi.fn(),
    loadCheckpoint: vi.fn(async () => saved && structuredClone(saved)),
    saveCheckpoint: vi.fn(async (draft: CodingCheckpoint) => {
      saved = structuredClone(draft);
    }),
    clearCheckpoint: vi.fn(async () => {
      saved = undefined;
    }),
    saved: () => saved,
  };
}
function runner(
  provider: ScriptedProvider,
  host: ReturnType<typeof durableHost>,
) {
  return new CodingHarness(
    new AIService(demoAIConfig(), { providers: { demo: provider } }),
    host,
  );
}

describe("recoverable coding sessions", () => {
  it("reproduces max_output_tokens and continues completed tools without replaying a non-idempotent patch", async () => {
    const patch = tool("patch_file", {
      path: project.entry,
      find: "Original",
      replace: "Original extended",
    });
    let incomplete!: AIError;
    try {
      parseResponse({
        id: "response-incomplete",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            status: "completed",
            call_id: patch.id,
            name: patch.name,
            arguments: patch.arguments,
          },
          {
            type: "function_call",
            status: "in_progress",
            call_id: "truncated",
            name: "write_file",
            arguments: '{"path":',
          },
        ],
        usage: { input_tokens: 500, output_tokens: 16384 },
      });
    } catch (error) {
      incomplete = error as AIError;
    }
    expect(incomplete.response?.toolCalls).toHaveLength(1);
    const provider = new ScriptedProvider([
      incomplete,
      turn(tool("finish", { summary: "Violin practice is ready" })),
    ]);
    const host = durableHost();
    const result = await runner(provider, host).run(codingRequest());
    expect(result.project.files[project.entry]).toContain(
      "Original extended</h1>",
    );
    expect(result.project.files[project.entry]).not.toContain(
      "extended extended",
    );
    expect(JSON.stringify(provider.requests[1]!.input.messages)).not.toContain(
      "truncated",
    );
    expect(host.commit).toHaveBeenCalledTimes(1);
    expect(host.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "coding.recovery" }),
    );
  });

  it("restores a saved candidate and original goal after a transport failure in a new harness", async () => {
    const host = durableHost();
    const failed = new ScriptedProvider([
      turn(
        tool("patch_file", {
          path: project.entry,
          find: "Original",
          replace: "Violin Trainer",
        }),
      ),
      new AIError("Connection interrupted", "connection"),
    ]);
    await expect(runner(failed, host).run(codingRequest())).rejects.toThrow(
      "interrupted",
    );
    expect(host.saved()?.project.files[project.entry]).toContain(
      "Violin Trainer",
    );
    expect(host.saved()?.status).toBe("paused");
    expect(host.commit).not.toHaveBeenCalled();
    const resumed = new ScriptedProvider([
      turn(tool("finish", { summary: "Completed violin exercises" })),
    ]);
    const result = await runner(resumed, host).run({
      ...codingRequest(),
      intent: "Try again",
      resume: true,
    });
    expect(result.project.files[project.entry]).toContain("Violin Trainer");
    expect(JSON.stringify(resumed.requests[0]!.input.messages)).toContain(
      "Build violin exercises",
    );
    expect(host.saved()).toBeUndefined();
  });

  it("resumes only uncompleted tools after cancellation between operations", async () => {
    const host = durableHost();
    const abort = new AbortController();
    const save = host.saveCheckpoint.getMockImplementation()!;
    host.saveCheckpoint.mockImplementation(async (draft) => {
      await save(draft);
      if (draft.pending?.next === 1 && !abort.signal.aborted) abort.abort();
    });
    const provider = new ScriptedProvider([
      turn(
        tool("patch_file", {
          path: project.entry,
          find: "Original",
          replace: "Original extended",
        }),
        tool("write_file", {
          path: "src/practice.ts",
          content: "export const scale = 'G major'",
        }),
        tool("finish", { summary: "Violin exercises" }),
      ),
    ]);
    await expect(
      runner(provider, host).run({ ...codingRequest(), signal: abort.signal }),
    ).rejects.toThrow();
    expect(host.saved()?.pending?.next).toBe(1);
    expect(host.saved()?.project.files["src/practice.ts"]).toBeUndefined();
    const resumed = new ScriptedProvider([]);
    const result = await runner(resumed, host).run({
      ...codingRequest(),
      resume: true,
    });
    expect(resumed.requests).toHaveLength(0);
    expect(result.project.files[project.entry]).not.toContain(
      "extended extended",
    );
    expect(result.project.files["src/practice.ts"]).toContain("G major");
    expect(host.commit).toHaveBeenCalledTimes(1);
  });

  it("requires a finish decision and rechecks resumed source rather than trusting a previously successful check", async () => {
    const host = durableHost();
    const failed = new ScriptedProvider([
      turn(
        tool("write_file", {
          path: project.entry,
          content: "Violin exercises",
        }),
        tool("check", {}),
      ),
      new AIError("Network unavailable", "connection"),
    ]);
    await expect(runner(failed, host).run(codingRequest())).rejects.toThrow();
    expect(host.verify).toHaveBeenCalledTimes(1);
    expect(host.commit).not.toHaveBeenCalled();
    const resumed = new ScriptedProvider([
      turn(tool("finish", { summary: "Ready" })),
    ]);
    await runner(resumed, host).run({ ...codingRequest(), resume: true });
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.commit).toHaveBeenCalledTimes(1);
  });

  it("accepts productive work beyond twelve turns and thirty-six tools and reads large source without trimming", async () => {
    const source = "/* meaningful source context */\n".repeat(5000);
    const host = durableHost();
    const provider = new ScriptedProvider([
      turn(tool("write_file", { path: "src/exercises.ts", content: source })),
      turn(tool("read_files", { paths: ["src/exercises.ts"] })),
      ...Array.from({ length: 14 }, (_, index) =>
        turn(
          tool("write_file", {
            path: `src/exercise-${index}.ts`,
            content: `export const practice = ${index};`,
          }),
          tool("read_files", { paths: [project.entry] }),
          tool("list_files", {}),
        ),
      ),
      turn(tool("finish", { summary: "Complete exercises" })),
    ]);
    const result = await runner(provider, host).run(codingRequest());
    expect(result.turns).toBe(17);
    expect(result.project.files["src/exercises.ts"]).toBe(source);
    const read = provider.requests[2]!.input.messages.find(
      (m) => m.role === "tool" && m.content.includes('"files"'),
    )!;
    expect(JSON.parse(read.content).files["src/exercises.ts"]).toBe(source);
    expect(host.commit).toHaveBeenCalledTimes(1);
  });

  it("stops an evidenced no-progress loop while retaining the draft", async () => {
    const host = durableHost();
    const provider = new ScriptedProvider(
      Array.from({ length: 4 }, () => turn(tool("list_files", {}))),
    );
    await expect(runner(provider, host).run(codingRequest())).rejects.toThrow(
      "without progress",
    );
    expect(provider.requests).toHaveLength(3);
    expect(host.commit).not.toHaveBeenCalled();
    expect(host.saved()?.status).toBe("paused");
  });

  it("rebuilds only on actual provider context overflow and preserves the full archived continuation", async () => {
    const host = durableHost();
    const provider = new ScriptedProvider([
      turn(
        tool("write_file", {
          path: project.entry,
          content: "Violin Trainer with chords",
        }),
      ),
      new AIError("Context window exceeded", "context", {
        reason: "context_length_exceeded",
      }),
      (input) => {
        expect(input.messages).toHaveLength(2);
        expect(input.messages[1]!.content).toContain(
          "Violin Trainer with chords",
        );
        expect(input.messages[1]!.content).toContain(
          "I want to learn chords and scales on the violin",
        );
        expect(host.saved()?.archivedContexts?.[0]?.length).toBeGreaterThan(2);
        return turn(tool("finish", { summary: "Completed violin trainer" }));
      },
    ]);
    await runner(provider, host).run(codingRequest());
    expect(host.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "coding.context.rebuilt" }),
    );
  });

  it("does not retry indefinitely if the complete current source exceeds the provider context", async () => {
    const host = durableHost();
    const provider = new ScriptedProvider([
      new AIError("Context window exceeded", "context"),
      new AIError("Still too large", "context"),
    ]);
    await expect(runner(provider, host).run(codingRequest())).rejects.toThrow(
      "Still too large",
    );
    expect(provider.requests).toHaveLength(2);
    expect(host.saved()?.project).toEqual(project);
  });

  it("records a tool handler succeeding separately from compilation and runtime verification outcomes", async () => {
    const host = durableHost();
    host.compile.mockResolvedValueOnce({
      ok: false,
      diagnostics: [{ message: "Private source compile failure" }],
    });
    const provider = new ScriptedProvider([
      turn(
        tool("write_file", { path: project.entry, content: "broken" }),
        tool("check", {}),
      ),
      turn(
        tool("write_file", { path: project.entry, content: "repaired" }),
        tool("finish", { summary: "Fixed" }),
      ),
    ]);
    await runner(provider, host).run(codingRequest());
    expect(host.onTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "check",
        ok: true,
        check: { compiled: false, verified: false, diagnosticCount: 1 },
      }),
    );
    expect(
      JSON.stringify(
        host.onEvent.mock.calls.filter(([event]) => event.level !== "DEBUG"),
      ),
    ).not.toContain("Private source");
    expect(
      JSON.stringify(
        host.onEvent.mock.calls.filter(([event]) => event.level === "DEBUG"),
      ),
    ).toContain("Private source");
    expect(host.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "coding.check",
        data: expect.objectContaining({ compiled: true, verified: true }),
      }),
    );
  });

  it("refuses a saved draft against a changed revision", async () => {
    const host = durableHost();
    await expect(
      runner(new ScriptedProvider([new Error("interrupted")]), host).run(
        codingRequest(),
      ),
    ).rejects.toThrow();
    const provider = new ScriptedProvider([]);
    await expect(
      runner(provider, host).run({
        ...codingRequest(),
        baseRevisionId: "newer",
        resume: true,
      }),
    ).rejects.toThrow("changed after");
    expect(provider.requests).toHaveLength(0);
  });
});

it("pauses before storing a provider replay and retains valid tool-call continuation for retry", async () => {
  const host = durableHost();
  const patch = tool("patch_file", {
    path: project.entry,
    find: "Original",
    replace: "Original extended",
  });
  const provider = new ScriptedProvider([turn(patch), turn(patch)]);
  await expect(runner(provider, host).run(codingRequest())).rejects.toThrow(
    "repeated a completed action",
  );
  const saved = host.saved()!;
  expect(saved.project.files[project.entry]).not.toContain("extended extended");
  expect(
    saved.messages
      .flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.id === patch.id),
  ).toHaveLength(1);
  expect(
    saved.messages.filter((message) => message.toolCallId === patch.id),
  ).toHaveLength(1);
  expect(saved.lastFailure?.reason).toBe("duplicate_tool_call_id");
  const resumed = new ScriptedProvider([
    turn(tool("finish", { summary: "Ready" })),
  ]);
  await runner(resumed, host).run({ ...codingRequest(), resume: true });
  expect(host.commit).toHaveBeenCalledTimes(1);
});

it("stops repeated identical verification failures even when the model varies its completion message", async () => {
  const host = durableHost();
  host.compile.mockResolvedValue({
    ok: false,
    diagnostics: [{ message: "Same syntax error" }],
  });
  const provider = new ScriptedProvider([
    turn(tool("write_file", { path: project.entry, content: "broken source" })),
    ...Array.from({ length: 4 }, (_, index) =>
      turn(tool("finish", { summary: `Attempt ${index}` })),
    ),
  ]);
  await expect(runner(provider, host).run(codingRequest())).rejects.toThrow(
    "same failing application",
  );
  expect(host.compile).toHaveBeenCalledTimes(3);
  expect(host.commit).not.toHaveBeenCalled();
  expect(host.saved()?.lastFailure?.reason).toBe("nonprogress_verification");
});

it("preserves the candidate and stops after repeated incomplete responses without progress", async () => {
  const host = durableHost();
  const interrupted = () =>
    new AIError(
      "Interrupted",
      "response",
      { reason: "max_output_tokens" },
      {
        text: "",
        toolCalls: [],
        completion: {
          status: "incomplete",
          reason: "max_output_tokens",
          recoverable: true,
        },
      },
    );
  const provider = new ScriptedProvider([
    turn(
      tool("write_file", { path: project.entry, content: "Violin progress" }),
    ),
    interrupted(),
    interrupted(),
  ]);
  await expect(runner(provider, host).run(codingRequest())).rejects.toThrow(
    "repeatedly interrupted",
  );
  expect(host.saved()?.project.files[project.entry]).toBe("Violin progress");
  expect(host.commit).not.toHaveBeenCalled();
  expect(provider.requests).toHaveLength(3);
});

it("does not let another browser tab resume and overwrite an active coding session", async () => {
  const provider = new ScriptedProvider([]);
  const host = durableHost();
  const requestLock = vi.fn(
    async (
      _name: string,
      _options: unknown,
      callback: (lock: null) => unknown,
    ) => callback(null),
  );
  vi.stubGlobal("navigator", { locks: { request: requestLock } });
  try {
    await expect(runner(provider, host).run(codingRequest())).rejects.toThrow(
      "another tab",
    );
    expect(host.saveCheckpoint).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("honors a completed finish tool in a second incomplete response after verified progress", async () => {
  const host = durableHost();
  const partial = (...calls: ToolCall[]) =>
    new AIError(
      "Interrupted",
      "response",
      { reason: "max_output_tokens" },
      {
        text: "",
        toolCalls: calls,
        completion: {
          status: "incomplete",
          reason: "max_output_tokens",
          recoverable: true,
        },
      },
    );
  const provider = new ScriptedProvider([
    turn(
      tool("write_file", {
        path: project.entry,
        content: "Working violin trainer",
      }),
    ),
    partial(tool("check", {})),
    partial(tool("finish", { summary: "Violin exercises are complete" })),
  ]);
  const result = await runner(provider, host).run(codingRequest());
  expect(result.revisionId).toBe("accepted");
  expect(host.compile).toHaveBeenCalledTimes(1);
  expect(host.verify).toHaveBeenCalledTimes(1);
  expect(host.commit).toHaveBeenCalledTimes(1);
});

it("repairs a failed live apply from exact failure evidence rather than blindly retrying finish", async () => {
  const host = durableHost();
  host.commit.mockRejectedValueOnce(
    Object.assign(new Error("Hook order changed in Practice"), {
      name: "LiveApplicationError",
      detail: {
        stage: "live-apply",
        rollbackSucceeded: true,
        baseRevisionId: "base",
        candidateRevisionId: "candidate",
      },
    }),
  );
  const provider = new ScriptedProvider([
    turn(
      tool("write_file", { path: project.entry, content: "first candidate" }),
      tool("finish", { summary: "Practice updated" }),
    ),
    (input) => {
      expect(JSON.stringify(input.messages)).toContain(
        "Hook order changed in Practice",
      );
      expect(JSON.stringify(input.messages)).toContain(
        "previous app and durable state were restored",
      );
      return turn(
        tool("inspect", {}),
        tool("write_file", {
          path: project.entry,
          content: "repaired candidate",
        }),
      );
    },
    turn(
      tool("finish", {
        summary:
          "Practice now keeps your current exercise while changing chords.",
      }),
    ),
  ]);
  const result = await runner(provider, host).run(codingRequest());
  expect(host.commit).toHaveBeenCalledTimes(2);
  expect(host.verify).toHaveBeenCalledTimes(2);
  expect(result.project.files[project.entry]).toBe("repaired candidate");
  expect(result.summary).toContain("current exercise");
  expect(host.onEvent).toHaveBeenCalledWith(
    expect.objectContaining({ event: "coding.live_apply.repair" }),
  );
});

it("does not automatically repair when restoration of the previous app is unconfirmed", async () => {
  const host = durableHost();
  const failure = Object.assign(new Error("WebGL update failed"), {
    detail: { stage: "live-apply", rollbackSucceeded: false },
  });
  host.commit.mockRejectedValueOnce(failure);
  const provider = new ScriptedProvider([
    turn(
      tool("write_file", { path: project.entry, content: "candidate" }),
      tool("finish", { summary: "Updated" }),
    ),
  ]);
  await expect(runner(provider, host).run(codingRequest())).rejects.toThrow(
    "WebGL update failed",
  );
  expect(host.commit).toHaveBeenCalledTimes(1);
  expect(host.saved()?.finishRequested).toBe(false);
  expect(host.saved()?.lastFailure?.error?.message).toBe("WebGL update failed");
  expect(host.saved()?.lastFailure?.error?.detail?.rollbackSucceeded).toBe(
    false,
  );
});

it("revisits a legacy saved finish after workflow failure before another commit", async () => {
  const host = durableHost();
  await host.saveCheckpoint({
    version: 1,
    id: "saved",
    appId: "app",
    baseRevisionId: "base",
    intent: "Build violin exercises",
    originalRequest: "Violin",
    role: "coding-standard",
    correlationId: "old",
    createdAt: 1,
    updatedAt: 1,
    project: {
      ...project,
      files: {
        ...project.files,
        "src/activity.ts": "export const practice = true",
      },
    },
    changedFiles: ["src/activity.ts"],
    messages: [],
    turns: 1,
    toolCalls: 1,
    finishRequested: true,
    summary: "Done",
    status: "paused",
    lastFailure: { kind: "workflow" },
  });
  const provider = new ScriptedProvider([
    (input) => {
      expect(host.commit).not.toHaveBeenCalled();
      expect(JSON.stringify(input.messages)).toContain(
        "Do not simply finish again",
      );
      return turn(
        tool("inspect", {}),
        tool("finish", { summary: "Checked the current app before resuming." }),
      );
    },
  ]);
  await runner(provider, host).run({ ...codingRequest(), resume: true });
  expect(provider.requests).toHaveLength(1);
  expect(host.commit).toHaveBeenCalledTimes(1);
});

it("passes progress targets through runtime resolution and records complete tool evidence at DEBUG", async () => {
  const host = {
    ...durableHost(),
    onActivity: vi.fn(async () => ({
      resolved: ["region-2"],
      rejected: ["invented"],
    })),
    onProgress: vi.fn(),
  };
  const provider = new ScriptedProvider([
    turn(
      tool("report_progress", {
        message:
          "I found both tabs were showing the same lesson. I’m separating the exercises.",
        targets: ["region-2", "invented"],
      }),
    ),
    (input) => {
      expect(
        JSON.parse(
          input.messages.find((message) => message.role === "tool")!.content,
        ).rejected,
      ).toEqual(["invented"]);
      return turn(
        tool("write_file", {
          path: project.entry,
          content: "separate learning and practice",
        }),
        tool("finish", {
          summary:
            "Learn explains the chord; Practice now gives you exercises.",
        }),
      );
    },
  ]);
  await runner(provider, host).run(codingRequest());
  expect(host.onActivity).toHaveBeenCalledWith(
    expect.objectContaining({ targets: ["region-2", "invented"] }),
  );
  expect(host.onProgress).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("same lesson"),
    }),
  );
  expect(host.onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "coding.tool.content",
      level: "DEBUG",
      data: expect.objectContaining({
        name: "report_progress",
        arguments: expect.any(String),
        output: expect.stringContaining("invented"),
      }),
    }),
  );
});
