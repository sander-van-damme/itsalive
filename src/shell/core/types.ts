export type HistoryRole = "user" | "assistant" | "agent" | "observation" | "system";

export interface AppRecord {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
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
  maxContextTokens: number;
  outputHeadroomTokens: number;
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
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
}

export interface LlmAdapter {
  id: string;
  generate(request: GenerateRequest, credential?: Credential): Promise<GenerateResult>;
  stream?(request: GenerateRequest, credential: Credential | undefined, onText: (delta: string) => void): Promise<GenerateResult>;
}

export interface DecisionRequest { state: unknown; signal?: AbortSignal; }
export interface DecisionResult { probability: number; usage?: { inputTokens?: number }; }
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
