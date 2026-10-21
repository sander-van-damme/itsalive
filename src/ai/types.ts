import type { Json } from "../shared/types";

export const AI_ROLES = [
  "conversation",
  "reasoning",
  "decision",
  "coding-simple",
  "coding-standard",
  "coding-complex",
  "application",
  "speech",
] as const;
export type AIRole = (typeof AI_ROLES)[number];
export type ProviderId = "demo" | "openai" | "openrouter";
export interface ModelRoute {
  provider: ProviderId;
  model: string;
  maxOutputTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
}
export interface AIConfig {
  routes: Record<AIRole, ModelRoute>;
  limits: { requestsPerMinute: number; concurrency: number; budgetUSD: number };
  captureContent: boolean;
  /** Explicit opt-in: scripted development responses must never be a fallback. */
  testProviderEnabled?: boolean;
}
export interface AIContext {
  appId: string;
  correlationId: string;
  signal?: AbortSignal;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface GenerateInput {
  messages: AIMessage[];
  tools?: ToolDefinition[];
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}
export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUSD?: number;
}
export interface AIResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: AIUsage;
  requestId?: string;
}
export interface Provider {
  generate(
    route: ModelRoute,
    input: GenerateInput,
    credential: string,
    signal?: AbortSignal,
  ): Promise<AIResponse>;
}
export interface AIEvent {
  event: string;
  level: "INFO" | "DEBUG";
  appId: string;
  correlationId: string;
  data: Record<string, unknown>;
}
export interface UsageRecord {
  id: string;
  timestamp: number;
  role: AIRole;
  provider: ProviderId;
  model: string;
  appId: string;
  correlationId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUSD: number;
  estimated: boolean;
  latencyMs: number;
  status: "pending" | "success" | "failed";
}
export interface ApplicationAIRequest {
  method: "text" | "decide" | "choose" | "score";
  prompt: string;
  options?: string[];
  levels?: string[];
  context?: Json;
}
export const ROLE_LABELS: Record<AIRole, string> = {
  conversation: "Conversation",
  reasoning: "Deeper reasoning",
  decision: "Behavior decisions",
  "coding-simple": "Coding · simple",
  "coding-standard": "Coding · standard",
  "coding-complex": "Coding · complex",
  application: "Application AI",
  speech: "Speech transcription",
};
export function defaultModelRoute(provider: ProviderId = "openai"): ModelRoute {
  return {
    provider,
    model:
      provider === "demo"
        ? "demo-v2"
        : provider === "openrouter"
          ? "openai/gpt-4.1-mini"
          : "gpt-4.1-mini",
    maxOutputTokens: 8192,
    // Published list prices are estimates; custom models expose their own prices in Advanced.
    inputPerMillion: provider === "demo" ? 0 : 0.4,
    outputPerMillion: provider === "demo" ? 0 : 1.6,
  };
}
export function defaultAIConfig(): AIConfig {
  return {
    routes: Object.fromEntries(
      AI_ROLES.map((role) => [role, defaultModelRoute()]),
    ) as Record<AIRole, ModelRoute>,
    limits: { requestsPerMinute: 30, concurrency: 2, budgetUSD: 1 },
    captureContent: false,
    testProviderEnabled: false,
  };
}
/** Explicit deterministic fixture/developer choice. Never use as the application default. */
export function demoAIConfig(): AIConfig {
  const config = defaultAIConfig();
  config.routes = Object.fromEntries(
    AI_ROLES.map((role) => [role, defaultModelRoute("demo")]),
  ) as Record<AIRole, ModelRoute>;
  config.testProviderEnabled = true;
  return config;
}
export type ProviderCredentials = Partial<
  Record<"openai" | "openrouter", string>
>;
export function missingProviderRoles(
  config: AIConfig,
  credentials: ProviderCredentials,
  roles: readonly AIRole[] = AI_ROLES.filter((role) => role !== "speech"),
): AIRole[] {
  return roles.filter((role) => {
    const route = config.routes[role];
    return (
      !route ||
      (route.provider === "demo"
        ? !config.testProviderEnabled
        : !credentials[route.provider]?.trim())
    );
  });
}
export const MODEL_REGISTRY = [
  {
    provider: "demo",
    id: "demo-v2",
    text: true,
    tools: true,
    structured: true,
    audio: false,
    endpoint: "deterministic-local",
  },
  {
    provider: "openai",
    id: "gpt-4.1-mini",
    text: true,
    tools: true,
    structured: true,
    audio: false,
    endpoint: "/v1/chat/completions",
  },
  {
    provider: "openrouter",
    id: "openai/gpt-4.1-mini",
    text: true,
    tools: true,
    structured: true,
    audio: false,
    endpoint: "/api/v1/chat/completions",
  },
  {
    provider: "openai",
    id: "gpt-4o-mini-transcribe",
    text: false,
    tools: false,
    structured: false,
    audio: true,
    endpoint: "/v1/audio/transcriptions",
  },
] as const;
