import type { AgentRole } from "./agent-context";
import type { ModelConfig } from "./types";

export type AgentProfileId =
  | "user-intent"
  | "coding-manager"
  | "component-worker"
  | "repair-worker"
  | "runtime-llm"
  | "behavior-summary";

export type AgentComputeLevel = "low" | "medium" | "high";
export type AgentContextPolicyId =
  | "intent-minimal"
  | "manager-technical"
  | "component-scoped"
  | "repair-evidence"
  | "runtime-minimal"
  | "behavior-curation";
export type CapabilityExposurePolicy = "index" | "selected" | "none";

export interface AgentBudgetDefaults {
  maxDurationMs: number;
  idleTimeoutMs: number;
  /** Null means cost enforcement is intentionally disabled until a product budget is chosen. */
  maxCostUsd: number | null;
  maxConsecutiveFailures: number;
  stallRepeatLimit: number;
}

export interface AgentProfile {
  id: AgentProfileId;
  role: AgentRole | "behavior-summary";
  observabilityLabel: string;
  promptId: string;
  provider: string;
  model: string;
  compute: AgentComputeLevel;
  contextPolicy: AgentContextPolicyId;
  capabilityExposure: CapabilityExposurePolicy;
  outputHeadroomTokens: number;
  observationHeadroomTokens: number;
  historyBudget:
    | { kind: "settings" }
    | { kind: "cap"; tokens: number }
    | { kind: "fixed"; tokens: number };
  budgets: AgentBudgetDefaults;
}

export interface ResolveAgentProfileInput {
  contextCapacity: number;
  configuredHistoryTokens: number;
}

export interface ResolvedAgentProfile extends AgentProfile {
  modelConfig: ModelConfig;
}

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;

const budget = (overrides: Partial<AgentBudgetDefaults> = {}): AgentBudgetDefaults => ({
  maxDurationMs: DEFAULT_MAX_DURATION_MS,
  idleTimeoutMs: DEFAULT_IDLE_MS,
  maxCostUsd: null,
  maxConsecutiveFailures: 3,
  stallRepeatLimit: 2,
  ...overrides,
});

/**
 * Beta defaults are deliberately centralized and easy to change. Compute choices
 * are hypotheses to measure with #84/#85 telemetry, not permanent product policy.
 */
export const AGENT_PROFILES: Readonly<Record<AgentProfileId, AgentProfile>> = Object.freeze({
  "user-intent": {
    id: "user-intent",
    role: "user-intent",
    observabilityLabel: "user-intent",
    promptId: "user-intent-v1",
    provider: "openrouter",
    model: "openrouter/auto",
    compute: "medium",
    contextPolicy: "intent-minimal",
    capabilityExposure: "index",
    outputHeadroomTokens: 2_048,
    observationHeadroomTokens: 512,
    historyBudget: { kind: "fixed", tokens: 0 },
    budgets: budget({ maxDurationMs: 120_000, idleTimeoutMs: 45_000 }),
  },
  "coding-manager": {
    id: "coding-manager",
    role: "coding-manager",
    observabilityLabel: "coding-manager",
    promptId: "coding-production-v1",
    provider: "openrouter",
    model: "openrouter/auto",
    compute: "high",
    contextPolicy: "manager-technical",
    capabilityExposure: "selected",
    outputHeadroomTokens: 8_192,
    observationHeadroomTokens: 1_024,
    historyBudget: { kind: "settings" },
    budgets: budget(),
  },
  "component-worker": {
    id: "component-worker",
    role: "component-worker",
    observabilityLabel: "component-worker",
    promptId: "component-worker-v1",
    provider: "openrouter",
    model: "openrouter/auto",
    compute: "low",
    contextPolicy: "component-scoped",
    capabilityExposure: "selected",
    outputHeadroomTokens: 4_096,
    observationHeadroomTokens: 768,
    historyBudget: { kind: "cap", tokens: 4_000 },
    budgets: budget({ maxDurationMs: 4 * 60_000, idleTimeoutMs: 60_000 }),
  },
  "repair-worker": {
    id: "repair-worker",
    role: "repair-worker",
    observabilityLabel: "repair-worker",
    promptId: "repair-worker-v1",
    provider: "openrouter",
    model: "openrouter/auto",
    compute: "medium",
    contextPolicy: "repair-evidence",
    capabilityExposure: "selected",
    outputHeadroomTokens: 4_096,
    observationHeadroomTokens: 1_024,
    historyBudget: { kind: "cap", tokens: 6_000 },
    budgets: budget({ maxDurationMs: 4 * 60_000, idleTimeoutMs: 60_000 }),
  },
  "runtime-llm": {
    id: "runtime-llm",
    role: "runtime-llm",
    observabilityLabel: "runtime-llm",
    promptId: "runtime-llm-v1",
    provider: "openrouter",
    model: "openrouter/auto",
    compute: "low",
    contextPolicy: "runtime-minimal",
    capabilityExposure: "none",
    outputHeadroomTokens: 2_048,
    observationHeadroomTokens: 0,
    historyBudget: { kind: "fixed", tokens: 0 },
    budgets: budget({ maxDurationMs: 60_000, idleTimeoutMs: 30_000 }),
  },
  "behavior-summary": {
    id: "behavior-summary",
    role: "behavior-summary",
    observabilityLabel: "behavior-summary",
    promptId: "behavior-summary-v1",
    provider: "openrouter",
    model: "openrouter/auto",
    compute: "low",
    contextPolicy: "behavior-curation",
    capabilityExposure: "none",
    outputHeadroomTokens: 2_048,
    observationHeadroomTokens: 0,
    historyBudget: { kind: "fixed", tokens: 0 },
    budgets: budget({ maxDurationMs: 60_000, idleTimeoutMs: 30_000 }),
  },
});

export function agentProfile(id: AgentProfileId): AgentProfile {
  return AGENT_PROFILES[id];
}

function historyTokens(profile: AgentProfile, configured: number): number {
  const safeConfigured = Math.max(0, Math.floor(configured));
  if (profile.historyBudget.kind === "settings") return safeConfigured;
  if (profile.historyBudget.kind === "cap") return Math.min(safeConfigured, profile.historyBudget.tokens);
  return profile.historyBudget.tokens;
}

function providerOptions(profile: AgentProfile): Record<string, unknown> {
  if (profile.provider !== "openrouter") {
    throw new Error(`Agent profile ${profile.id} uses unsupported provider ${profile.provider}; compute mapping must be explicit`);
  }
  return { reasoning: { effort: profile.compute } };
}

export function resolveAgentProfile(
  id: AgentProfileId,
  input: ResolveAgentProfileInput,
): ResolvedAgentProfile {
  const profile = agentProfile(id);
  if (!Number.isFinite(input.contextCapacity) || input.contextCapacity <= 0) {
    throw new Error(`Invalid context capacity for agent profile ${id}`);
  }
  return {
    ...profile,
    modelConfig: {
      provider: profile.provider,
      model: profile.model,
      options: providerOptions(profile),
      maxContextTokens: Math.floor(input.contextCapacity),
      outputHeadroomTokens: profile.outputHeadroomTokens,
      historyContextTokens: historyTokens(profile, input.configuredHistoryTokens),
      observationHeadroomTokens: profile.observationHeadroomTokens,
    },
  };
}

export function agentProfileDiagnostic(profile: ResolvedAgentProfile): Record<string, unknown> {
  return {
    id: profile.id,
    role: profile.role,
    promptId: profile.promptId,
    provider: profile.provider,
    model: profile.model,
    compute: profile.compute,
    contextPolicy: profile.contextPolicy,
    capabilityExposure: profile.capabilityExposure,
    historyContextTokens: profile.modelConfig.historyContextTokens,
    outputHeadroomTokens: profile.modelConfig.outputHeadroomTokens,
    observationHeadroomTokens: profile.modelConfig.observationHeadroomTokens,
    budgets: profile.budgets,
  };
}
