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

export interface GenerateRequest {
  /** Console diagnostic label; never sent to the provider. */
  purpose?: string;
  model: ProviderModel;
  system: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
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
