import type { JevReplayFixture } from "../../src/shell/core/jev-eval";

export type JevFixtureAction = "no-op" | "escalate" | "finish" | "continue" | "repair" | "clarify" | "include" | "omit";

export interface SanitizedJevFixtureInput {
  signal: string;
  probability?: number;
}

export const SANITIZED_JEV_REPLAY_FIXTURES: readonly JevReplayFixture<SanitizedJevFixtureInput, JevFixtureAction>[] = [
  {
    id: "interaction-ordinary-success",
    description: "Ordinary successful interaction should not wake an adaptive agent.",
    decisionKind: "interaction-wake",
    questionSetVersion: "interaction-wake-v1",
    input: { signal: "single successful control activation with visible state change", probability: 0.08 },
    expectedAction: "no-op",
    risk: "false-positive",
  },
  {
    id: "interaction-benign-repeat",
    description: "Rapid intentional repeatable input should remain ordinary usage.",
    decisionKind: "interaction-wake",
    questionSetVersion: "interaction-wake-v1",
    input: { signal: "repeatable musical control used several times with state changes", probability: 0.22 },
    expectedAction: "no-op",
    risk: "false-positive",
  },
  {
    id: "interaction-clear-friction",
    description: "Repeated unchanged attempts are a meaningful unmet-intent signal.",
    decisionKind: "interaction-wake",
    questionSetVersion: "interaction-wake-v1",
    input: { signal: "same control attempted repeatedly with no visible outcome", probability: 0.82 },
    expectedAction: "escalate",
    risk: "false-negative",
  },
  {
    id: "completion-success",
    description: "Requested observable result is present and runtime checks are clean.",
    decisionKind: "agent-completion",
    questionSetVersion: "completion-v1",
    input: { signal: "acceptance criteria visible; no unresolved errors" },
    expectedAction: "finish",
    risk: "false-negative",
  },
  {
    id: "completion-silent-failure",
    description: "Agent claims done but one requested observable outcome is absent.",
    decisionKind: "agent-completion",
    questionSetVersion: "completion-v1",
    input: { signal: "requested control absent despite done signal" },
    expectedAction: "continue",
    risk: "false-positive",
  },
  {
    id: "repair-generated-code",
    description: "A local generated-code error has a plausible focused repair path.",
    decisionKind: "failure-route",
    questionSetVersion: "failure-route-v1",
    input: { signal: "compile/runtime error immediately after worker mutation" },
    expectedAction: "repair",
    risk: "false-negative",
  },
  {
    id: "repair-user-clarification",
    description: "Failure depends on missing user intent rather than more autonomous retries.",
    decisionKind: "failure-route",
    questionSetVersion: "failure-route-v1",
    input: { signal: "two incompatible outcomes both fit current technical evidence" },
    expectedAction: "clarify",
    risk: "false-positive",
  },
  {
    id: "context-relevant",
    description: "A prior error directly concerns the component being repaired.",
    decisionKind: "context-relevance",
    questionSetVersion: "context-relevance-v1",
    input: { signal: "recent error references current component and acceptance criterion" },
    expectedAction: "include",
    risk: "false-negative",
  },
  {
    id: "context-irrelevant",
    description: "Old unrelated app behavior should not pollute a scoped repair task.",
    decisionKind: "context-relevance",
    questionSetVersion: "context-relevance-v1",
    input: { signal: "historical observation concerns a different component and resolved task" },
    expectedAction: "omit",
    risk: "false-positive",
  },
] as const;
