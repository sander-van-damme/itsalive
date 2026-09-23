import { describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, parseCodingManagerPlan, parseManagerVerification } from "../src/shell/core/coding-orchestrator";
import { resolveAgentProfile, type AgentProfileId } from "../src/shell/core/agent-profiles";
import type { GenerateRequest } from "../src/shell/core/types";
import type { ExecutionResult } from "../src/shell/core/agent-runner";

const appId = "550e8400-e29b-41d4-a716-446655440000";

function profile(id: AgentProfileId) {
  return resolveAgentProfile(id, { contextCapacity: 64_000, configuredHistoryTokens: 12_000 });
}

describe("coding manager and scoped workers", () => {
  it("parses ordered component tasks and rejects forward dependencies", () => {
    const plan = parseCodingManagerPlan(JSON.stringify({
      shared: {
        design: ["Use one compact card language."],
        state: ["Shared timer state is Alpine-owned."],
      },
      tasks: [
        {
          id: "controls",
          goal: "Build controls",
          scope: "#timer-controls",
          acceptanceCriteria: ["Start works"],
          dependencies: [],
          capabilityIds: [],
          profile: "component-worker",
        },
        {
          id: "laps",
          goal: "Build lap list",
          scope: "#lap-list",
          acceptanceCriteria: ["Laps render"],
          dependencies: ["controls"],
          capabilityIds: [],
          profile: "component-worker",
        },
      ],
    }));
    expect(plan.tasks).toHaveLength(2);
    expect(plan.shared.ref).toBe("shared-v1");
    expect(plan.tasks[1]).toMatchObject({
      scope: "#lap-list",
      dependencies: ["controls"],
      sharedContractRef: "shared-v1",
      parallel: false,
    });

    expect(() => parseCodingManagerPlan(JSON.stringify({
      shared: { design: [], state: [] },
      tasks: [
        {
          id: "first",
          goal: "First",
          scope: "#first",
          acceptanceCriteria: [],
          dependencies: ["later"],
          capabilityIds: [],
        },
        {
          id: "later",
          goal: "Later",
          scope: "#later",
          acceptanceCriteria: [],
          dependencies: [],
          capabilityIds: [],
        },
      ],
    }))).toThrow(/not earlier/);
  });

  it("parses manager integration verification separately from worker results", () => {
    expect(parseManagerVerification('{"ok":true,"summary":"Ready","unresolved":[]}')).toEqual({
      ok: true,
      summary: "Ready",
      unresolved: [],
    });
  });

  it("runs sequential workers with isolated histories and concrete component bindings", async () => {
    const requests: GenerateRequest[] = [];
    let workerRequest = 0;
    const plan = {
      shared: {
        design: ["Use rounded cards with consistent spacing."],
        state: ["Components communicate only through the shared timer store."],
      },
      tasks: [
        {
          id: "header",
          goal: "Build the timer controls.",
          scope: "#timer-controls",
          acceptanceCriteria: ["Start and pause controls are visible."],
          dependencies: [],
          capabilityIds: [],
          profile: "component-worker",
        },
        {
          id: "laps",
          goal: "Build the lap list.",
          scope: "#lap-list",
          acceptanceCriteria: ["Lap rows render from shared state."],
          dependencies: ["header"],
          capabilityIds: [],
          profile: "component-worker",
        },
      ],
    };

    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        requests.push(structuredClone(request));
        if (request.purpose === "coding manager plan") {
          return { text: JSON.stringify(plan), usage: { cost: 0.001 } };
        }
        if (request.purpose === "coding manager integration verification") {
          return { text: '{"ok":true,"summary":"Stopwatch is ready.","unresolved":[]}', usage: { cost: 0.001 } };
        }
        workerRequest++;
        if (workerRequest === 1) {
          return {
            text: 'const workerSecret = "SECRET_WORKER_A_TRANSCRIPT"; return itsalive.done("worker-a");',
            usage: { cost: 0.001 },
          };
        }
        return {
          text: 'return itsalive.done("worker-b");',
          usage: { cost: 0.001 },
        };
      }),
    };

    const ensured = new Set<string>();
    const executedWorkerCode: string[] = [];
    const executor = {
      execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
        if (code.includes("const selectors = ") && code.includes("const overlaps = []")) {
          return { value: [] };
        }

        if (code.includes("childCount: root.children.length")) {
          return {
            value: {
              exists: true,
              childCount: ensured.size,
              children: [...ensured].map(id => ({ tag: "section", id, component: id, building: false, textPreview: id })),
            },
          };
        }

        if (code.includes('component.setAttribute("data-itsalive-building"')) {
          const match = code.match(/document\.getElementById\("([^"]+)"\)/);
          if (match) ensured.add(match[1]!);
          return { value: { ok: true } };
        }

        if (code.includes("buildingCount:") && code.includes("component.hasAttribute('inert')")) {
          const scope = code.includes("#timer-controls") ? "timer" : "laps";
          return {
            value: {
              html: scope === "timer" ? "<button>Start</button><button>Pause</button>" : "<ol><li>Lap 1</li></ol>",
              buildingCount: 0,
              inert: false,
              ariaBusy: "false",
            },
          };
        }

        if (code.includes("Assigned component scope not found")) {
          executedWorkerCode.push(code);
          if (code.includes("#timer-controls")) {
            return {
              done: true,
              message: JSON.stringify({
                changed: ["Timer controls built"],
                verified: ["Start and pause controls are visible"],
                unresolved: [],
                sharedContractChanges: [],
              }),
            };
          }
          return {
            done: true,
            message: JSON.stringify({
              changed: ["Lap list built"],
              verified: ["Lap rows render from shared state"],
              unresolved: [],
              sharedContractChanges: [],
            }),
          };
        }

        throw new Error("Unexpected executor command: " + code.slice(0, 120));
      }),
    };

    const db = {
      history: {
        forApp: vi.fn(async () => { throw new Error("worker leaked into durable app history"); }),
        add: vi.fn(async () => { throw new Error("worker wrote durable app history"); }),
      },
    };

    const managerTrace = {
      runId: "manager-run",
      agentId: "manager-agent",
      role: "coding-manager",
      profile: "coding-manager",
      scope: appId,
    };

    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await new CodingOrchestrator(db as never, providers as never, executor).run({
      appId,
      appPrompt: "A stopwatch with laps.",
      technicalIntent: "TECHNICAL INTENT\nBuild a usable stopwatch with controls and lap history.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace,
    });

    expect(result).toMatchObject({
      status: "done",
      message: "Stopwatch is ready.",
      workerTurns: 2,
      handoffs: [
        { status: "done", scope: "#timer-controls", changed: ["Timer controls built"] },
        { status: "done", scope: "#lap-list", changed: ["Lap list built"] },
      ],
    });

    const workerRequests = requests.filter(request => request.purpose === "agent turn 1");
    expect(workerRequests).toHaveLength(2);
    const firstContext = workerRequests[0]!.messages.map(message => message.content).join("\n");
    const secondContext = workerRequests[1]!.messages.map(message => message.content).join("\n");

    expect(firstContext).toContain("ASSIGNED SCOPE\n#timer-controls");
    expect(secondContext).toContain("ASSIGNED SCOPE\n#lap-list");
    expect(secondContext).toContain("Timer controls built");
    expect(secondContext).not.toContain("SECRET_WORKER_A_TRANSCRIPT");
    expect(secondContext).not.toContain("const workerSecret");

    expect(workerRequests[0]!.trace).toMatchObject({
      parentRunId: "manager-run",
      parentAgentId: "manager-agent",
      scope: "#timer-controls",
      role: "component-worker",
      profile: "component-worker",
    });
    expect(workerRequests[1]!.trace).toMatchObject({
      parentRunId: "manager-run",
      parentAgentId: "manager-agent",
      scope: "#lap-list",
    });

    expect(executedWorkerCode).toHaveLength(2);
    expect(executedWorkerCode[0]).toContain('const component = document.querySelector("#timer-controls")');
    expect(executedWorkerCode[1]).toContain('const component = document.querySelector("#lap-list")');
    expect(executedWorkerCode[0]).toContain("SECRET_WORKER_A_TRANSCRIPT");

    const verifyRequest = requests.find(request => request.purpose === "coding manager integration verification")!;
    const verifyContext = verifyRequest.messages.map(message => message.content).join("\n");
    expect(verifyContext).toContain("Timer controls built");
    expect(verifyContext).toContain("Lap list built");
    expect(verifyContext).not.toContain("SECRET_WORKER_A_TRANSCRIPT");

    expect(db.history.forApp).not.toHaveBeenCalled();
    expect(db.history.add).not.toHaveBeenCalled();
  });
  it("runs independent scopes concurrently and waits for dependencies before the next wave", async () => {
    const requests: GenerateRequest[] = [];
    const started: string[] = [];
    const finished: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    let bothStarted!: () => void;
    const bothStartedPromise = new Promise<void>(resolve => { bothStarted = resolve; });

    const plan = {
      shared: { ref: "shared-v2", design: ["Same card language"], state: ["Read shared state; do not rewrite schema"] },
      tasks: [
        {
          id: "a", goal: "Build A", scope: "#component-a", acceptanceCriteria: ["A ready"],
          dependencies: [], capabilityIds: [], profile: "component-worker",
          sharedContractRef: "shared-v2", parallel: true,
        },
        {
          id: "b", goal: "Build B", scope: "#component-b", acceptanceCriteria: ["B ready"],
          dependencies: [], capabilityIds: [], profile: "component-worker",
          sharedContractRef: "shared-v2", parallel: true,
        },
        {
          id: "c", goal: "Integrate C", scope: "#component-c", acceptanceCriteria: ["C ready"],
          dependencies: ["a", "b"], capabilityIds: [], profile: "component-worker",
          sharedContractRef: "shared-v2", parallel: true,
        },
      ],
    };

    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        requests.push(structuredClone(request));
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0.001 } };
        if (request.purpose === "coding manager integration verification") {
          return { text: '{"ok":true,"summary":"Parallel build ready.","unresolved":[]}', usage: { cost: 0.001 } };
        }
        const scope = request.trace?.scope;
        if (scope === "#component-a") {
          started.push("a");
          if (started.includes("b")) bothStarted();
          await gateA;
          finished.push("a");
          return { text: 'return itsalive.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"A built\\"],\\"verified\\":[\\"A ready\\"]}");', usage: { cost: 0.002 } };
        }
        if (scope === "#component-b") {
          started.push("b");
          if (started.includes("a")) bothStarted();
          await gateB;
          finished.push("b");
          return { text: 'return itsalive.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"B built\\"],\\"verified\\":[\\"B ready\\"]}");', usage: { cost: 0.002 } };
        }
        if (scope === "#component-c") {
          expect(finished.sort()).toEqual(["a", "b"]);
          started.push("c");
          return { text: 'return itsalive.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"C built\\"],\\"verified\\":[\\"C ready\\"]}");', usage: { cost: 0.002 } };
        }
        throw new Error("Unexpected generation request");
      }),
    };

    const ensured = new Set<string>();
    const executor = parallelExecutor(ensured);
    const db = isolatedDb();
    const orchestrator = new CodingOrchestrator(db as never, providers as never, executor);
    const run = orchestrator.run({
      appId,
      appPrompt: "Three component app",
      technicalIntent: "Build A and B independently, then C after both.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
      maxParallelWorkers: 3,
    });

    await bothStartedPromise;
    expect(started.sort()).toEqual(["a", "b"]);
    expect(started).not.toContain("c");
    releaseA();
    releaseB();

    const result = await run;
    expect(result).toMatchObject({ status: "done", workerTurns: 3 });
    expect(started).toContain("c");
    expect(result.timeline).toHaveLength(3);

    const a = result.timeline.find(item => item.taskId === "a")!;
    const b = result.timeline.find(item => item.taskId === "b")!;
    const c = result.timeline.find(item => item.taskId === "c")!;
    expect(Math.max(a.startedAt, b.startedAt)).toBeLessThanOrEqual(Math.min(a.endedAt, b.endedAt));
    expect(c.startedAt).toBeGreaterThanOrEqual(Math.max(a.endedAt, b.endedAt));

    const cRequest = requests.find(request => request.trace?.scope === "#component-c")!;
    const cContext = cRequest.messages.map(message => message.content).join("\n");
    expect(cContext).toContain("A built");
    expect(cContext).toContain("B built");
  });

  it("serializes parallel-declared tasks that own the same scope", async () => {
    const starts: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [] },
      tasks: [
        {
          id: "first", goal: "First edit", scope: "#shared-scope", acceptanceCriteria: ["first"],
          dependencies: [], capabilityIds: [], profile: "component-worker",
          sharedContractRef: "shared-v1", parallel: true,
        },
        {
          id: "second", goal: "Second edit", scope: "#shared-scope", acceptanceCriteria: ["second"],
          dependencies: [], capabilityIds: [], profile: "component-worker",
          sharedContractRef: "shared-v1", parallel: true,
        },
      ],
    };
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          return { text: '{"ok":true,"summary":"ready","unresolved":[]}', usage: { cost: 0 } };
        }
        const taskText = request.messages.map(message => message.content).join("\n");
        if (taskText.includes("TASK ID\nfirst")) {
          starts.push("first");
          await firstGate;
          return { text: 'return itsalive.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0 } };
        }
        starts.push("second");
        return { text: 'return itsalive.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0 } };
      }),
    };
    const orchestrator = new CodingOrchestrator(isolatedDb() as never, providers as never, parallelExecutor(new Set()));
    const run = orchestrator.run({
      appId,
      appPrompt: "One shared region",
      technicalIntent: "Apply two ordered edits.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
    });

    await vi.waitFor(() => expect(starts).toEqual(["first"]));
    expect(starts).not.toContain("second");
    releaseFirst();
    await expect(run).resolves.toMatchObject({ status: "done" });
    expect(starts).toEqual(["first", "second"]);
  });

  it("preserves a successful sibling when another parallel worker fails", async () => {
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [] },
      tasks: [
        {
          id: "good", goal: "Good component", scope: "#good", acceptanceCriteria: ["good"],
          dependencies: [], capabilityIds: [], profile: "component-worker",
          sharedContractRef: "shared-v1", parallel: true,
        },
        {
          id: "bad", goal: "Bad component", scope: "#bad", acceptanceCriteria: ["bad"],
          dependencies: [], capabilityIds: [], profile: "component-worker",
          sharedContractRef: "shared-v1", parallel: true,
        },
      ],
    };
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          return { text: '{"ok":false,"summary":"One component failed.","unresolved":["bad"]}', usage: { cost: 0 } };
        }
        if (request.trace?.scope === "#bad") throw new Error("worker B exploded");
        return { text: 'return itsalive.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"good survived\\"]}");', usage: { cost: 0 } };
      }),
    };

    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, parallelExecutor(new Set())).run({
      appId,
      appPrompt: "Sibling components",
      technicalIntent: "Build both.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
    });

    expect(result).toMatchObject({ status: "manager-verification-failed", message: "One component failed." });
    expect(result.handoffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "done", scope: "#good", changed: ["good survived"] }),
      expect.objectContaining({ status: "failed", scope: "#bad", unresolved: ["worker B exploded"] }),
    ]));
  });

  it("cascades parent cancellation to all active parallel workers", async () => {
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [] },
      tasks: ["a", "b"].map(id => ({
        id, goal: id, scope: "#" + id, acceptanceCriteria: [], dependencies: [], capabilityIds: [],
        profile: "component-worker", sharedContractRef: "shared-v1", parallel: true,
      })),
    };
    let active = 0;
    let bothActive!: () => void;
    const bothActivePromise = new Promise<void>(resolve => { bothActive = resolve; });
    const aborted: string[] = [];
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        const scope = request.trace?.scope ?? "";
        active++;
        if (active === 2) bothActive();
        return new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            aborted.push(scope);
            reject(request.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }),
    };
    const parent = new AbortController();
    const run = new CodingOrchestrator(isolatedDb() as never, providers as never, parallelExecutor(new Set())).run({
      appId,
      appPrompt: "Cancelable",
      technicalIntent: "Build two pieces.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
      signal: parent.signal,
    });

    await bothActivePromise;
    parent.abort(new DOMException("parent stopped", "AbortError"));
    await expect(run).rejects.toMatchObject({ name: "AbortError", message: "parent stopped" });
    expect(aborted.sort()).toEqual(["#a", "#b"]);
  });


  it("accounts concurrent worker spend against the shared parent cost budget", async () => {
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [] },
      tasks: ["a", "b"].map(id => ({
        id, goal: id, scope: "#" + id, acceptanceCriteria: [], dependencies: [], capabilityIds: [],
        profile: "component-worker", sharedContractRef: "shared-v1", parallel: true,
      })),
    };
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          throw new Error("verification should not run after shared budget exhaustion");
        }
        return { text: 'return itsalive.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0.003 } };
      }),
    };
    const manager = profile("coding-manager");
    manager.budgets = { ...manager.budgets, maxCostUsd: 0.005 };

    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, parallelExecutor(new Set())).run({
      appId,
      appPrompt: "Budgeted parallel build",
      technicalIntent: "Build two components.",
      managerProfile: manager,
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
    });

    expect(result).toMatchObject({ status: "cost-budget", workerTurns: 2 });
    expect(result.handoffs).toHaveLength(2);
  });

function managerTrace() {
  return {
    runId: "manager-run",
    agentId: "manager-agent",
    role: "coding-manager",
    profile: "coding-manager",
    scope: appId,
  };
}

function isolatedDb() {
  return {
    history: {
      forApp: vi.fn(async () => { throw new Error("worker leaked into durable app history"); }),
      add: vi.fn(async () => { throw new Error("worker wrote durable app history"); }),
    },
  };
}

function parallelExecutor(ensured: Set<string>) {
  return {
    execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
      if (code.includes("const selectors = ") && code.includes("const overlaps = []")) return { value: [] };
      if (code.includes("childCount: root.children.length")) {
        return {
          value: {
            exists: true,
            childCount: ensured.size,
            children: [...ensured].map(id => ({ tag: "section", id, component: id, building: false, textPreview: id })),
          },
        };
      }
      if (code.includes('component.setAttribute("data-itsalive-building"')) {
        const match = code.match(/document\.getElementById\("([^"]+)"\)/);
        if (match) ensured.add(match[1]!);
        return { value: { ok: true } };
      }
      if (code.includes("buildingCount:") && code.includes("component.hasAttribute('inert')")) {
        return { value: { html: "<div>ready</div>", buildingCount: 0, inert: false, ariaBusy: "false" } };
      }
      if (code.includes("Assigned component scope not found")) {
        const messageMatch = code.match(/itsalive\.done\("((?:\\.|[^"])*)"\)/);
        const message = messageMatch ? JSON.parse('"' + messageMatch[1] + '"') : undefined;
        return { done: true, ...(message ? { message } : {}) };
      }
      throw new Error("Unexpected executor command: " + code.slice(0, 160));
    }),
  };
}

});
