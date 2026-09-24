import { AgentRunner, type AgentContextDiagnostic, type AgentProgress, type AppExecutor, type CompletionAssessor, type FailureAssessor, type RunResult } from "./agent-runner";
import type { ContextRelevanceAssessor } from "./context-relevance";
import { normalizeAlivePolicyProposal, type AlivePolicy, type AlivePolicyProposal } from "./alive-policy";
import { IsolatedAgentHistory } from "./agent-history";
import { compactWorkerHandoff, type WorkerHandoff } from "./agent-context";
import type { ShellDatabase } from "./database";
import { platformCapabilityHelp, isPlatformCapabilityId, type PlatformCapabilityId } from "./capabilities";
import type { AgentProfileId, ResolvedAgentProfile } from "./agent-profiles";
import type { ProviderRegistry } from "./providers";
import { RunBudgetController, runBudgetMessage, type RunBudgetLimits, type RunBudgetStopKind } from "./run-budget";
import { createAgentTimeout } from "./run-lifecycle";
import { createLlmTraceIdentity } from "./llm-trace";
import type { Credential, LlmTraceIdentity } from "./types";

export interface CodingManagerSharedContracts {
  ref: string;
  design: string[];
  state: string[];
}

export interface WorkerBudgetOverride {
  maxDurationMs?: number;
  maxCostUsd?: number | null;
}

export interface CodingWorkerTask {
  id: string;
  goal: string;
  scope: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  capabilityIds: PlatformCapabilityId[];
  profile: "component-worker" | "repair-worker";
  sharedContractRef: string;
  parallel: boolean;
  budget?: WorkerBudgetOverride;
}

export interface CodingManagerPlan {
  shared: CodingManagerSharedContracts;
  tasks: CodingWorkerTask[];
  alivePolicy?: AlivePolicyProposal;
}

export interface ManagerVerification {
  ok: boolean;
  summary: string;
  unresolved: string[];
}

export type CodingOrchestratorStatus =
  | "done"
  | "clarification-needed"
  | "failure-stop"
  | "manager-verification-failed"
  | "worker-error"
  | RunBudgetStopKind;

export interface WorkerTimelineEntry {
  taskId: string;
  runId: string;
  agentId: string;
  scope: string;
  profile: AgentProfileId;
  model: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  status: string;
}

export type ComponentBuildState =
  | "queued"
  | "building"
  | "repairing"
  | "verifying"
  | "ready"
  | "failed"
  | "blocked";

export interface CodingLifecycleSummary {
  phase: "planning" | "working" | "integration-verification";
  total: number;
  queued: number;
  building: number;
  repairing: number;
  verifying: number;
  ready: number;
  failed: number;
  blocked: number;
}

export interface CodingOrchestratorResult {
  status: CodingOrchestratorStatus;
  message?: string;
  plan?: CodingManagerPlan;
  handoffs: WorkerHandoff[];
  workerTurns: number;
  timeline: WorkerTimelineEntry[];
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
  /** Bounded worker concurrency. Defaults to 3. */
  maxParallelWorkers?: number;
  consumeEnvironmentObservations?: () => string[];
  onProgress?: (progress: AgentProgress & { workerId?: string; scope?: string }) => void;
  /** Aggregate component lifecycle, used by shell progress UI. */
  onLifecycle?: (summary: CodingLifecycleSummary) => void;
  onContext?: (context: AgentContextDiagnostic) => void;
  /** Shell-owned bounded completion assessment reused by every scoped worker. */
  completionAssessor?: CompletionAssessor;
  /** Shell-owned semantic failure routing reused by every scoped worker. */
  failureAssessor?: FailureAssessor;
  /** Shell-owned bounded evidence relevance filtering reused by every scoped worker. */
  contextRelevanceAssessor?: ContextRelevanceAssessor;
  /** Current shell-owned app policy supplied to the manager for controlled revision. */
  alivePolicy?: AlivePolicy;
  /** Bounded JEV routing hint. The manager still owns decomposition and final worker choice. */
  preferredWorkerProfile?: "component-worker" | "repair-worker";
  triggerRoute?: string;
  /** Called only after successful integration verification. */
  onAlivePolicyProposal?: (proposal: AlivePolicyProposal) => Promise<void>;
}

interface WorkerRunOutcome {
  task: CodingWorkerTask;
  handoff: WorkerHandoff;
  turns: number;
  timeline: WorkerTimelineEntry;
  runStatus?: RunResult["status"];
  message?: string;
}

const MANAGER_PLAN_SYSTEM = [
  "You are the coding manager for one live browser app.",
  "Plan implementation; do not write DOM mutation code.",
  "",
  "Return JSON only:",
  "{\"shared\":{\"ref\":\"shared-v1\",\"design\":[\"...\"],\"state\":[\"...\"]},\"alivePolicy\":{\"meaningfulEvents\":[{\"id\":\"event-id\",\"description\":\"...\",\"match\":{\"interactionTypes\":[\"click\"],\"targetIds\":[\"stable-id\"],\"targetHints\":[\"Exact accessible label\"]}}],\"repeatableInteractions\":[],\"successSignals\":[\"...\"],\"safeReactions\":[{\"id\":\"reaction-id\",\"label\":\"...\",\"kind\":\"suggest|highlight|offer-existing-action\"}],\"invariants\":[\"...\"],\"clarificationSignals\":[\"...\"],\"agentSignals\":[\"...\"],\"retainEvidence\":[\"...\"]},\"tasks\":[{\"id\":\"short-id\",\"goal\":\"...\",\"scope\":\"#component-id\",\"acceptanceCriteria\":[\"...\"],\"dependencies\":[\"earlier-task-id\"],\"capabilityIds\":[\"valid-id\"],\"profile\":\"component-worker|repair-worker\",\"sharedContractRef\":\"shared-v1\",\"parallel\":true,\"budget\":{\"maxDurationMs\":120000,\"maxCostUsd\":null}}]}",
  "",
  "Rules:",
  "- Use the supplied TECHNICAL INTENT as authoritative. Raw chat is intentionally absent.",
  "- Shared design/state contracts are written once here, then referenced by workers.",
  "- Use one ordered task for a truly atomic change; use 2+ tasks when distinct components/work units exist.",
  "- Every scope must be a simple #id selector using letters, numbers, _ or -.",
  "- Reuse an existing component id from APP OUTLINE when it clearly owns the work; otherwise choose a new stable id.",
  "- Dependencies may reference only earlier task ids.",
  "- shared.ref is a compact version/reference. Every task must repeat that exact value in sharedContractRef.",
  "- Set parallel=true only when the task can safely overlap other dependency-ready tasks on a different scope.",
  "- Use parallel=false for manager-ordered/shared-state-sensitive work.",
  "- Worker budget overrides may only tighten maxDurationMs/maxCostUsd; profile defaults remain the ceiling.",
  "- component-worker is the default. Use repair-worker only when the task is primarily diagnosis/repair.",
  "- A ROUTING HINT is advisory bounded classification, not technical intent. If preferredWorkerProfile=repair-worker and the task is genuinely diagnosis/repair, prefer repair-worker; never distort the task merely to match the hint.",
  "- capabilityIds may contain only platform capability ids relevant to that worker.",
  "- Keep tasks non-overlapping. A worker owns only its assigned scope.",
  "- The manager owns decomposition, shared contracts, ordering and final integration verification.",
  "- alivePolicy is declarative app-specific context, never executable code and never permission for silent mutation.",
  "- Use stable ids/exact semantic target hints for app-specific meaningful/repeatable interactions; do not encode generic shell heuristics.",
  "- safeReactions must describe only reversible suggestions/highlights/existing actions. User confirmation and shell invariants remain authoritative.",
  "- Preserve or refine CURRENT ALIVE POLICY when it still matches the resulting app; update it when structural/semantic targets change."
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
  "The shell owns data-itsalive-building, data-itsalive-build-state, data-itsalive-build-owner, inert, and aria-busy on the assigned component root.",
  "Do not remove or rewrite those root lifecycle attributes. Build and verify the content while the region is inert; the shell reveals it after scoped verification.",
  "",
  "HANDOFF",
  "On success, the final done payload must be JSON only with:",
  "{\"status\":\"done|blocked\",\"changed\":[\"short durable outcome\"],\"verified\":[\"observable checks\"],\"unresolved\":[],\"sharedContractChanges\":[],\"requestedScope\":\"#broader-scope-or-empty\"}",
  "If the task needs ownership outside ASSIGNED SCOPE, do not edit there. Return status=blocked with requestedScope and explain the dependency in unresolved.",
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
  private readonly activeWorkers = new Map<string, AbortController>();

  constructor(
    private readonly db: ShellDatabase,
    private readonly providers: ProviderRegistry,
    private readonly executor: AppExecutor,
  ) {}

  cancelWorker(taskId: string, reason: unknown = new DOMException("Worker interrupted", "AbortError")): boolean {
    const controller = this.activeWorkers.get(taskId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(reason);
    return true;
  }

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
      options.onLifecycle?.(emptyLifecycleSummary("planning"));
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

      const maxParallelWorkers = normalizeParallelism(options.maxParallelWorkers);
      const uniqueScopes = [...new Set(plan.tasks.map(task => task.scope))];
      const scopeStates = new Map<string, ComponentBuildState>(uniqueScopes.map(scope => [scope, "queued"]));
      const reportScopeState = (scope: string, state: ComponentBuildState) => {
        scopeStates.set(scope, state);
        const summary = lifecycleSummary(scopeStates, "working");
        console.info("Component lifecycle", { parentRunId: options.managerTrace.runId, scope, state, summary });
        options.onLifecycle?.(summary);
      };
      for (const scope of uniqueScopes) {
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
        await ensureWorkerScope(this.executor, options.appId, scope, controller.signal);
      }
      options.onLifecycle?.(lifecycleSummary(scopeStates, "working"));
      const scopeConflicts = await inspectScopeConflicts(this.executor, options.appId, uniqueScopes, controller.signal);
      const handoffByTask = new Map<string, WorkerHandoff>();
      const pending = new Set(plan.tasks.map(task => task.id));
      const timeline: WorkerTimelineEntry[] = [];

      while (pending.size) {
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");

        const newlyBlocked = propagateBlockedDependencies(plan, pending, handoffByTask);
        for (const taskId of newlyBlocked) {
          const task = plan.tasks.find(candidate => candidate.id === taskId)!;
          await setWorkerScopeState(this.executor, options.appId, task.scope, "blocked", controller.signal);
          reportScopeState(task.scope, "blocked");
        }

        const ready = plan.tasks.filter(task =>
          pending.has(task.id)
          && task.dependencies.every(dependency => handoffByTask.get(dependency)?.status === "done")
        );
        if (!ready.length) {
          // Any remaining task is blocked by a failed/unresolved dependency.
          for (const task of plan.tasks) {
            if (!pending.has(task.id)) continue;
            const blockers = task.dependencies.filter(id => handoffByTask.get(id)?.status !== "done");
            handoffByTask.set(task.id, {
              status: "blocked",
              scope: task.scope,
              changed: [],
              verified: [],
              unresolved: ["Blocked by dependency: " + (blockers.join(", ") || "unknown dependency")],
            });
            pending.delete(task.id);
            await setWorkerScopeState(this.executor, options.appId, task.scope, "blocked", controller.signal);
            reportScopeState(task.scope, "blocked");
          }
          break;
        }

        const wave = chooseWorkerWave(ready, scopeConflicts, maxParallelWorkers);
        const waveIds = new Set(wave.map(task => task.id));
        const conflictDeferred = ready.filter(task =>
          !waveIds.has(task.id)
          && task.parallel
          && wave.some(active => scopesConflict(active.scope, task.scope, scopeConflicts))
        );
        if (conflictDeferred.length) {
          console.info("Worker scope conflict serialized", {
            parentRunId: options.managerTrace.runId,
            deferred: conflictDeferred.map(task => ({ id: task.id, scope: task.scope })),
            active: wave.map(task => ({ id: task.id, scope: task.scope })),
          });
        }
        console.info("Worker wave started", {
          parentRunId: options.managerTrace.runId,
          tasks: wave.map(task => ({ id: task.id, scope: task.scope, profile: task.profile })),
        });
        const outcomes = await Promise.all(wave.map(task =>
          this.runWorkerTask(
            options,
            plan,
            task,
            task.dependencies.map(id => handoffByTask.get(id)).filter((value): value is WorkerHandoff => Boolean(value)),
            rootBudget,
            controller.signal,
            reportScopeState,
            !plan.tasks.some(other => pending.has(other.id) && other.id !== task.id && other.scope === task.scope),
          )
        ));
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");

        outcomes.sort((left, right) =>
          plan.tasks.findIndex(task => task.id === left.task.id) - plan.tasks.findIndex(task => task.id === right.task.id)
        );
        for (const outcome of outcomes) {
          pending.delete(outcome.task.id);
          handoffByTask.set(outcome.task.id, outcome.handoff);
          workerTurns += outcome.turns;
          timeline.push(outcome.timeline);
        }

        const terminalFailure = outcomes.find(outcome =>
          outcome.runStatus === "clarification-needed" || outcome.runStatus === "failure-stop"
        );
        if (terminalFailure?.runStatus) {
          for (const task of plan.tasks) {
            if (!pending.has(task.id)) continue;
            handoffByTask.set(task.id, {
              status: "blocked",
              scope: task.scope,
              changed: [],
              verified: [],
              unresolved: ["Run stopped before this component could finish: " + terminalFailure.runStatus],
            });
            pending.delete(task.id);
            await setWorkerScopeState(this.executor, options.appId, task.scope, "blocked", controller.signal);
            reportScopeState(task.scope, "blocked");
          }
          return {
            status: terminalFailure.runStatus,
            message: terminalFailure.message,
            plan,
            handoffs: orderedHandoffs(plan, handoffByTask),
            workerTurns,
            timeline,
          };
        }

        const rootStop = rootBudget.currentStopReason();
        if (rootStop) {
          for (const task of plan.tasks) {
            if (!pending.has(task.id)) continue;
            handoffByTask.set(task.id, {
              status: "blocked",
              scope: task.scope,
              changed: [],
              verified: [],
              unresolved: ["Run stopped before this component could finish: " + rootStop],
            });
            pending.delete(task.id);
            await setWorkerScopeState(this.executor, options.appId, task.scope, "blocked", controller.signal);
            reportScopeState(task.scope, "blocked");
          }
          const ordered = orderedHandoffs(plan, handoffByTask);
          return {
            ...stopResult(rootStop, ordered, workerTurns, timeline),
            plan,
          };
        }
      }

      handoffs.push(...orderedHandoffs(plan, handoffByTask));

      options.onLifecycle?.(lifecycleSummary(scopeStates, "integration-verification"));
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
      const hasBlockedWorker = handoffs.some(handoff => handoff.status !== "done");
      if (verification.ok && !hasBlockedWorker) {
        if (plan.alivePolicy && options.onAlivePolicyProposal) {
          try { await options.onAlivePolicyProposal(plan.alivePolicy); }
          catch (error) { console.warn("Alive policy proposal was not activated", error); }
        }
        return {
          status: "done",
          message: verification.summary || "Done — it’s ready.",
          plan,
          handoffs,
          workerTurns,
          timeline,
        };
      }
      if (finalCostStop) return { ...stopResult(finalCostStop, handoffs, workerTurns, timeline), plan };
      return {
        status: "manager-verification-failed",
        message: verification.summary || "Final integration verification found unfinished work.",
        plan,
        handoffs,
        workerTurns,
        timeline,
      };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", relayAbort);
    }
  }

  private async runWorkerTask(
    options: CodingOrchestratorOptions,
    plan: CodingManagerPlan,
    task: CodingWorkerTask,
    dependencyHandoffs: WorkerHandoff[],
    rootBudget: RunBudgetController,
    parentSignal: AbortSignal,
    reportScopeState: (scope: string, state: ComponentBuildState) => void,
    revealOnSuccess: boolean,
  ): Promise<WorkerRunOutcome> {
    const profile = await options.resolveProfile(task.profile);
    const workerTrace = createLlmTraceIdentity(profile.role, profile.id, {
      parentRunId: options.managerTrace.runId,
      parentAgentId: options.managerTrace.agentId,
      scope: task.scope,
    });
    const child = new AbortController();
    const relayParent = () => child.abort(parentSignal.reason);
    if (parentSignal.aborted) relayParent();
    else parentSignal.addEventListener("abort", relayParent, { once: true });
    this.activeWorkers.set(task.id, child);

    const startedAt = Date.now();
    let turns = 0;
    let status = "worker-error";
    let runStatus: RunResult["status"] | undefined;
    let message: string | undefined;
    let handoff: WorkerHandoff;
    let stateWrites = Promise.resolve();
    let queuedState: ComponentBuildState = "building";
    const queueState = (state: ComponentBuildState) => {
      if (queuedState === state) return;
      queuedState = state;
      reportScopeState(task.scope, state);
      stateWrites = stateWrites
        .then(() => setWorkerScopeState(this.executor, options.appId, task.scope, state, parentSignal))
        .catch(error => console.warn("Component lifecycle update failed", { taskId: task.id, scope: task.scope, state, error }));
    };

    try {
      await setWorkerScopeState(this.executor, options.appId, task.scope, "building", parentSignal);
      reportScopeState(task.scope, "building");
      const isolatedHistory = new IsolatedAgentHistory();
      const runner = new AgentRunner(this.db, this.providers, this.executor);
      const result = await runner.run({
        appId: options.appId,
        appPrompt: options.appPrompt,
        trigger: workerTaskInput(plan, task, dependencyHandoffs),
        persistTrigger: false,
        model: profile.modelConfig,
        systemPrompt: WORKER_SYSTEM,
        history: isolatedHistory,
        scopeSelector: task.scope,
        includeRawCompletionMessage: true,
        budgetController: rootBudget.fork(tightenWorkerBudget(profile.budgets, task.budget)),
        trace: workerTrace,
        credential: options.credential,
        signal: child.signal,
        consumeEnvironmentObservations: options.consumeEnvironmentObservations,
        onProgress: progress => {
          options.onProgress?.({ ...progress, workerId: task.id, scope: task.scope });
          const state = componentStateForProgress(progress.phase);
          if (state) queueState(state);
        },
        onContext: options.onContext,
        completionAssessor: options.completionAssessor,
        failureAssessor: options.failureAssessor,
        contextRelevanceAssessor: options.contextRelevanceAssessor,
      });
      turns = result.turns;
      runStatus = result.status;
      message = result.message;
      await stateWrites;
      handoff = workerHandoff(task, result.status, result.rawMessage, result.message);
      status = handoff.status === "done" ? result.status : "blocked";
      const terminalState: ComponentBuildState = handoff.status === "done"
        ? (revealOnSuccess ? "ready" : "queued")
        : handoff.status === "failed" ? "failed" : "blocked";
      await setWorkerScopeState(this.executor, options.appId, task.scope, terminalState, parentSignal);
      reportScopeState(task.scope, terminalState);
    } catch (error) {
      await stateWrites;
      status = child.signal.aborted ? "worker-cancelled" : "worker-error";
      handoff = {
        status: "failed",
        scope: task.scope,
        changed: [],
        verified: [],
        unresolved: [error instanceof Error ? error.message : String(error)],
      };
      const terminalState: ComponentBuildState = child.signal.aborted ? "blocked" : "failed";
      try { await setWorkerScopeState(this.executor, options.appId, task.scope, terminalState, parentSignal); }
      catch (stateError) { console.warn("Could not persist terminal component state", { taskId: task.id, state: terminalState, stateError }); }
      reportScopeState(task.scope, terminalState);
    } finally {
      parentSignal.removeEventListener("abort", relayParent);
      if (this.activeWorkers.get(task.id) === child) this.activeWorkers.delete(task.id);
    }

    const endedAt = Date.now();
    const timeline: WorkerTimelineEntry = {
      taskId: task.id,
      runId: workerTrace.runId,
      agentId: workerTrace.agentId,
      scope: task.scope,
      profile: profile.id,
      model: profile.modelConfig.model,
      startedAt,
      endedAt,
      elapsedMs: Math.max(0, endedAt - startedAt),
      status,
    };
    console.info("Worker lifecycle", timeline);
    return { task, handoff, turns, timeline, ...(runStatus ? { runStatus } : {}), ...(message ? { message } : {}) };
  }
}

function emptyLifecycleSummary(phase: CodingLifecycleSummary["phase"]): CodingLifecycleSummary {
  return {
    phase,
    total: 0,
    queued: 0,
    building: 0,
    repairing: 0,
    verifying: 0,
    ready: 0,
    failed: 0,
    blocked: 0,
  };
}

function lifecycleSummary(
  states: ReadonlyMap<string, ComponentBuildState>,
  phase: CodingLifecycleSummary["phase"],
): CodingLifecycleSummary {
  const summary = emptyLifecycleSummary(phase);
  summary.total = states.size;
  for (const state of states.values()) summary[state]++;
  return summary;
}

function componentStateForProgress(phase: AgentProgress["phase"]): ComponentBuildState | undefined {
  if (phase === "repairing") return "repairing";
  if (phase === "verifying" || phase === "finishing") return "verifying";
  if (phase === "generating" || phase === "executing") return "building";
  return undefined;
}

function normalizeParallelism(value: number | undefined): number {
  if (value == null) return 3;
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(6, Math.floor(value)));
}

function tightenWorkerBudget(base: RunBudgetLimits, override: WorkerBudgetOverride | undefined): RunBudgetLimits {
  if (!override) return { ...base };
  const maxDurationMs = override.maxDurationMs == null
    ? base.maxDurationMs
    : Math.min(base.maxDurationMs, Math.max(1, Math.floor(override.maxDurationMs)));
  let maxCostUsd = base.maxCostUsd;
  if (typeof override.maxCostUsd === "number" && override.maxCostUsd > 0) {
    maxCostUsd = base.maxCostUsd == null ? override.maxCostUsd : Math.min(base.maxCostUsd, override.maxCostUsd);
  }
  return { ...base, maxDurationMs, maxCostUsd };
}

function scopeConflictKey(left: string, right: string): string {
  return left < right ? left + "\u001f" + right : right + "\u001f" + left;
}

function scopesConflict(left: string, right: string, conflicts: ReadonlySet<string>): boolean {
  return left === right || conflicts.has(scopeConflictKey(left, right));
}

function chooseWorkerWave(
  ready: readonly CodingWorkerTask[],
  conflicts: ReadonlySet<string>,
  maxParallelWorkers: number,
): CodingWorkerTask[] {
  const first = ready[0];
  if (!first) return [];
  const wave = [first];
  if (!first.parallel || maxParallelWorkers === 1) return wave;

  for (const candidate of ready.slice(1)) {
    if (!candidate.parallel) break;
    if (wave.length >= maxParallelWorkers) break;
    if (wave.some(active => scopesConflict(active.scope, candidate.scope, conflicts))) continue;
    wave.push(candidate);
  }
  return wave;
}

function propagateBlockedDependencies(
  plan: CodingManagerPlan,
  pending: Set<string>,
  handoffs: Map<string, WorkerHandoff>,
): string[] {
  const blocked: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of plan.tasks) {
      if (!pending.has(task.id)) continue;
      const blockers = task.dependencies.filter(id => {
        const handoff = handoffs.get(id);
        return handoff != null && handoff.status !== "done";
      });
      if (!blockers.length) continue;
      handoffs.set(task.id, {
        status: "blocked",
        scope: task.scope,
        changed: [],
        verified: [],
        unresolved: ["Blocked by dependency: " + blockers.join(", ")],
      });
      pending.delete(task.id);
      blocked.push(task.id);
      changed = true;
    }
  }
  return blocked;
}

function orderedHandoffs(plan: CodingManagerPlan, handoffs: ReadonlyMap<string, WorkerHandoff>): WorkerHandoff[] {
  return plan.tasks.map(task => handoffs.get(task.id)).filter((value): value is WorkerHandoff => Boolean(value));
}

async function inspectScopeConflicts(
  executor: AppExecutor,
  appId: string,
  scopes: readonly string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  if (scopes.length < 2) return new Set();
  const code = [
    "const selectors = " + JSON.stringify(scopes) + ";",
    "const nodes = selectors.map(selector => ({ selector, element: document.querySelector(selector) }));",
    "const overlaps = [];",
    "for (let i = 0; i < nodes.length; i++) {",
    "  for (let j = i + 1; j < nodes.length; j++) {",
    "    const left = nodes[i]; const right = nodes[j];",
    "    if (left.element && right.element && (left.element.contains(right.element) || right.element.contains(left.element))) overlaps.push([left.selector, right.selector]);",
    "  }",
    "}",
    "return overlaps;",
  ].join("\n");
  const result = await executor.execute(appId, code, { signal, timeoutMs: 5_000 });
  if (result.error) throw new Error("Could not inspect worker scope conflicts: " + result.error.message);
  const pairs = Array.isArray(result.value) ? result.value : [];
  const conflicts = new Set<string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
    conflicts.add(scopeConflictKey(pair[0], pair[1]));
  }
  return conflicts;
}

function managerPlanInput(options: CodingOrchestratorOptions, outline: unknown): string {
  return [
    "APP PURPOSE\n" + options.appPrompt.trim(),
    "TECHNICAL INTENT\n" + options.technicalIntent.trim(),
    "CURRENT ALIVE POLICY\n" + JSON.stringify(options.alivePolicy ?? null),
    options.triggerRoute || options.preferredWorkerProfile
      ? "ROUTING HINT\n" + JSON.stringify({
          route: options.triggerRoute ?? null,
          preferredWorkerProfile: options.preferredWorkerProfile ?? null,
        })
      : "",
    "APP OUTLINE\n" + JSON.stringify(outline),
  ].filter(Boolean).join("\n\n");
}

function managerVerificationInput(
  options: CodingOrchestratorOptions,
  plan: CodingManagerPlan,
  handoffs: WorkerHandoff[],
  outline: unknown,
): string {
  return [
    "TECHNICAL INTENT\n" + options.technicalIntent.trim(),
    "SHARED CONTRACT REF\n" + plan.shared.ref,
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
    "SHARED CONTRACT REF\n" + task.sharedContractRef,
    "SHARED DESIGN CONTRACT\n" + list(plan.shared.design),
    "SHARED STATE CONTRACT\n" + list(plan.shared.state),
    "DEPENDENCY HANDOFFS\n" + (dependencyHandoffs.map(compactWorkerHandoff).join("\n") || "(none)"),
    "RELEVANT PLATFORM CAPABILITIES\n" + platformCapabilityHelp(task.capabilityIds),
  ].join("\n\n");
}

function parseWorkerBudget(value: unknown): WorkerBudgetOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const budget: WorkerBudgetOverride = {};
  if (typeof record.maxDurationMs === "number" && Number.isFinite(record.maxDurationMs) && record.maxDurationMs > 0) {
    budget.maxDurationMs = Math.floor(record.maxDurationMs);
  }
  if (record.maxCostUsd === null) budget.maxCostUsd = null;
  else if (typeof record.maxCostUsd === "number" && Number.isFinite(record.maxCostUsd) && record.maxCostUsd > 0) {
    budget.maxCostUsd = record.maxCostUsd;
  }
  return Object.keys(budget).length ? budget : undefined;
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
  const sharedRef = typeof sharedRecord.ref === "string" && TASK_ID.test(sharedRecord.ref.trim())
    ? sharedRecord.ref.trim()
    : "shared-v1";
  const shared: CodingManagerSharedContracts = {
    ref: sharedRef,
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
    const sharedContractRef = typeof task.sharedContractRef === "string" && task.sharedContractRef.trim()
      ? task.sharedContractRef.trim()
      : shared.ref;
    if (sharedContractRef !== shared.ref) throw new Error("Coding manager task " + id + " references a different shared contract");
    const parallel = task.parallel === true;
    const budget = parseWorkerBudget(task.budget);
    seen.add(id);
    return {
      id,
      goal,
      scope,
      acceptanceCriteria: stringArray(task.acceptanceCriteria, 12),
      dependencies,
      capabilityIds,
      profile,
      sharedContractRef,
      parallel,
      ...(budget ? { budget } : {}),
    };
  });
  const alivePolicy = normalizeAlivePolicyProposal(record.alivePolicy);
  return { shared, tasks, ...(alivePolicy ? { alivePolicy } : {}) };
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
  status: RunResult["status"],
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
        const requestedScope = typeof record.requestedScope === "string" && record.requestedScope.trim()
          ? record.requestedScope.trim()
          : undefined;
        const handoffStatus = record.status === "blocked" || requestedScope ? "blocked" : "done";
        return {
          status: handoffStatus,
          scope: task.scope,
          changed: stringArray(record.changed, 12),
          verified: stringArray(record.verified, 12),
          ...(unresolved.length ? { unresolved } : {}),
          ...(sharedContractChanges.length ? { sharedContractChanges } : {}),
          ...(requestedScope ? { requestedScope } : {}),
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
    '    buildState: element.getAttribute("data-itsalive-build-state"),',
    '    textPreview: (element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 180),',
    '  })),',
    '} : { exists: false, childCount: 0, children: [] };',
  ].join("\n");
  const result = await executor.execute(appId, code, { signal, timeoutMs: 5_000 });
  if (result.error) throw new Error("Could not inspect app outline: " + result.error.message);
  return result.value;
}

async function setWorkerScopeState(
  executor: AppExecutor,
  appId: string,
  scope: string,
  state: ComponentBuildState,
  signal: AbortSignal,
): Promise<void> {
  const code = [
    'const component = document.querySelector(' + JSON.stringify(scope) + ');',
    'if (!component) return { ok: false, reason: "missing-scope" };',
    'const state = ' + JSON.stringify(state) + ';',
    'if (state === "ready") {',
    '  component.removeAttribute("data-itsalive-building");',
    '  component.removeAttribute("data-itsalive-build-state");',
    '  component.removeAttribute("data-itsalive-build-owner");',
    '  component.removeAttribute("inert");',
    '  component.removeAttribute("aria-busy");',
    '} else {',
    '  component.setAttribute("data-itsalive-build-owner", "shell");',
    '  component.setAttribute("data-itsalive-build-state", state);',
    '  component.setAttribute("data-itsalive-building", "");',
    '  component.setAttribute("inert", "");',
    '  if (state === "failed" || state === "blocked") component.removeAttribute("aria-busy");',
    '  else component.setAttribute("aria-busy", "true");',
    '}',
    'return { ok: true, state };',
  ].join("\n");
  const result = await executor.execute(appId, code, { signal, timeoutMs: 5_000 });
  if (result.error) throw new Error("Could not set worker scope " + scope + " to " + state + ": " + result.error.message);
  const value = result.value as { ok?: boolean; reason?: string } | undefined;
  if (!value?.ok) throw new Error("Could not set worker scope " + scope + " to " + state + ": " + (value?.reason ?? "unknown error"));
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
    'component.setAttribute("data-itsalive-build-owner", "shell");',
    'component.setAttribute("data-itsalive-build-state", "queued");',
    'component.setAttribute("data-itsalive-building", "");',
    'component.setAttribute("inert", "");',
    'component.setAttribute("aria-busy", "true");',
    'return { ok: true, state: "queued" };',
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
  timeline: WorkerTimelineEntry[] = [],
): CodingOrchestratorResult {
  return {
    status,
    message: runBudgetMessage(status),
    handoffs,
    workerTurns,
    timeline,
  };
}
