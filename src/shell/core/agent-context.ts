export type AgentRole =
  | "user-intent"
  | "coding-manager"
  | "component-worker"
  | "repair-worker"
  | "runtime-llm";

export interface AgentContextContract {
  role: AgentRole;
  stable: readonly string[];
  dynamic: readonly string[];
  justInTime: readonly string[];
  neverRepeat: readonly string[];
}

/**
 * Context policy, not orchestration.
 *
 * These contracts deliberately describe information classes rather than concrete
 * prompt strings so later agent profiles can change wording/model/provider
 * without changing the ownership boundary.
 */
export const AGENT_CONTEXT_CONTRACTS: Readonly<Record<AgentRole, AgentContextContract>> = Object.freeze({
  "user-intent": {
    role: "user-intent",
    stable: [
      "Interpret user meaning before coding is authorized.",
      "Explanation, question, preference, and telemetry are not code authorization by themselves.",
      "Return the structured intent decision contract.",
    ],
    dynamic: [
      "Current app purpose.",
      "Current user input and input source.",
      "Selected behavioral summary when it materially helps interpretation.",
      "Selected interaction telemetry when relevant.",
    ],
    justInTime: [
      "Compact capability index for capabilities the user request may need.",
    ],
    neverRepeat: [
      "Coding-agent transcript.",
      "Full app HTML.",
      "Unrelated historical interaction logs.",
    ],
  },
  "coding-manager": {
    role: "coding-manager",
    stable: [
      "Own decomposition, shared contracts, dependency ordering, delegation, and final verification.",
      "Keep worker tasks scoped and independently verifiable.",
      "Pass technical intent rather than raw user conversation.",
    ],
    dynamic: [
      "Current technical intent and acceptance criteria.",
      "Compact current app/work-state summary.",
      "Shared design/state contracts.",
      "Task dependency graph and worker results.",
    ],
    justInTime: [
      "Focused DOM/state inspection needed to plan or integrate.",
      "Relevant platform capability help.",
      "Relevant errors/log summaries.",
    ],
    neverRepeat: [
      "Raw user/assistant chat.",
      "Full worker transcripts.",
      "Full document snapshots when a compact work-state summary is sufficient.",
      "Full platform capability manual.",
    ],
  },
  "component-worker": {
    role: "component-worker",
    stable: [
      "Modify only the assigned component/scope unless the manager explicitly broadens the task.",
      "Use native browser/DOM APIs and the supplied component reference.",
      "Verify the assigned acceptance criteria before returning a handoff.",
    ],
    dynamic: [
      "One concrete task with acceptance criteria.",
      "Assigned component/scope.",
      "Relevant shared design/state contracts.",
      "Relevant dependencies/interfaces.",
    ],
    justInTime: [
      "Selected capability help needed by this task.",
      "Focused DOM inspection inside the assigned scope.",
      "Relevant runtime errors or logs.",
    ],
    neverRepeat: [
      "Raw user conversation.",
      "Unrelated app components.",
      "Other workers' detailed transcripts.",
      "Full platform capability manual.",
      "Whole-app HTML by default.",
    ],
  },
  "repair-worker": {
    role: "repair-worker",
    stable: [
      "Diagnose from evidence before changing code.",
      "Keep the repair limited to the assigned scope and preserve working behavior.",
      "Verify that the observed failure is gone and the requested behavior works.",
    ],
    dynamic: [
      "Assigned scope.",
      "Latest failing observation/error.",
      "Expected behavior and regression constraints.",
      "Relevant shared state/interface contract.",
    ],
    justInTime: [
      "Recent bounded logs.",
      "Focused DOM/state inspection.",
      "Selected platform capability help.",
    ],
    neverRepeat: [
      "Raw chat transcript.",
      "Unrelated successful worker history.",
      "Full document snapshots unless the failure genuinely spans the document.",
    ],
  },
  "runtime-llm": {
    role: "runtime-llm",
    stable: [
      "Answer only the active app's runtime request.",
      "Do not inherit coding-agent policy or history.",
    ],
    dynamic: [
      "The runtime prompt supplied by the app.",
    ],
    justInTime: [],
    neverRepeat: [
      "Coding transcript.",
      "App HTML.",
      "Shell behavioral history.",
      "Platform capability documentation.",
    ],
  },
});

export function agentContextContract(role: AgentRole): AgentContextContract {
  return AGENT_CONTEXT_CONTRACTS[role];
}

export interface WorkerHandoff {
  status: "done" | "blocked" | "failed";
  scope: string;
  changed: string[];
  verified: string[];
  unresolved?: string[];
  sharedContractChanges?: string[];
  /** A broader/different scope the worker needs instead of silently expanding ownership. */
  requestedScope?: string;
}

/**
 * Worker handoffs intentionally contain durable coordination state only.
 * Detailed worker transcripts stay isolated from manager context.
 */
export function compactWorkerHandoff(handoff: WorkerHandoff): string {
  return JSON.stringify({
    status: handoff.status,
    scope: handoff.scope.trim(),
    changed: handoff.changed.map(value => value.trim()).filter(Boolean),
    verified: handoff.verified.map(value => value.trim()).filter(Boolean),
    ...(handoff.unresolved?.length
      ? { unresolved: handoff.unresolved.map(value => value.trim()).filter(Boolean) }
      : {}),
    ...(handoff.sharedContractChanges?.length
      ? { sharedContractChanges: handoff.sharedContractChanges.map(value => value.trim()).filter(Boolean) }
      : {}),
    ...(handoff.requestedScope?.trim() ? { requestedScope: handoff.requestedScope.trim() } : {}),
  });
}
