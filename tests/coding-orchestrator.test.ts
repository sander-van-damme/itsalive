import { describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, parseCodingManagerPlan, parseManagerVerification } from "../src/shell/core/coding-orchestrator";
import { resolveAgentProfile, type AgentProfileId } from "../src/shell/core/agent-profiles";
import type { GenerateRequest } from "../src/shell/core/types";
import type { ExecutionResult } from "../src/shell/core/agent-runner";
import { technicalContractForPlan, type AppTechnicalContract } from "../src/shell/core/app-contract";

const appId = "550e8400-e29b-41d4-a716-446655440000";

function profile(id: AgentProfileId) {
  return resolveAgentProfile(id, { contextCapacity: 64_000, configuredHistoryTokens: 12_000 });
}

describe("coding manager and scoped workers", () => {
  it("parses ordered component tasks and rejects forward dependencies", () => {
    const plan = parseCodingManagerPlan(JSON.stringify({
      shared: {
        design: ["Use one compact card language."],
        state: ["Shared timer state uses application.store."],
        stores: ["sharedTimer"],
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
    expect(plan.shared.stores).toEqual(["sharedTimer"]);
    expect(plan.tasks[0]).toMatchObject({ idPrefix: "timer-controls-", storeNamespace: "timer_controls" });
    expect(plan.tasks[1]).toMatchObject({
      scope: "#lap-list",
      dependencies: ["controls"],
      sharedContractRef: "shared-v1",
      idPrefix: "lap-list-",
      storeNamespace: "lap_list",
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

    const normalized = parseCodingManagerPlan(JSON.stringify({
      shared: { design: [], state: [], stores: ["counter"] },
      tasks: [
        { id: "counter", goal: "Counter", scope: "#counter", acceptanceCriteria: [], dependencies: [], capabilityIds: [] },
        { id: "hyphen", goal: "Hyphen", scope: "#same-name", acceptanceCriteria: [], dependencies: [], capabilityIds: [] },
        { id: "underscore", goal: "Underscore", scope: "#same_name", acceptanceCriteria: [], dependencies: [], capabilityIds: [] },
      ],
    }));
    expect(normalized.tasks.map(task => task.storeNamespace)).toEqual(["counter_2", "same_name", "same_name_2"]);
    expect(normalized.tasks.map(task => task.idPrefix)).toEqual(["counter-", "same-name-", "same_name-"]);
  });

  it("preserves the Movie Night contract across sequential modifications and a repair, and rejects silent field drift", () => {
    const shared = {
      ref: "movie-v1",
      design: ["Warm cinematic cards"],
      stores: ["sharedStore"],
      state: [
        "application.store.sharedStore.movies: array of { id, title, genre, durationMin }",
        "application.store.sharedStore.tonightId: movie id or null",
      ],
      stableDomIds: ["movie-night-app", "add-movie-form", "movie-shortlist", "tonight-section"],
      semantics: ["durationMin is a whole number of minutes"],
    };
    const makePlan = (goal: string, profile: "component-worker" | "repair-worker" = "component-worker") => JSON.stringify({
      shared,
      contractChange: null,
      tasks: [{
        id: "movie",
        goal,
        scope: "#movie-night-app",
        acceptanceCriteria: ["Movie planner works"],
        dependencies: [],
        capabilityIds: [],
        profile,
        sharedContractRef: "movie-v1",
        parallel: false,
      }],
    });

    const initial = parseCodingManagerPlan(makePlan("Build the movie planner"));
    let established: AppTechnicalContract = technicalContractForPlan(undefined, initial.shared);
    expect(established).toMatchObject({
      revision: 1,
      shared: {
        ref: "movie-v1",
        stores: ["sharedStore"],
        stableDomIds: expect.arrayContaining(["movie-night-app", "movie-shortlist", "tonight-section"]),
      },
    });

    const completed = parseCodingManagerPlan(makePlan("Complete the app"), established);
    expect(technicalContractForPlan(established, completed.shared)).toBe(established);

    const ratings = parseCodingManagerPlan(makePlan("Add ratings and sorting without changing shared schema"), established);
    expect(technicalContractForPlan(established, ratings.shared)).toBe(established);

    const repaired = parseCodingManagerPlan(makePlan("Repair the broken buttons", "repair-worker"), established);
    expect(technicalContractForPlan(established, repaired.shared)).toBe(established);
    expect(repaired.tasks[0]?.profile).toBe("repair-worker");

    const drifted = {
      ...shared,
      state: [
        "application.store.movieStore.movies: array of { id, title, genre, durationMinutes }",
        "application.store.movieStore.tonightPickId: movie id or null",
      ],
      stores: ["movieStore"],
    };
    expect(() => parseCodingManagerPlan(JSON.stringify({
      shared: drifted,
      contractChange: null,
      tasks: [{
        id: "movie",
        goal: "Repair it",
        scope: "#movie-night-app",
        acceptanceCriteria: ["works"],
        dependencies: [],
        capabilityIds: [],
        profile: "repair-worker",
        sharedContractRef: "movie-v1",
      }],
    }), established)).toThrow(/changed the established app contract without a valid contractChange/);

    const explicitChange = parseCodingManagerPlan(JSON.stringify({
      shared: {
        ...shared,
        state: [...shared.state, "application.store.sharedStore.ratings: object keyed by movie id"],
        semantics: [...shared.semantics, "rating is an integer from 1 to 5"],
      },
      contractChange: {
        reason: "Ratings need durable shared state used by shortlist and stats.",
        affectedScopes: ["#movie-night-app"],
        changes: [
          {
            kind: "state",
            path: "application.store.sharedStore.ratings",
            description: "Add durable ratings map",
            to: "object keyed by movie id",
          },
          {
            kind: "semantic",
            path: "rating",
            description: "Define the rating scale",
            to: "integer 1..5",
          },
        ],
      },
      tasks: [{
        id: "movie",
        goal: "Add ratings",
        scope: "#movie-night-app",
        acceptanceCriteria: ["ratings persist"],
        dependencies: [],
        capabilityIds: [],
        profile: "component-worker",
        sharedContractRef: "movie-v1",
      }],
    }), established);
    established = technicalContractForPlan(established, explicitChange.shared);
    expect(established.revision).toBe(2);
    expect(explicitChange.contractChange?.changes.map(change => change.kind)).toEqual(["state", "semantic"]);
  });

  it("accepts raw and common Markdown JSON fences without accepting trailing prose", () => {
    const planJson = JSON.stringify({
      shared: { ref: "shared-v1", design: [], state: [], stores: [] },
      tasks: [{ id: "main", goal: "Build", scope: "#main", acceptanceCriteria: [], dependencies: [], capabilityIds: [] }],
    });

    expect(parseCodingManagerPlan(planJson).tasks[0]?.id).toBe("main");
    expect(parseCodingManagerPlan(`\`\`\`json\n${planJson}\n\`\`\``).tasks[0]?.id).toBe("main");
    expect(parseCodingManagerPlan(`~~~json\n${planJson}\n~~~`).tasks[0]?.id).toBe("main");
    expect(() => parseCodingManagerPlan(`\`\`\`json\n${planJson}\n\`\`\`\nextra`)).toThrow(/invalid JSON/);
  });

  it("accepts fenced manager integration verification", () => {
    const verification = '{"ok":true,"summary":"Ready","unresolved":[]}';
    expect(parseManagerVerification(`\`\`\`json\n${verification}\n\`\`\``)).toEqual({
      ok: true,
      summary: "Ready",
      unresolved: [],
    });
    expect(parseManagerVerification(`~~~json\n${verification}\n~~~`)).toEqual({
      ok: true,
      summary: "Ready",
      unresolved: [],
    });
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
            text: 'const workerSecret = "SECRET_WORKER_A_TRANSCRIPT"; return agent.done("worker-a");',
            usage: { cost: 0.001 },
          };
        }
        return {
          text: 'return agent.done("worker-b");',
          usage: { cost: 0.001 },
        };
      }),
    };

    const ensured = new Set<string>();
    const executedWorkerCode: string[] = [];
    const executor = {
      execute: vi.fn(async (_id: string, code: string): Promise<ExecutionResult> => {
        if (code.includes("itsalive:integration-scope-evidence")) {
          return { value: [
            { scope: "#timer-controls", exists: true, meaningfulUi: true, nestedBuildingCount: 0, buildOwner: null, rootBuilding: false, ariaBusy: null, durabilityAvailable: true, runtimeOnlyEventListenerCount: 0 },
            { scope: "#lap-list", exists: true, meaningfulUi: true, nestedBuildingCount: 0, buildOwner: null, rootBuilding: false, ariaBusy: null, durabilityAvailable: true, runtimeOnlyEventListenerCount: 0 },
          ] };
        }
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

        if (code.includes('component.setAttribute("data-itsalive-build-owner"') || code.includes('component.removeAttribute("data-itsalive-build-owner"')) {
          const match = code.match(/document\.getElementById\("([^"]+)"\)/);
          if (match) ensured.add(match[1]!);
          return { value: { ok: true } };
        }

        if (code.includes("buildingCount:") && code.includes("component.hasAttribute('inert')")) {
          const scope = code.includes("#timer-controls") ? "timer" : "laps";
          return {
            value: {
              html: scope === "timer" ? "<button>Start</button><button>Pause</button>" : "<ol><li>Lap 1</li></ol>",
              buildingCount: 1,
              nestedBuildingCount: 0,
              buildOwner: "shell",
              inert: true,
              ariaBusy: "true",
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
    const completionAssessor = vi.fn(async (state: import('../src/shell/core/agent-runner').CompletionAssessmentState) => {
      void state;
      return { action: "uncertain" as const, reason: "evidence-uncertain" };
    });

    const result = await new CodingOrchestrator(db as never, providers as never, executor).run({
      appId,
      appPrompt: "A stopwatch with laps.",
      technicalIntent: "TECHNICAL INTENT\nBuild a usable stopwatch with controls and lap history.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace,
      triggerRoute: "debug",
      preferredWorkerProfile: "repair-worker",
      completionAssessor,
      portablePreferences: [{
        id: "pref-keyboard",
        label: "Keyboard-first interaction",
        context: "Prefer keyboard-efficient interaction and visible focus while preserving pointer access.",
      }],
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

    const managerRequest = requests.find(request => request.purpose === "coding manager plan")!;
    const managerContext = managerRequest.messages.map(message => message.content).join("\n");
    expect(managerContext).toContain("AVAILABLE PLATFORM APIS");
    expect(managerContext).toContain("application.ai.decide(question: string, context?: JsonValue): Promise<boolean | null>");
    expect(managerContext).toContain("application.store: JsonObject");
    expect(managerContext).toContain("ROUTING HINT");
    expect(managerContext).toContain('"route":"debug"');
    expect(managerContext).toContain('"preferredWorkerProfile":"repair-worker"');
    expect(managerContext).toContain("PORTABLE SHELL PREFERENCES");
    expect(managerContext).toContain("Keyboard-first interaction");
    expect(managerContext).toContain("visible focus");
    expect(managerContext).not.toContain("Budget Pal");
    expect(managerContext).not.toContain("raw history");
    expect(managerRequest.system).toContain("owning scope prefix");
    expect(managerRequest.system).toContain("omit targetIds");

    const workerRequests = requests.filter(request => request.purpose === "agent turn 1");
    expect(workerRequests).toHaveLength(2);
    expect(workerRequests[0]!.system).toContain("JavaScript console");
    expect(workerRequests[0]!.system).toContain("return agent.done(JSON.stringify(handoff))");
    expect(workerRequests[0]!.system).toContain("Prefer read-only verification");
    expect(workerRequests[0]!.system).toContain("await agent.verify");
    expect(workerRequests[0]!.system).toContain("Durable data belongs in application.store");
    expect(workerRequests[0]!.system).toContain("transient command listeners");
    const firstContext = workerRequests[0]!.messages.map(message => message.content).join("\n");
    const secondContext = workerRequests[1]!.messages.map(message => message.content).join("\n");

    expect(firstContext).toContain("ASSIGNED SCOPE\n#timer-controls");
    expect(firstContext).toContain("DOM ID PREFIX\ntimer-controls-");
    expect(firstContext).toContain("STORE NAMESPACE\ntimer_controls");
    expect(firstContext).toContain("SELECTED PLATFORM API HELP");
    expect(firstContext).toContain("agent.verify<T>(work: () => T | Promise<T>): Promise<T>");
    expect(firstContext).toContain("temporary DOM and application.store mutations are always rolled back");
    expect(secondContext).toContain("ASSIGNED SCOPE\n#lap-list");
    expect(secondContext).toContain("DOM ID PREFIX\nlap-list-");
    expect(secondContext).toContain("STORE NAMESPACE\nlap_list");
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

    expect(completionAssessor).toHaveBeenCalledTimes(2);
    expect(completionAssessor.mock.calls.map(([state]) => state.evidence.buildingCount)).toEqual([0, 0]);
    expect(db.history.forApp).not.toHaveBeenCalled();
    expect(db.history.add).not.toHaveBeenCalled();
  });
  it("keeps completed controls interactive even when final checking reports a false negative", async () => {
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [], stores: [] },
      tasks: [{
        id: "movie-form",
        goal: "Build the movie form",
        scope: "#movie-form",
        acceptanceCriteria: ["The Add button works"],
        dependencies: [],
        capabilityIds: [],
        profile: "component-worker",
        sharedContractRef: "shared-v1",
        parallel: false,
      }],
    };
    const requests: GenerateRequest[] = [];
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        requests.push(structuredClone(request));
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          return {
            text: JSON.stringify({
              summary: "The form is ready.",
              concerns: [{
                kind: "deterministic",
                scope: "#movie-form",
                fact: "exists",
                reason: "The component is absent.",
              }],
            }),
            usage: { cost: 0 },
          };
        }
        return {
          text: 'return agent.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"form works\\"],\\"verified\\":[\\"Add button works\\"]}");',
          usage: { cost: 0 },
        };
      }),
    };
    const executor = parallelExecutor(new Set<string>());
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, executor).run({
      appId,
      appPrompt: "Movie planner",
      technicalIntent: "Build a working add-movie form.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
    });

    expect(result).toMatchObject({
      status: "done",
      message: "The form is ready.",
      handoffs: [expect.objectContaining({ status: "done", scope: "#movie-form" })],
    });

    const lifecycleCommands = executor.execute.mock.calls
      .map(([, code]) => String(code))
      .filter(code => code.includes("data-itsalive-build-state") || code.includes("data-itsalive-building"));

    expect(lifecycleCommands.length).toBeGreaterThan(0);
    expect(lifecycleCommands.some(code => code.includes('setAttribute("inert"'))).toBe(false);
    expect(lifecycleCommands.some(code => code.includes('removeAttribute("inert")'))).toBe(true);

    const workerRequest = requests.find(request => request.purpose?.startsWith("agent turn"));
    expect(workerRequest?.system).toContain("shell owns build/progress attributes");
    expect(workerRequest?.system).not.toContain("region is inert");
    expect(workerRequest?.system).not.toContain("setAttribute(\"inert\")");
  });

  it("lets current deterministic scope evidence override a stale blocked handoff when final verification confirms the app works", async () => {
    const requests: GenerateRequest[] = [];
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [], stores: [] },
      tasks: [{
        id: "grocery",
        goal: "Build the grocery list",
        scope: "#grocery-list",
        acceptanceCriteria: ["Items can be added and shown"],
        dependencies: [],
        capabilityIds: [],
        profile: "component-worker",
        sharedContractRef: "shared-v1",
        parallel: false,
      }],
    };
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        requests.push(structuredClone(request));
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          return { text: '{"ok":true,"summary":"The grocery list is ready.","unresolved":[]}', usage: { cost: 0 } };
        }
        return {
          text: 'return agent.done(JSON.stringify({status:"blocked",changed:["UI is present"],verified:["Current controls render"],unresolved:["completion transport was interrupted"]}));',
          usage: { cost: 0 },
        };
      }),
    };
    const ensured = new Set<string>();
    const base = parallelExecutor(ensured);
    const executor = {
      execute: vi.fn(async (id: string, code: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<ExecutionResult> => {
        if (code.includes("Assigned component scope not found") && code.includes("JSON.stringify")) {
          return {
            done: true,
            message: JSON.stringify({
              status: "blocked",
              changed: ["UI is present"],
              verified: ["Current controls render"],
              unresolved: ["completion transport was interrupted"],
            }),
          };
        }
        void options;
        return base.execute(id, code);
      }),
    };

    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, executor).run({
      appId,
      appPrompt: "Grocery list",
      technicalIntent: "Build a working grocery list.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
    });

    expect(result).toMatchObject({
      status: "done",
      message: "The grocery list is ready.",
      handoffs: [expect.objectContaining({ status: "blocked", scope: "#grocery-list" })],
      verificationEvidence: [expect.objectContaining({ scope: "#grocery-list", ok: true, runtimeOnlyEventListenerCount: 0 })],
    });
    const verifyRequest = requests.find(request => request.purpose === "coding manager integration verification")!;
    const verifyContext = verifyRequest.messages.map(message => message.content).join("\n");
    expect(verifyContext).toContain("CURRENT SCOPE EVIDENCE");
    expect(verifyContext).toContain('"scope":"#grocery-list"');
    expect(verifyRequest.system).toContain("Current deterministic evidence is authoritative");
    expect(verifyRequest.system).toContain("Handoff status is historical diagnostic evidence");
  });

  it("runs independent scopes concurrently and waits for dependencies before the next wave", async () => {
    const requests: GenerateRequest[] = [];
    const started: string[] = [];
    const finished: string[] = [];
    const lifecycles: Array<Record<string, number | string>> = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    let bothStarted!: () => void;
    const bothStartedPromise = new Promise<void>(resolve => { bothStarted = resolve; });

    const plan = {
      shared: { ref: "shared-v2", design: ["Same card language"], state: ["Read shared state; do not rewrite schema"], stores: ["sharedApp"] },
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
          return { text: 'return agent.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"A built\\"],\\"verified\\":[\\"A ready\\"]}");', usage: { cost: 0.002 } };
        }
        if (scope === "#component-b") {
          started.push("b");
          if (started.includes("a")) bothStarted();
          await gateB;
          finished.push("b");
          return { text: 'return agent.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"B built\\"],\\"verified\\":[\\"B ready\\"]}");', usage: { cost: 0.002 } };
        }
        if (scope === "#component-c") {
          expect(finished.sort()).toEqual(["a", "b"]);
          started.push("c");
          return { text: 'return agent.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"C built\\"],\\"verified\\":[\\"C ready\\"]}");', usage: { cost: 0.002 } };
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
      onLifecycle: summary => lifecycles.push(structuredClone(summary) as unknown as Record<string, number | string>),
    });

    await bothStartedPromise;
    expect(started.sort()).toEqual(["a", "b"]);
    expect(started).not.toContain("c");
    releaseA();
    await vi.waitFor(() => {
      expect(lifecycles).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: "working", total: 3, ready: 1, building: 1, queued: 1 }),
      ]));
    });
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

    const aRequest = requests.find(request => request.trace?.scope === "#component-a")!;
    const bRequest = requests.find(request => request.trace?.scope === "#component-b")!;
    const aContext = aRequest.messages.map(message => message.content).join("\n");
    const bContext = bRequest.messages.map(message => message.content).join("\n");
    expect(aContext).toContain("DOM ID PREFIX\ncomponent-a-");
    expect(aContext).toContain("STORE NAMESPACE\ncomponent_a");
    expect(aContext).toContain("SHARED STORE NAMESPACES\n- sharedApp");
    expect(bContext).toContain("DOM ID PREFIX\ncomponent-b-");
    expect(bContext).toContain("STORE NAMESPACE\ncomponent_b");
    expect(bContext).toContain("SHARED STORE NAMESPACES\n- sharedApp");
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
          return { text: 'return agent.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0 } };
        }
        starts.push("second");
        return { text: 'return agent.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0 } };
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
    const lifecycles: Array<Record<string, number | string>> = [];
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
          return {
            text: JSON.stringify({
              summary: "One component still needs work.",
              concerns: [{ kind: "semantic", criterionId: "bad:1", reason: "The requested bad behavior was not completed." }],
            }),
            usage: { cost: 0 },
          };
        }
        if (request.trace?.scope === "#bad") throw new Error("worker B exploded");
        return { text: 'return agent.done("{\\"status\\":\\"done\\",\\"changed\\":[\\"good survived\\"]}");', usage: { cost: 0 } };
      }),
    };

    const executor = parallelExecutor(new Set());
    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, executor).run({
      appId,
      appPrompt: "Sibling components",
      technicalIntent: "Build both.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
      onLifecycle: summary => lifecycles.push(structuredClone(summary) as unknown as Record<string, number | string>),
    });

    expect(result).toMatchObject({ status: "manager-verification-failed", message: "One component still needs work." });
    expect(result.handoffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "done", scope: "#good", changed: ["good survived"] }),
      expect.objectContaining({ status: "failed", scope: "#bad", unresolved: ["worker B exploded"] }),
    ]));
    expect(lifecycles).toEqual(expect.arrayContaining([
      expect.objectContaining({ total: 2, ready: 1, failed: 1 }),
    ]));
    const lifecycleCommands = executor.execute.mock.calls
      .map(([, code]) => String(code))
      .filter(code => code.includes("data-itsalive-build-state") || code.includes("data-itsalive-building"));
    expect(lifecycleCommands.some(code => code.includes('setAttribute("inert"'))).toBe(false);
    expect(lifecycleCommands.some(code => code.includes('removeAttribute("inert")'))).toBe(true);
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
        return { text: 'return agent.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0.003 } };
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


  it("propagates clarification-needed from a worker without final verification", async () => {
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [] },
      tasks: [
        {
          id: "ambiguous",
          goal: "Implement the ambiguous control",
          scope: "#ambiguous",
          acceptanceCriteria: ["Behavior matches user intent"],
          dependencies: [],
          capabilityIds: [],
          profile: "component-worker",
          sharedContractRef: "shared-v1",
          parallel: false,
        },
        {
          id: "dependent",
          goal: "Build dependent output",
          scope: "#dependent",
          acceptanceCriteria: ["Dependent output works"],
          dependencies: ["ambiguous"],
          capabilityIds: [],
          profile: "component-worker",
          sharedContractRef: "shared-v1",
          parallel: false,
        },
      ],
    };
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          throw new Error("final verification must not run after clarification routing");
        }
        return { text: "return component.missingMethod();", usage: { cost: 0 } };
      }),
    };
    const ensured = new Set<string>();
    const executor = {
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
        if (code.includes('component.setAttribute("data-itsalive-build-owner"') || code.includes('component.removeAttribute("data-itsalive-build-owner"')) {
          const match = code.match(/document\.getElementById\("([^"]+)"\)/);
          if (match) ensured.add(match[1]!);
          return { value: { ok: true } };
        }
        if (code.includes("Assigned component scope not found")) {
          return { error: { message: "ambiguous runtime behavior cannot be inferred" } };
        }
        throw new Error("Unexpected executor command: " + code.slice(0, 160));
      }),
    };
    const failureAssessor = vi.fn(async () => ({
      action: "clarify" as const,
      reason: "user-clarification-needed",
      failureClass: "user_clarification",
    }));

    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, executor).run({
      appId,
      appPrompt: "An app with an ambiguous interaction.",
      technicalIntent: "Implement the requested interaction.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
      failureAssessor,
    });

    expect(result).toMatchObject({
      status: "clarification-needed",
      workerTurns: 1,
      handoffs: [
        expect.objectContaining({ status: "blocked", scope: "#ambiguous" }),
        expect.objectContaining({ status: "blocked", scope: "#dependent" }),
      ],
    });
    expect(failureAssessor).toHaveBeenCalledTimes(1);
    expect(providers.generate).toHaveBeenCalledTimes(2);
    expect(providers.generate.mock.calls.some(([request]) => request.purpose === "coding manager integration verification")).toBe(false);
  });


  it("parses an alive policy from the manager plan", () => {
    const plan = parseCodingManagerPlan(JSON.stringify({
      shared: { ref: "shared-v1", design: [], state: [] },
      alivePolicy: {
        meaningfulEvents: [{ id: "lap", description: "Lap created", match: { targetIds: ["lap"] } }],
        repeatableInteractions: [{ id: "controls", description: "Timer controls are normal repeats", match: { targetIds: ["lap"] } }],
        successSignals: ["Lap appears in history"],
        safeReactions: [{ id: "hint", label: "Highlight Lap", kind: "highlight" }],
        invariants: ["Preserve elapsed time"],
        clarificationSignals: ["Repeated static time clicks"],
        agentSignals: ["Timer control missing"],
        retainEvidence: ["Recurring timer-control friction"],
      },
      tasks: [{
        id: "timer",
        goal: "Build timer",
        scope: "#timer",
        acceptanceCriteria: ["works"],
        dependencies: [],
        capabilityIds: [],
        profile: "component-worker",
        sharedContractRef: "shared-v1",
        parallel: false,
      }],
    }));
    expect(plan.alivePolicy).toMatchObject({
      repeatableInteractions: [expect.objectContaining({ id: "controls" })],
      safeReactions: [expect.objectContaining({ id: "hint", reversible: true })],
      invariants: ["Preserve elapsed time"],
    });
  });

  it("activates a proposed alive policy only after successful integration verification", async () => {
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [] },
      alivePolicy: {
        meaningfulEvents: [{ id: "lap", description: "Lap created", match: { targetIds: ["lap"] } }],
        repeatableInteractions: [{ id: "controls", description: "Timer controls are normal repeats", match: { targetIds: ["lap"] } }],
        successSignals: ["Lap appears"],
        safeReactions: [{ id: "hint", label: "Highlight Lap", kind: "highlight" }],
        invariants: ["Preserve elapsed time"],
        clarificationSignals: [],
        agentSignals: ["Control missing"],
        retainEvidence: ["Timer friction"],
      },
      tasks: [{
        id: "timer", goal: "Build timer", scope: "#timer", acceptanceCriteria: ["works"],
        dependencies: [], capabilityIds: [], profile: "component-worker",
        sharedContractRef: "shared-v1", parallel: false,
      }],
    };
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          return { text: '{"ok":true,"summary":"ready","unresolved":[]}', usage: { cost: 0 } };
        }
        return { text: 'return agent.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0 } };
      }),
    };
    const onAlivePolicyProposal = vi.fn(async () => undefined);
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, parallelExecutor(new Set())).run({
      appId,
      appPrompt: "A stopwatch",
      technicalIntent: "Build the timer.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
      onAlivePolicyProposal,
    });

    expect(result).toMatchObject({ status: "done" });
    expect(onAlivePolicyProposal).toHaveBeenCalledTimes(1);
    expect(onAlivePolicyProposal).toHaveBeenCalledWith(expect.objectContaining({
      invariants: ["Preserve elapsed time"],
    }));
  });

  it("does not activate a proposed alive policy when integration verification fails", async () => {
    const plan = {
      shared: { ref: "shared-v1", design: [], state: [] },
      alivePolicy: {
        invariants: ["Preserve user data"],
      },
      tasks: [{
        id: "panel", goal: "Build panel", scope: "#panel", acceptanceCriteria: ["works"],
        dependencies: [], capabilityIds: [], profile: "component-worker",
        sharedContractRef: "shared-v1", parallel: false,
      }],
    };
    const providers = {
      generate: vi.fn(async (request: GenerateRequest) => {
        if (request.purpose === "coding manager plan") return { text: JSON.stringify(plan), usage: { cost: 0 } };
        if (request.purpose === "coding manager integration verification") {
          return {
            text: JSON.stringify({
              summary: "The panel still needs work.",
              concerns: [{ kind: "semantic", criterionId: "panel:1", reason: "The requested behavior is not supported." }],
            }),
            usage: { cost: 0 },
          };
        }
        return { text: 'return agent.done("{\\"status\\":\\"done\\"}");', usage: { cost: 0 } };
      }),
    };
    const onAlivePolicyProposal = vi.fn(async () => undefined);
    vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await new CodingOrchestrator(isolatedDb() as never, providers as never, parallelExecutor(new Set())).run({
      appId,
      appPrompt: "A panel",
      technicalIntent: "Build it.",
      managerProfile: profile("coding-manager"),
      resolveProfile: async id => profile(id),
      managerTrace: managerTrace(),
      onAlivePolicyProposal,
    });

    expect(result).toMatchObject({ status: "manager-verification-failed" });
    expect(onAlivePolicyProposal).not.toHaveBeenCalled();
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
      if (code.includes("itsalive:validate-shared-store-json")) {
        return { value: { ok: true, present: ["sharedApp"] } };
      }
      if (code.includes("itsalive:integration-scope-evidence")) {
        const match = code.match(/const scopes = (\[[^;]+\]);/);
        const scopes = match ? JSON.parse(match[1]!) as string[] : [];
        return { value: scopes.map(scope => ({
          scope,
          exists: true,
          meaningfulUi: true,
          nestedBuildingCount: 0,
          buildOwner: null,
          rootBuilding: false,
          ariaBusy: null,
          durabilityAvailable: true,
          runtimeOnlyEventListenerCount: 0,
        })) };
      }
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
      if (code.includes('component.setAttribute("data-itsalive-build-owner"') || code.includes('component.removeAttribute("data-itsalive-build-owner"')) {
        const match = code.match(/document\.getElementById\("([^"]+)"\)/);
        if (match) ensured.add(match[1]!);
        return { value: { ok: true } };
      }
      if (code.includes("buildingCount:") && code.includes("component.hasAttribute('inert')")) {
        return { value: { html: "<div>ready</div>", buildingCount: 0, inert: false, ariaBusy: "false" } };
      }
      if (code.includes("Assigned component scope not found")) {
        const messageMatch = code.match(/agent\.done\("((?:\\.|[^"])*)"\)/);
        const message = messageMatch ? JSON.parse('"' + messageMatch[1] + '"') : undefined;
        return { done: true, ...(message ? { message } : {}) };
      }
      throw new Error("Unexpected executor command: " + code.slice(0, 160));
    }),
  };
}

});
