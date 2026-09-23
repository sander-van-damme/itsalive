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
    expect(plan.tasks[1]).toMatchObject({ scope: "#lap-list", dependencies: ["controls"] });

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
});
