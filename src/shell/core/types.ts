export type HistoryRole = "user" | "assistant" | "agent" | "observation" | "system";

export interface AppRecord {
  id: string;
  name: string;
  prompt: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id?: number;
  appId: string;
  timestamp: number;
  role: HistoryRole;
  content: string;
  kind?: "chat" | "javascript" | "execution" | "error" | "compaction";
}

export interface ToolSummary { name: string; description: string }

export interface ModelConfig {
  id: string;
  provider: string;
  model: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  observationHeadroomTokens?: number;
  credentialId?: string;
  options?: Record<string, unknown>;
}

export interface Credential {
  id: string;
  type: "api-key" | "bearer-token" | "oauth" | "custom";
  value: string;
  metadata?: Record<string, string>;
}

export interface ModelMessage { role: "user" | "assistant"; content: string }

export interface GenerateRequest {
  /** Console diagnostic label; never sent to the provider. */
  purpose?: string;
  model: ModelConfig;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
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
}

export interface DecisionRequest { state: unknown; signal?: AbortSignal; }
export interface DecisionResult { probability: number; usage?: { inputTokens?: number }; raw?: unknown; }
export interface DecisionModel { id: string; evaluate(request: DecisionRequest, credential?: Credential): Promise<DecisionResult>; }

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
