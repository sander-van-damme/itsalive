// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/shell/core/coding-orchestrator";
import { resolveAgentProfile, type AgentProfileId } from "../src/shell/core/agent-profiles";
import type { AppExecutor, CompletionAssessmentState, ExecutionResult } from "../src/shell/core/agent-runner";
import type { AppTechnicalContract } from "../src/shell/core/app-contract";
import type { GenerateRequest } from "../src/shell/core/types";
import { createApplicationStore, type ApplicationStoreController, type JsonValue } from "../src/runtime/application-store";
import { restoreAppDocument, serializeAppDocument } from "../src/runtime/persistence";
import { initialBuildTechnicalIntent } from "../src/shell/core/user-intent";

const APP_ID = "550e8400-e29b-41d4-a716-446655440099";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

class FixtureProvider {
  readonly requests: GenerateRequest[] = [];
  private planIndex = 0;
  private readonly programs = new Map<string, string[]>();

  constructor(
    private readonly plans: Array<Record<string, unknown>>,
    programs: Record<string, string[]>,
    private readonly verificationSummary = "The app is ready.",
  ) {
    for (const [scope, values] of Object.entries(programs)) this.programs.set(scope, [...values]);
  }

  async generate(request: GenerateRequest) {
    this.requests.push(request);
    if (request.purpose === "coding manager plan") {
      const plan = this.plans[this.planIndex++];
      if (!plan) throw new Error("No manager plan fixture remains");
      return { text: JSON.stringify(plan), usage: { inputTokens: 100, outputTokens: 30, cost: 0.001 } };
    }
    if (request.purpose === "coding manager integration verification") {
      return {
        text: JSON.stringify({ ok: true, summary: this.verificationSummary, unresolved: [] }),
        usage: { inputTokens: 80, outputTokens: 20, cost: 0.001 },
      };
    }
    if (request.purpose?.startsWith("agent turn")) {
      const scope = request.trace?.scope;
      if (!scope) throw new Error("Worker request omitted scope");
      const queue = this.programs.get(scope);
      const program = queue?.shift();
      if (!program) throw new Error("No worker program remains for " + scope);
      return { text: program, usage: { inputTokens: 120, outputTokens: 60, cost: 0.002 } };
    }
    throw new Error("Unexpected generation purpose: " + request.purpose);
  }
}

class BrowserExecutor implements AppExecutor {
  readonly executed: string[] = [];
  private readonly executedSetupScripts = new WeakSet<HTMLScriptElement>();

  async execute(_appId: string, code: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<ExecutionResult> {
    void options.timeoutMs;
    if (options.signal.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    this.executed.push(code);

    let doneCalled = false;
    let doneMessage: string | undefined;
    const agent = {
      memory: async () => "",
      screenshot: async () => "scenario-screenshot",
      done: (message?: string) => {
        if (message !== undefined && typeof message !== "string") throw new TypeError("agent.done accepts only string");
        doneCalled = true;
        doneMessage = message;
        return { __scenarioDone: true, message };
      },
    };

    try {
      const fn = new AsyncFunction("agent", "application", '"use strict";\n' + code);
      const value = await fn.call(window, agent, (window as unknown as { application: unknown }).application);
      await this.runPendingSetupScripts();
      const returnedDone = Boolean(value && typeof value === "object" && (value as { __scenarioDone?: boolean }).__scenarioDone);
      if (doneCalled || returnedDone) return { done: true, ...(doneMessage ? { message: doneMessage } : {}) };
      return { value };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      };
    }
  }

  async runPendingSetupScripts(): Promise<void> {
    for (const script of document.querySelectorAll<HTMLScriptElement>("script[data-app-setup]")) {
      if (this.executedSetupScripts.has(script)) continue;
      this.executedSetupScripts.add(script);
      const source = script.textContent?.trim();
      if (!source) continue;
      const fn = new AsyncFunction("application", '"use strict";\n' + source);
      await fn.call(window, (window as unknown as { application: unknown }).application);
    }
  }
}

function profile(id: AgentProfileId) {
  return resolveAgentProfile(id, { contextCapacity: 1_000_000, configuredHistoryTokens: 12_000 });
}

function managerTrace() {
  return {
    runId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    role: "coding-manager",
    profile: "coding-manager",
    scope: APP_ID,
  };
}

function isolatedDb() {
  return {
    history: {
      forApp: vi.fn(async () => []),
      add: vi.fn(async () => 1),
    },
  };
}

interface ScenarioApi {
  storeController: ApplicationStoreController;
  decide: ReturnType<typeof vi.fn>;
}

function installScenarioApi(
  decideImplementation: (question: string, context?: JsonValue) => Promise<boolean | null> = async () => null,
): ScenarioApi {
  const storeController = createApplicationStore();
  const decide = vi.fn(decideImplementation);
  const applicationApi = {
    store: storeController.store,
    ai: {
      text: async (prompt: string) => prompt,
      choose: async () => null,
      score: async () => null,
      decide,
      probability: async () => 0.5,
    },
    escalate: vi.fn(),
  };
  Reflect.set(globalThis, "application", applicationApi);
  Reflect.set(window, "application", applicationApi);
  Reflect.set(window, "__itsaliveRuntimeDurabilityAuditV1", () => ({ runtimeOnlyEventListenerCount: 0 }));
  return { storeController, decide };
}

async function runCodingScenario(input: {
  provider: FixtureProvider;
  executor: BrowserExecutor;
  appPrompt: string;
  technicalIntent: string;
  technicalContract?: AppTechnicalContract;
  preferredWorkerProfile?: "component-worker" | "repair-worker";
  completionAssessor?: (state: CompletionAssessmentState) => Promise<{ action: "finish" | "continue" | "uncertain"; reason: string }>;
}) {
  let contract = input.technicalContract;
  const result = await new CodingOrchestrator(isolatedDb() as never, input.provider as never, input.executor).run({
    appId: APP_ID,
    appPrompt: input.appPrompt,
    technicalIntent: input.technicalIntent,
    managerProfile: profile("coding-manager"),
    resolveProfile: async id => profile(id),
    managerTrace: managerTrace(),
    ...(input.technicalContract ? { technicalContract: input.technicalContract } : {}),
    ...(input.preferredWorkerProfile ? { preferredWorkerProfile: input.preferredWorkerProfile } : {}),
    ...(input.completionAssessor ? { completionAssessor: input.completionAssessor } : {}),
    onTechnicalContractProposal: async proposed => { contract = proposed; },
  });
  return { result, contract };
}

function task(
  id: string,
  scope: string,
  goal: string,
  sharedContractRef: string,
  options: {
    dependencies?: string[];
    capabilityIds?: string[];
    profile?: "component-worker" | "repair-worker";
    acceptanceCriteria?: string[];
  } = {},
): Record<string, unknown> {
  return {
    id,
    goal,
    scope,
    acceptanceCriteria: options.acceptanceCriteria ?? [goal + " works from the visible UI"],
    dependencies: options.dependencies ?? [],
    capabilityIds: options.capabilityIds ?? [],
    profile: options.profile ?? "component-worker",
    sharedContractRef,
    parallel: false,
  };
}

const counterShared = {
  ref: "counter-v1",
  design: ["One compact counter panel"],
  state: ["application.store.counterState: { count: finite number }"],
  stores: ["counterState"],
  stableDomIds: ["counter-app"],
  semantics: ["count is a finite integer"],
};

function counterPlan(goal = "Build the counter"): Record<string, unknown> {
  return {
    shared: counterShared,
    contractChange: null,
    tasks: [task("counter", "#counter-app", goal, "counter-v1", {
      acceptanceCriteria: ["The counter value is visible", "The primary counter control changes the durable count"],
    })],
  };
}

function counterBuildProgram(): string {
  const setup = [
    "(() => {",
    "  application.store.counterState ??= { count: 0 };",
    '  const root = document.getElementById("counter-app");',
    '  const output = root?.querySelector("#counter-app-value");',
    '  const button = root?.querySelector("#counter-app-increment");',
    '  const render = () => { if (output) output.textContent = String(application.store.counterState.count); };',
    '  if (root && button && !root.__counterBound) {',
    '    root.__counterBound = true;',
    '    button.addEventListener("click", () => { application.store.counterState.count += 1; render(); });',
    "  }",
    "  render();",
    "})();",
  ].join("\n");
  return [
    'component.innerHTML = \'<button id="counter-app-increment" type="button">Increment</button><output id="counter-app-value">0</output>\';',
    'const setup = document.createElement("script");',
    'setup.type = "application/itsalive-test-setup";',
    'setup.setAttribute("data-app-setup", "");',
    "setup.textContent = " + JSON.stringify(setup) + ";",
    "component.append(setup);",
    'return agent.done(JSON.stringify({ status: "done", changed: ["Counter built"], verified: ["Increment control and value are visible"], unresolved: [], sharedContractChanges: [] }));',
  ].join("\n");
}

function counterModificationProgram(): string {
  const setup = [
    "(() => {",
    '  const root = document.getElementById("counter-app");',
    '  const button = root?.querySelector("#counter-app-decrement");',
    '  const output = root?.querySelector("#counter-app-value");',
    '  if (root && button && !root.__counterDecrementBound) {',
    '    root.__counterDecrementBound = true;',
    '    button.addEventListener("click", () => { application.store.counterState.count -= 1; if (output) output.textContent = String(application.store.counterState.count); });',
    "  }",
    "})();",
  ].join("\n");
  return [
    'if (!component.querySelector("#counter-app-decrement")) component.insertAdjacentHTML("beforeend", \'<button id="counter-app-decrement" type="button">Decrement</button>\');',
    'const setup = document.createElement("script");',
    'setup.type = "application/itsalive-test-setup";',
    'setup.setAttribute("data-app-setup", "");',
    "setup.textContent = " + JSON.stringify(setup) + ";",
    "component.append(setup);",
    'return agent.done(JSON.stringify({ status: "done", changed: ["Decrement added"], verified: ["Decrement changes the existing count"], unresolved: [], sharedContractChanges: [] }));',
  ].join("\n");
}

const movieShared = {
  ref: "movie-v1",
  design: ["Movie form, shortlist, and Tonight panel"],
  state: [
    "application.store.sharedStore.movies: array of { id, title, genre, durationMin }",
    "application.store.sharedStore.tonightId: movie id or null",
  ],
  stores: ["sharedStore"],
  stableDomIds: ["movie-form", "movie-shortlist", "tonight-section"],
  semantics: ["durationMin is an integer number of minutes"],
};

function moviePlan(repairOnly = false): Record<string, unknown> {
  const form = task("form", "#movie-form", repairOnly ? "Repair the add-movie control" : "Build the add-movie form", "movie-v1", {
    profile: repairOnly ? "repair-worker" : "component-worker",
    acceptanceCriteria: ["A real movie can be added without replacing existing user data"],
  });
  return {
    shared: movieShared,
    contractChange: null,
    tasks: repairOnly ? [form] : [
      form,
      task("shortlist", "#movie-shortlist", "Build the shortlist", "movie-v1", {
        dependencies: ["form"],
        acceptanceCriteria: ["Shortlisted movies render with Tonight and Remove controls"],
      }),
      task("tonight", "#tonight-section", "Build the Tonight selection", "movie-v1", {
        dependencies: ["shortlist"],
        acceptanceCriteria: ["The selected Tonight movie is visible"],
      }),
    ],
  };
}

function movieFormProgram(repair = false): string {
  const setup = [
    "(() => {",
    "  application.store.sharedStore ??= { movies: [], tonightId: null };",
    '  const root = document.getElementById("movie-form");',
    '  const form = root?.querySelector("form");',
    '  if (root && form && !form.__movieBound) {',
    '    form.__movieBound = true;',
    '    form.addEventListener("submit", event => {',
    '      event.preventDefault();',
    '      const title = form.querySelector("[name=title]").value.trim();',
    '      const genre = form.querySelector("[name=genre]").value.trim();',
    '      const durationMin = Number(form.querySelector("[name=duration]").value);',
    '      if (!title || !Number.isFinite(durationMin)) return;',
    '      application.store.sharedStore.movies.push({ id: "movie-" + Date.now() + "-" + application.store.sharedStore.movies.length, title, genre, durationMin });',
    '      form.reset();',
    '      window.__movieRenderShortlist?.();',
    '      window.__movieRenderTonight?.();',
    "    });",
    "  }",
    "})();",
  ].join("\n");
  const lines = [];
  if (!repair) lines.push('component.innerHTML = \'<form><input name="title" aria-label="Title"><input name="genre" aria-label="Genre"><input name="duration" type="number" aria-label="Duration"><button type="submit">Add movie</button></form>\';');
  lines.push('const setup = document.createElement("script");');
  lines.push('setup.type = "application/itsalive-test-setup";');
  lines.push('setup.setAttribute("data-app-setup", "");');
  lines.push("setup.textContent = " + JSON.stringify(setup) + ";");
  lines.push("component.append(setup);");
  lines.push('return agent.done(JSON.stringify({ status: "done", changed: ["Movie form ready"], verified: ["Add movie is wired without synthetic records"], unresolved: [], sharedContractChanges: [] }));');
  return lines.join("\n");
}

function movieShortlistProgram(): string {
  const setup = [
    "(() => {",
    "  application.store.sharedStore ??= { movies: [], tonightId: null };",
    '  const root = document.getElementById("movie-shortlist");',
    '  const list = root?.querySelector("[data-list]");',
    '  const render = () => { if (list) list.innerHTML = application.store.sharedStore.movies.map(movie => \'<article data-movie-id="\' + movie.id + \'"><strong>\' + movie.title + \'</strong><button data-action="tonight" type="button">Tonight</button><button data-action="remove" type="button">Remove</button></article>\').join("") || \'<p data-empty>No movies yet</p>\'; };',
    '  window.__movieRenderShortlist = render;',
    '  if (root && !root.__movieBound) {',
    '    root.__movieBound = true;',
    '    root.addEventListener("click", event => {',
    '      const button = event.target.closest("button[data-action]");',
    '      const article = button?.closest("[data-movie-id]");',
    '      if (!button || !article) return;',
    '      const id = article.getAttribute("data-movie-id");',
    '      if (button.dataset.action === "tonight") application.store.sharedStore.tonightId = id;',
    '      if (button.dataset.action === "remove") {',
    '        const index = application.store.sharedStore.movies.findIndex(movie => movie.id === id);',
    '        if (index >= 0) application.store.sharedStore.movies.splice(index, 1);',
    '        if (application.store.sharedStore.tonightId === id) application.store.sharedStore.tonightId = null;',
    "      }",
    "      render();",
    '      window.__movieRenderTonight?.();',
    "    });",
    "  }",
    "  render();",
    "})();",
  ].join("\n");
  return [
    'component.innerHTML = \'<div data-list><p data-empty>No movies yet</p></div>\';',
    'const setup = document.createElement("script");',
    'setup.type = "application/itsalive-test-setup";',
    'setup.setAttribute("data-app-setup", "");',
    "setup.textContent = " + JSON.stringify(setup) + ";",
    "component.append(setup);",
    'return agent.done(JSON.stringify({ status: "done", changed: ["Shortlist ready"], verified: ["Shortlist renders shared movie state"], unresolved: [], sharedContractChanges: [] }));',
  ].join("\n");
}

function movieTonightProgram(): string {
  const setup = [
    "(() => {",
    "  application.store.sharedStore ??= { movies: [], tonightId: null };",
    '  const root = document.getElementById("tonight-section");',
    '  const output = root?.querySelector("[data-tonight]");',
    '  const render = () => { const movie = application.store.sharedStore.movies.find(item => item.id === application.store.sharedStore.tonightId); if (output) output.textContent = movie ? "Tonight: " + movie.title : "Nothing selected"; };',
    '  window.__movieRenderTonight = render;',
    "  render();",
    "})();",
  ].join("\n");
  return [
    'component.innerHTML = \'<p data-tonight>Nothing selected</p>\';',
    'const setup = document.createElement("script");',
    'setup.type = "application/itsalive-test-setup";',
    'setup.setAttribute("data-app-setup", "");',
    "setup.textContent = " + JSON.stringify(setup) + ";",
    "component.append(setup);",
    'return agent.done(JSON.stringify({ status: "done", changed: ["Tonight panel ready"], verified: ["Tonight selection renders shared state"], unresolved: [], sharedContractChanges: [] }));',
  ].join("\n");
}

function wordPlan(): Record<string, unknown> {
  return {
    shared: {
      ref: "word-v1",
      design: ["One word input and one decision result"],
      state: [],
      stores: [],
      stableDomIds: ["word-decider"],
      semantics: ["null means the platform is unsure and must be shown conservatively"],
    },
    contractChange: null,
    tasks: [task("word", "#word-decider", "Build the English word decider", "word-v1", {
      capabilityIds: ["ai"],
      acceptanceCriteria: ["Decide uses application.ai.decide", "true, false, and null render a visible result"],
    })],
  };
}

function wordProgram(): string {
  const setup = [
    "(() => {",
    '  const root = document.getElementById("word-decider");',
    '  const input = root?.querySelector("input");',
    '  const button = root?.querySelector("button");',
    '  const result = root?.querySelector("output");',
    '  if (root && input && button && result && !root.__wordBound) {',
    '    root.__wordBound = true;',
    '    button.addEventListener("click", async () => {',
    '      const word = input.value.trim();',
    '      const decision = await application.ai.decide("Is this word English?", { word });',
    '      result.textContent = decision === null ? "Not sure" : decision ? "English" : "Not English";',
    "    });",
    "  }",
    "})();",
  ].join("\n");
  return [
    'component.innerHTML = \'<input aria-label="Word"><button type="button">Decide</button><output>Enter a word</output>\';',
    'const setup = document.createElement("script");',
    'setup.type = "application/itsalive-test-setup";',
    'setup.setAttribute("data-app-setup", "");',
    "setup.textContent = " + JSON.stringify(setup) + ";",
    "component.append(setup);",
    'return agent.done(JSON.stringify({ status: "done", changed: ["Word decider ready"], verified: ["application.ai.decide is wired with null handling"], unresolved: [], sharedContractChanges: [] }));',
  ].join("\n");
}

function storeValue<T>(controller: ApplicationStoreController, key: string): T {
  return controller.store[key] as unknown as T;
}

async function clickAndFlush(element: Element): Promise<void> {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.head.innerHTML = "<title>Reliability scenario</title>";
  document.body.innerHTML = '<main id="itsalive-root"></main>';
  for (const key of ["__movieRenderShortlist", "__movieRenderTonight", "__itsaliveRuntimeDurabilityAuditV1"]) {
    Reflect.deleteProperty(window, key);
  }
  Reflect.deleteProperty(globalThis, "application");
  Reflect.deleteProperty(window, "application");
});

describe("reliability scenarios", () => {
  it("1. simple initial build is atomic, survives JEV uncertainty, and leaves usable UI", async () => {
    const api = installScenarioApi();
    const executor = new BrowserExecutor();
    const fence = String.fromCharCode(96).repeat(3);
    const malformed = 'component.innerHTML = "<p>PARTIAL MUTATION</p>";\n' + fence + "broken" + fence;
    const provider = new FixtureProvider([counterPlan()], { "#counter-app": [malformed, counterBuildProgram()] }, "Counter is ready.");
    const completionAssessor = vi.fn(async (_state: CompletionAssessmentState) => ({
      action: "uncertain" as const,
      reason: "evidence-uncertain",
    }));

    const { result, contract } = await runCodingScenario({
      provider,
      executor,
      appPrompt: "A simple counter",
      technicalIntent: "Build a visible counter whose Increment button changes durable state.",
      completionAssessor,
    });

    expect(result).toMatchObject({ status: "done", message: "Counter is ready." });
    expect(contract).toMatchObject({ revision: 1, shared: { ref: "counter-v1" } });
    expect(executor.executed.join("\n")).not.toContain("PARTIAL MUTATION");
    expect(document.body.textContent).not.toContain("PARTIAL MUTATION");
    expect(document.querySelector("#counter-app button")?.textContent).toBe("Increment");
    expect(document.querySelectorAll("[data-itsalive-building], [inert]")).toHaveLength(0);
    expect(completionAssessor).toHaveBeenCalledTimes(1);

    await clickAndFlush(document.querySelector("#counter-app-increment")!);
    expect(storeValue<{ count: number }>(api.storeController, "counterState").count).toBe(1);
    expect(document.querySelector("#counter-app-value")?.textContent).toBe("1");
    expect(result.timeline).toHaveLength(1);
  });

  it("2. Movie Night Planner completes without fake verification records leaking into live state", async () => {
    const api = installScenarioApi();
    const executor = new BrowserExecutor();
    const provider = new FixtureProvider(
      [moviePlan()],
      {
        "#movie-form": [movieFormProgram()],
        "#movie-shortlist": [movieShortlistProgram()],
        "#tonight-section": [movieTonightProgram()],
      },
      "Movie Night is ready.",
    );

    const { result, contract } = await runCodingScenario({
      provider,
      executor,
      appPrompt: "Build me a personal movie night planner with a shortlist and a separate Tonight section.",
      technicalIntent: "Build the add-movie form, shortlist, and Tonight workflow.",
    });

    expect(result).toMatchObject({ status: "done", message: "Movie Night is ready.", workerTurns: 3 });
    expect(contract).toMatchObject({ revision: 1, shared: { ref: "movie-v1", stores: ["sharedStore"] } });
    const initialStore = storeValue<{ movies: unknown[]; tonightId: string | null }>(api.storeController, "sharedStore");
    expect(initialStore).toEqual({ movies: [], tonightId: null });
    for (const probe of ["Test Film", "V Film", "Probe Night"]) {
      expect(document.body.textContent).not.toContain(probe);
      expect(api.storeController.snapshot()).not.toContain(probe);
    }

    const form = document.querySelector<HTMLFormElement>("#movie-form form")!;
    form.querySelector<HTMLInputElement>("[name=title]")!.value = "Arrival";
    form.querySelector<HTMLInputElement>("[name=genre]")!.value = "Sci-fi";
    form.querySelector<HTMLInputElement>("[name=duration]")!.value = "116";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(document.querySelector("#movie-shortlist")?.textContent).toContain("Arrival");

    await clickAndFlush(document.querySelector('#movie-shortlist [data-action="tonight"]')!);
    expect(document.querySelector("[data-tonight]")?.textContent).toBe("Tonight: Arrival");

    await clickAndFlush(document.querySelector('#movie-shortlist [data-action="remove"]')!);
    expect(document.querySelector("#movie-shortlist")?.textContent).toContain("No movies yet");
    expect(document.querySelector("[data-tonight]")?.textContent).toBe("Nothing selected");
    expect(storeValue<{ movies: unknown[] }>(api.storeController, "sharedStore").movies).toHaveLength(0);
    expect(document.querySelectorAll("[data-itsalive-building], [inert]")).toHaveLength(0);
  });

  it("3. explicit repair uses repair-worker, preserves real data, and keeps the canonical contract", async () => {
    const api = installScenarioApi();
    const executor = new BrowserExecutor();
    const provider = new FixtureProvider(
      [moviePlan(), moviePlan(true)],
      {
        "#movie-form": [movieFormProgram(), movieFormProgram(true)],
        "#movie-shortlist": [movieShortlistProgram()],
        "#tonight-section": [movieTonightProgram()],
      },
      "Movie planner works again.",
    );

    const initial = await runCodingScenario({
      provider,
      executor,
      appPrompt: "Movie planner",
      technicalIntent: "Build the movie planner.",
    });
    expect(initial.result.status).toBe("done");
    expect(initial.contract).toBeDefined();

    const form = document.querySelector<HTMLFormElement>("#movie-form form")!;
    form.querySelector<HTMLInputElement>("[name=title]")!.value = "Arrival";
    form.querySelector<HTMLInputElement>("[name=genre]")!.value = "Sci-fi";
    form.querySelector<HTMLInputElement>("[name=duration]")!.value = "116";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(storeValue<{ movies: unknown[] }>(api.storeController, "sharedStore").movies).toHaveLength(1);

    form.replaceWith(form.cloneNode(true));
    const brokenForm = document.querySelector<HTMLFormElement>("#movie-form form")!;
    brokenForm.querySelector<HTMLInputElement>("[name=title]")!.value = "Should not add";
    brokenForm.querySelector<HTMLInputElement>("[name=duration]")!.value = "90";
    brokenForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(storeValue<{ movies: unknown[] }>(api.storeController, "sharedStore").movies).toHaveLength(1);

    const repaired = await runCodingScenario({
      provider,
      executor,
      appPrompt: "Movie planner",
      technicalIntent: "Repair the reported app problem: the app buttons don't work.",
      technicalContract: initial.contract,
      preferredWorkerProfile: "repair-worker",
    });

    expect(repaired.result.status).toBe("done");
    expect(repaired.contract).toBe(initial.contract);
    expect(repaired.contract?.revision).toBe(1);
    expect(repaired.contract?.shared).toEqual(initial.contract?.shared);
    expect(provider.requests.some(request => request.trace?.profile === "repair-worker")).toBe(true);

    const repairedForm = document.querySelector<HTMLFormElement>("#movie-form form")!;
    repairedForm.querySelector<HTMLInputElement>("[name=title]")!.value = "Moon";
    repairedForm.querySelector<HTMLInputElement>("[name=genre]")!.value = "Drama";
    repairedForm.querySelector<HTMLInputElement>("[name=duration]")!.value = "97";
    repairedForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const movies = storeValue<{ movies: Array<{ title: string }> }>(api.storeController, "sharedStore").movies;
    expect(movies.map(movie => movie.title)).toEqual(["Arrival", "Moon"]);
    expect(document.querySelector("#movie-shortlist")?.textContent).toContain("Arrival");
    expect(document.querySelector("#movie-shortlist")?.textContent).toContain("Moon");
  });

  it("4. Word Decider discovers and wires application.ai.decide with true, false, and null handling", async () => {
    const api = installScenarioApi(async (_question, context) => {
      const word = (context as unknown as { word?: string } | undefined)?.word?.toLowerCase();
      if (word === "hello") return true;
      if (word === "bonjour") return false;
      return null;
    });
    const executor = new BrowserExecutor();
    const provider = new FixtureProvider([wordPlan()], { "#word-decider": [wordProgram()] }, "Word decider is ready.");
    const prompt = "make an app where I type in a word. if I click the decide button, it decides whether the word is in English or not";
    const intent = initialBuildTechnicalIntent(prompt);
    expect(intent.capabilityIds).toContain("ai");

    const { result } = await runCodingScenario({
      provider,
      executor,
      appPrompt: prompt,
      technicalIntent: "Build the initial usable version. Selected API groups: " + intent.capabilityIds.join(", "),
    });
    expect(result.status).toBe("done");

    const managerRequest = provider.requests.find(request => request.purpose === "coding manager plan")!;
    expect(managerRequest.messages.map(message => message.content).join("\n")).toContain(
      "application.ai.decide(question: string, context?: JsonValue): Promise<boolean | null>",
    );
    const workerRequest = provider.requests.find(request => request.trace?.scope === "#word-decider")!;
    expect(workerRequest.messages.map(message => message.content).join("\n")).toContain("application.ai.decide");

    const input = document.querySelector<HTMLInputElement>("#word-decider input")!;
    const button = document.querySelector("#word-decider button")!;
    const output = document.querySelector("#word-decider output")!;
    input.value = "hello";
    await clickAndFlush(button);
    expect(output.textContent).toBe("English");
    input.value = "bonjour";
    await clickAndFlush(button);
    expect(output.textContent).toBe("Not English");
    input.value = "qzxq";
    await clickAndFlush(button);
    expect(output.textContent).toBe("Not sure");
    expect(api.decide).toHaveBeenCalledTimes(3);
  });

  it("5. reload restores durable state and behavior, then modification preserves the contract", async () => {
    let api = installScenarioApi();
    const executor = new BrowserExecutor();
    const provider = new FixtureProvider(
      [counterPlan(), counterPlan("Add a decrement control")],
      { "#counter-app": [counterBuildProgram(), counterModificationProgram()] },
      "Counter updated.",
    );

    const initial = await runCodingScenario({
      provider,
      executor,
      appPrompt: "Counter",
      technicalIntent: "Build the counter.",
    });
    expect(initial.result.status).toBe("done");
    expect(initial.contract).toBeDefined();

    await clickAndFlush(document.querySelector("#counter-app-increment")!);
    await clickAndFlush(document.querySelector("#counter-app-increment")!);
    expect(storeValue<{ count: number }>(api.storeController, "counterState").count).toBe(2);

    const snapshot = serializeAppDocument(api.storeController.snapshot());
    document.head.innerHTML = "<title>Reloaded</title>";
    document.body.innerHTML = "<main>loading</main>";
    api = installScenarioApi();
    api.storeController.restore(snapshot.store);
    await restoreAppDocument(snapshot);
    await executor.runPendingSetupScripts();

    expect(storeValue<{ count: number }>(api.storeController, "counterState").count).toBe(2);
    expect(document.querySelector("#counter-app-value")?.textContent).toBe("2");
    await clickAndFlush(document.querySelector("#counter-app-increment")!);
    expect(storeValue<{ count: number }>(api.storeController, "counterState").count).toBe(3);

    const modified = await runCodingScenario({
      provider,
      executor,
      appPrompt: "Counter",
      technicalIntent: "Add a decrement control to the restored counter.",
      technicalContract: initial.contract,
    });
    expect(modified.result.status).toBe("done");
    expect(modified.contract).toBe(initial.contract);
    expect(document.querySelector("#counter-app-decrement")).not.toBeNull();

    await clickAndFlush(document.querySelector("#counter-app-decrement")!);
    expect(storeValue<{ count: number }>(api.storeController, "counterState").count).toBe(2);
    expect(document.querySelector("#counter-app-value")?.textContent).toBe("2");
  });
});
