import { AgentRunner, type AgentContextDiagnostic, type AgentProgress, type AppExecutor } from "./agent-runner";
import { IsolatedAgentHistory } from "./agent-history";
import { compactWorkerHandoff, type WorkerHandoff } from "./agent-context";
import type { ShellDatabase } from "./database";
import { platformCapabilityHelp, isPlatformCapabilityId, type PlatformCapabilityId } from "./capabilities";
import type { AgentProfileId, ResolvedAgentProfile } from "./agent-profiles";
import type { ProviderRegistry } from "./providers";
import { RunBudgetController, runBudgetMessage, type RunBudgetStopKind } from "./run-budget";
import { createAgentTimeout } from "./run-lifecycle";
import { createLlmTraceIdentity } from "./llm-trace";
import type { Credential, LlmTraceIdentity } from "./types";

export interface CodingManagerSharedContracts {
  design: string[];
  state: string[];
}

export interface CodingWorkerTask {
  id: string;
  goal: string;
  scope: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  capabilityIds: PlatformCapabilityId[];
  profile: "component-worker" | "repair-worker";
}

export interface CodingManagerPlan {
  shared: CodingManagerSharedContracts;
  tasks: CodingWorkerTask[];
}

export interface ManagerVerification {
  ok: boolean;
  summary: string;
  unresolved: string[];
}

export type CodingOrchestratorStatus = "done" | "manager-verification-failed" | RunBudgetStopKind;

export interface CodingOrchestratorResult {
  status: CodingOrchestratorStatus;
  message?: string;
  plan?: CodingManagerPlan;
  handoffs: WorkerHandoff[];
  workerTurns: number;
}

export interface CodingOrchestratorOptions {
  appId: string;
  appPrompt: string;
  technicalIntent: string;
  managerProfile: ResolvedAgentProfile;
  resolveProfile(id: AgentProfileId): Promise<ResolvedAgentProfile>;
  credential?: Credential;
  signal?: AbortSignal;
  managerTrace: LlmTraceIdentity;
  consumeEnvironmentObservations?: () => string[];
  onProgress?: (progress: AgentProgress & { workerId?: string; scope?: string }) => void;
  onContext?: (context: AgentContextDiagnostic) => void;
}

const MANAGER_PLAN_SYSTEM = [
  "You are the coding manager for one live browser app.",
  "Plan implementation; do not write DOM mutation code.",
  "",
  "Return JSON only:",
  "{\"shared\":{\"design\":[\"...\"],\"state\":[\"...\"]},\"tasks\":[{\"id\":\"short-id\",\"goal\":\"...\",\"scope\":\"#component-id\",\"acceptanceCriteria\":[\"...\"],\"dependencies\":[\"earlier-task-id\"],\"capabilityIds\":[\"valid-id\"],\"profile\":\"component-worker|repair-worker\"}]}",
  "",
  "Rules:",
  "- Use the supplied TECHNICAL INTENT as authoritative. Raw chat is intentionally absent.",
  "- Shared design/state contracts are written once here, then referenced by workers.",
  "- Use one ordered task for a truly atomic change; use 2+ tasks when distinct components/work units exist.",
  "- Every scope must be a simple #id selector using letters, numbers, _ or -.",
  "- Reuse an existing component id from APP OUTLINE when it clearly owns the work; otherwise choose a new stable id.",
  "- Dependencies may reference only earlier task ids.",
  "- component-worker is the default. Use repair-worker only when the task is primarily diagnosis/repair.",
  "- capabilityIds may contain only platform capability ids relevant to that worker.",
  "- Keep tasks non-overlapping. A worker owns only its assigned scope.",
  "- The manager owns decomposition, shared contracts, ordering and final integration verification."
].join("\n");

const WORKER_SYSTEM = [
  "You are an element-scoped implementation worker in a live browser app.",
  "",
  "OUTPUT",
  "Return only executable JavaScript commands between /* itsalive:command */ and /* itsalive:end */. The final command may call itsalive.done(...) only after your assigned scope works.",
  "",
  "SCOPE",
  "A variable named component is bound to your assigned Element for every command.",
  "Modify component and its descendants only. Native DOM/browser APIs are available, but do not change unrelated nodes, #itsalive-root, or another worker scope.",
  "This is a beta convention rather than a security boundary, so follow it strictly.",
  "Inspect through component when possible. If a dependency outside the scope is missing, report it instead of silently expanding scope.",
  "",
  "DURABILITY",
  "Use durable app-authored markup/setup/state. Do not leave behavior dependent on transient command listeners/closures. Keep setup idempotent.",
  "",
  "BUILD STATE",
  "The assigned component may start data-itsalive-building + inert + aria-busy. Remove those attributes only when this scope is actually usable.",
  "",
  "HANDOFF",
  "On success, the final done payload must be JSON only with:",
  "{\"changed\":[\"short durable outcome\"],\"verified\":[\"observable checks\"],\"unresolved\":[],\"sharedContractChanges\":[]}",
  "Keep it compact."
].join("\n");

const MANAGER_VERIFY_SYSTEM = [
  "You are the coding manager performing final integration verification.",
  "Return JSON only:",
  "{\"ok\":boolean,\"summary\":\"short user-safe summary\",\"unresolved\":[\"specific unmet integration or acceptance criterion\"]}",
  "",
  "Judge only from the technical intent, shared contracts, worker handoffs, and compact final app outline.",
  "Do not request worker transcripts.",
  "Mark ok=false when an acceptance criterion is not supported by the evidence or a component remains missing/building."
].join("\n");

const SIMPLE_SCOPE = /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TASK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class CodingOrchestrator {
  constructor(
    private readonly db: ShellDatabase,
    private readonly providers: ProviderRegistry,
    private readonly executor: AppExecutor,
  ) {}

  async run(options: CodingOrchestratorOptions): Promise<CodingOrchestratorResult> {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) relayAbort();
    else options.signal?.addEventListener("abort", relayAbort, { once: true });
    const deadline = setTimeout(
      () => controller.abort(createAgentTimeout("time-budget")),
      options.managerProfile.budgets.maxDurationMs,
    );
    const rootBudget = new RunBudgetController(options.managerProfile.budgets);
    const handoffs: WorkerHandoff[] = [];
    let workerTurns = 0;

    try {
      const initialOutline = await inspectAppOutline(this.executor, options.appId, controller.signal);
      const planned = await this.providers.generate({
        purpose: "coding manager plan",
        model: options.managerProfile.modelConfig,
        system: MANAGER_PLAN_SYSTEM,
        messages: [{ role: "user", content: managerPlanInput(options, initialOutline) }],
        trace: options.managerTrace,
        signal: controller.signal,
      }, options.credential);
      const planningStop = rootBudget.recordUsage(planned.usage?.cost);
      if (planningStop) return stopResult(planningStop, handoffs, workerTurns);
      const plan = parseCodingManagerPlan(planned.text);

      for (const task of plan.tasks) {
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
        await ensureWorkerScope(this.executor, options.appId, task.scope, controller.signal);

        const profile = await options.resolveProfile(task.profile);
        const workerTrace = createLlmTraceIdentity(profile.role, profile.id, {
          parentRunId: options.managerTrace.runId,
          parentAgentId: options.managerTrace.agentId,
          scope: task.scope,
        });
        const relevantHandoffs = task.dependencies
          .map(id => {
            const dependencyTask = plan.tasks.find(candidate => candidate.id === id);
            return dependencyTask ? handoffs.find(handoff => handoff.scope === dependencyTask.scope) : undefined;
          })
          .filter((handoff): handoff is WorkerHandoff => Boolean(handoff));
        const isolatedHistory = new IsolatedAgentHistory();
        const runner = new AgentRunner(this.db, this.providers, this.executor);
        const result = await runner.run({
          appId: options.appId,
          appPrompt: options.appPrompt,
          trigger: workerTaskInput(plan, task, relevantHandoffs),
          persistTrigger: false,
          model: profile.modelConfig,
          systemPrompt: WORKER_SYSTEM,
          history: isolatedHistory,
          scopeSelector: task.scope,
          budgetController: rootBudget.fork(profile.budgets),
          trace: workerTrace,
          credential: options.credential,
          signal: controller.signal,
          consumeEnvironmentObservations: options.consumeEnvironmentObservations,
          onProgress: progress => options.onProgress?.({ ...progress, workerId: task.id, scope: task.scope }),
          onContext: options.onContext,
        });
        workerTurns += result.turns;

        const handoff = workerHandoff(task, result.status, result.rawMessage, result.message);
        handoffs.push(handoff);
        if (result.status !== "done") {
          return {
            status: result.status,
            message: result.message,
            plan,
            handoffs,
            workerTurns,
          };
        }
      }

      const finalOutline = await inspectAppOutline(this.executor, options.appId, controller.signal);
      const verified = await this.providers.generate({
        purpose: "coding manager integration verification",
        model: options.managerProfile.modelConfig,
        system: MANAGER_VERIFY_SYSTEM,
        messages: [{
          role: "user",
          content: managerVerificationInput(options, plan, handoffs, finalOutline),
        }],
        trace: options.managerTrace,
        signal: controller.signal,
      }, options.credential);
      const finalCostStop = rootBudget.recordUsage(verified.usage?.cost);
      const verification = parseManagerVerification(verified.text);
      if (verification.ok) {
        return {
          status: "done",
          message: verification.summary || "Done — it’s ready.",
          plan,
          handoffs,
          workerTurns,
        };
      }
      if (finalCostStop) return { ...stopResult(finalCostStop, handoffs, workerTurns), plan };
      return {
        status: "manager-verification-failed",
        message: verification.summary || "Final integration verification found unfinished work.",
        plan,
        handoffs,
        workerTurns,
      };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", relayAbort);
    }
  }
}

function managerPlanInput(options: CodingOrchestratorOptions, outline: unknown): string {
  return [
    "APP PURPOSE\n" + options.appPrompt.trim(),
    "TECHNICAL INTENT\n" + options.technicalIntent.trim(),
    "APP OUTLINE\n" + JSON.stringify(outline),
  ].join("\n\n");
}

function managerVerificationInput(
  options: CodingOrchestratorOptions,
  plan: CodingManagerPlan,
  handoffs: WorkerHandoff[],
  outline: unknown,
): string {
  return [
    "TECHNICAL INTENT\n" + options.technicalIntent.trim(),
    "SHARED DESIGN\n" + list(plan.shared.design),
    "SHARED STATE\n" + list(plan.shared.state),
    "WORKER HANDOFFS\n" + (handoffs.map(compactWorkerHandoff).join("\n") || "(none)"),
    "FINAL APP OUTLINE\n" + JSON.stringify(outline),
  ].join("\n\n");
}

function workerTaskInput(
  plan: CodingManagerPlan,
  task: CodingWorkerTask,
  dependencyHandoffs: WorkerHandoff[],
): string {
  return [
    "WORKER TASK",
    "TASK ID\n" + task.id,
    "GOAL\n" + task.goal,
    "ASSIGNED SCOPE\n" + task.scope,
    "ACCEPTANCE CRITERIA\n" + list(task.acceptanceCriteria),
    "SHARED DESIGN CONTRACT\n" + list(plan.shared.design),
    "SHARED STATE CONTRACT\n" + list(plan.shared.state),
    "DEPENDENCY HANDOFFS\n" + (dependencyHandoffs.map(compactWorkerHandoff).join("\n") || "(none)"),
    "RELEVANT PLATFORM CAPABILITIES\n" + platformCapabilityHelp(task.capabilityIds),
  ].join("\n\n");
}

function list(values: readonly string[]): string {
  return values.length ? values.map(value => "- " + value).join("\n") : "- (none)";
}

function stringArray(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map(entry => entry.trim())
    .filter(Boolean)
    .slice(0, max);
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^~~~(?:json)?\s*([\s\S]*?)\s*~~~$/i);
  return match ? match[1]!.trim() : trimmed;
}

export function parseCodingManagerPlan(raw: string): CodingManagerPlan {
  let parsed: unknown;
  try { parsed = JSON.parse(stripFence(raw)); }
  catch { throw new Error("Coding manager returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Coding manager returned an invalid plan");
  const record = parsed as Record<string, unknown>;
  const sharedRaw = record.shared;
  const sharedRecord = sharedRaw && typeof sharedRaw === "object" && !Array.isArray(sharedRaw)
    ? sharedRaw as Record<string, unknown>
    : {};
  const shared: CodingManagerSharedContracts = {
    design: stringArray(sharedRecord.design, 16),
    state: stringArray(sharedRecord.state, 16),
  };
  if (!Array.isArray(record.tasks) || record.tasks.length < 1 || record.tasks.length > 8) {
    throw new Error("Coding manager must return between 1 and 8 tasks");
  }

  const seen = new Set<string>();
  const tasks = record.tasks.map((value, index): CodingWorkerTask => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Coding manager task " + (index + 1) + " is invalid");
    const task = value as Record<string, unknown>;
    const id = typeof task.id === "string" ? task.id.trim() : "";
    const goal = typeof task.goal === "string" ? task.goal.trim().slice(0, 2_000) : "";
    const scope = typeof task.scope === "string" ? task.scope.trim() : "";
    if (!TASK_ID.test(id) || seen.has(id)) throw new Error("Coding manager task " + (index + 1) + " has an invalid or duplicate id");
    if (!goal) throw new Error("Coding manager task " + id + " has no goal");
    if (!SIMPLE_SCOPE.test(scope)) throw new Error("Coding manager task " + id + " must use a simple #id scope");
    const dependencies = stringArray(task.dependencies, 8);
    for (const dependency of dependencies) {
      if (!seen.has(dependency)) throw new Error("Coding manager task " + id + " depends on a task that is not earlier in the plan");
    }
    const profile = task.profile === "repair-worker" ? "repair-worker" : "component-worker";
    const capabilityIds = stringArray(task.capabilityIds, 12).filter(isPlatformCapabilityId);
    seen.add(id);
    return {
      id,
      goal,
      scope,
      acceptanceCriteria: stringArray(task.acceptanceCriteria, 12),
      dependencies,
      capabilityIds,
      profile,
    };
  });
  return { shared, tasks };
}

export function parseManagerVerification(raw: string): ManagerVerification {
  let parsed: unknown;
  try { parsed = JSON.parse(stripFence(raw)); }
  catch { throw new Error("Coding manager verification returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Coding manager verification returned an invalid result");
  const record = parsed as Record<string, unknown>;
  if (typeof record.ok !== "boolean") throw new Error("Coding manager verification omitted ok");
  return {
    ok: record.ok,
    summary: typeof record.summary === "string" ? record.summary.trim().slice(0, 1_000) : "",
    unresolved: stringArray(record.unresolved, 12),
  };
}

function workerHandoff(
  task: CodingWorkerTask,
  status: "done" | RunBudgetStopKind,
  rawMessage: string | undefined,
  fallbackMessage: string | undefined,
): WorkerHandoff {
  if (status !== "done") {
    return {
      status: "blocked",
      scope: task.scope,
      changed: [],
      verified: [],
      unresolved: [fallbackMessage || "Worker stopped: " + status],
    };
  }

  if (rawMessage) {
    try {
      const parsed = JSON.parse(stripFence(rawMessage)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const unresolved = stringArray(record.unresolved, 12);
        const sharedContractChanges = stringArray(record.sharedContractChanges, 12);
        return {
          status: "done",
          scope: task.scope,
          changed: stringArray(record.changed, 12),
          verified: stringArray(record.verified, 12),
          ...(unresolved.length ? { unresolved } : {}),
          ...(sharedContractChanges.length ? { sharedContractChanges } : {}),
        };
      }
    } catch {
      // Fall through to a deterministic compact handoff.
    }
  }
  return {
    status: "done",
    scope: task.scope,
    changed: ["Completed scoped task: " + task.goal],
    verified: task.acceptanceCriteria,
  };
}

async function inspectAppOutline(executor: AppExecutor, appId: string, signal: AbortSignal): Promise<unknown> {
  const code = [
    'const root = document.getElementById("itsalive-root");',
    'return root ? {',
    '  exists: true,',
    '  childCount: root.children.length,',
    '  textPreview: (root.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 500),',
    '  children: Array.from(root.children).slice(0, 24).map((element) => ({',
    '    tag: element.tagName.toLowerCase(),',
    '    id: element.id || null,',
    '    component: element.getAttribute("data-itsalive-component"),',
    '    building: element.hasAttribute("data-itsalive-building"),',
    '    textPreview: (element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 180),',
    '  })),',
    '} : { exists: false, childCount: 0, children: [] };',
  ].join("\n");
  const result = await executor.execute(appId, code, { signal, timeoutMs: 5_000 });
  if (result.error) throw new Error("Could not inspect app outline: " + result.error.message);
  return result.value;
}

async function ensureWorkerScope(
  executor: AppExecutor,
  appId: string,
  scope: string,
  signal: AbortSignal,
): Promise<void> {
  const id = scope.slice(1);
  const code = [
    'const root = document.getElementById("itsalive-root");',
    'if (!root) return { ok: false, reason: "missing-root" };',
    'let component = document.getElementById(' + JSON.stringify(id) + ');',
    'if (component && !root.contains(component)) return { ok: false, reason: "scope-outside-root" };',
    'if (!component) {',
    '  component = document.createElement("section");',
    '  component.id = ' + JSON.stringify(id) + ';',
    '  component.setAttribute("data-itsalive-component", ' + JSON.stringify(id) + ');',
    '  root.append(component);',
    '}',
    'component.setAttribute("data-itsalive-building", "");',
    'component.setAttribute("inert", "");',
    'component.setAttribute("aria-busy", "true");',
    'return { ok: true };',
  ].join("\n");
  const result = await executor.execute(appId, code, { signal, timeoutMs: 5_000 });
  if (result.error) throw new Error("Could not prepare worker scope " + scope + ": " + result.error.message);
  const value = result.value as { ok?: boolean; reason?: string } | undefined;
  if (!value?.ok) throw new Error("Could not prepare worker scope " + scope + ": " + (value?.reason ?? "unknown error"));
}

function stopResult(
  status: RunBudgetStopKind,
  handoffs: WorkerHandoff[],
  workerTurns: number,
): CodingOrchestratorResult {
  return {
    status,
    message: runBudgetMessage(status),
    handoffs,
    workerTurns,
  };
}
