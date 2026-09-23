import type { AppScriptSnapshot } from "../../shared";

export type HistoryRole = "user" | "assistant" | "agent" | "observation" | "system";

export interface AppRecord {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  behaviorSummary?: string;
  behaviorSummaryUpdatedAt?: number;
}

export interface AppDocumentRecord {
  appId: string;
  html: string;
  scripts: AppScriptSnapshot[];
  updatedAt: number;
}

export interface HistoryEntry {
  id?: number;
  appId: string;
  timestamp: number;
  role: HistoryRole;
  content: string;
  kind?: "chat" | "javascript" | "execution" | "error";
}

export interface ProviderModel {
  provider: string;
  model: string;
  options?: Record<string, unknown>;
}

export interface ModelConfig extends ProviderModel {
  /** Actual model/router context capacity used only for local input budgeting. */
  maxContextTokens: number;
  /** Local response headroom for context pruning; never serialized as a provider generation limit. */
  outputHeadroomTokens: number;
  /** Experiment control: maximum prior-history tokens to include in one model turn. */
  historyContextTokens: number;
  observationHeadroomTokens?: number;
}

export interface Credential {
  value: string;
}

export interface ModelMessage { role: "user" | "assistant"; content: string }

export interface GenerateUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cost?: number;
}

export interface LlmTraceIdentity {
  runId: string;
  agentId: string;
  role: string;
  profile: string;
  parentRunId?: string;
  parentAgentId?: string;
  scope?: string;
}

export interface LlmContextTrace {
  turn?: number;
  configuredHistoryTokens?: number;
  effectiveHistoryBudget?: number;
  selectedHistoryTokens?: number;
  estimatedInputTokens?: number;
  includedHistoryCount?: number;
  omittedHistoryCount?: number;
  modelContextTokens?: number;
  sources?: {
    system: number;
    mandatory: number;
    observation: number;
    environmentObservation: number;
    history: number;
    total: number;
  };
}

export interface LlmRequestTrace extends LlmTraceIdentity {
  turn?: number;
  context?: LlmContextTrace;
}

export interface NormalizedLlmUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
}

export interface LlmTraceEvent extends LlmTraceIdentity {
  requestId: string;
  purpose: string;
  provider: string;
  model: string;
  modelOptions?: Record<string, unknown>;
  streaming: boolean;
  startedAt: number;
  elapsedMs: number;
  status: "success" | "error";
  turn?: number;
  context?: LlmContextTrace;
  usage: NormalizedLlmUsage;
  error?: { name?: string; message: string };
}

export interface LlmTraceMetricRollup {
  value: number;
  complete: boolean;
}

export interface LlmTraceRollup extends LlmTraceIdentity {
  requests: number;
  successes: number;
  errors: number;
  elapsedMs: number;
  turns: number;
  inputTokens: LlmTraceMetricRollup;
  cachedInputTokens: LlmTraceMetricRollup;
  cacheWriteTokens: LlmTraceMetricRollup;
  outputTokens: LlmTraceMetricRollup;
  reasoningTokens: LlmTraceMetricRollup;
  cost: LlmTraceMetricRollup;
}

export interface GenerateRequest {
  /** Console diagnostic label; never sent to the provider. */
  purpose?: string;
  model: ProviderModel;
  system: string;
  messages: ModelMessage[];
  trace?: LlmRequestTrace;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  usage?: GenerateUsage;
  raw?: unknown;
}

export interface LlmAdapter {
  id: string;
  generate(request: GenerateRequest, credential?: Credential): Promise<GenerateResult>;
  stream?(request: GenerateRequest, credential: Credential | undefined, onText: (delta: string) => void, onActivity?: () => void): Promise<GenerateResult>;
}

export interface DecisionRequest { state: unknown; signal?: AbortSignal; }
export interface DecisionResult { probability: number; usage?: { inputTokens?: number; outputTokens?: number; cost?: number }; }
export interface DecisionModel { evaluate(request: DecisionRequest, credential?: Credential): Promise<DecisionResult>; }

export interface LogEntry {
  id?: number;
  timestamp: number;
  source: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  details?: unknown;
  appId?: string;
}

export interface ScheduleRecord {
  id: string;
  appId: string;
  expression: string;
  registeredAt: number;
  lastFired?: number;
  nextRun?: number;
}
