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
export type ProviderId = "demo" | "openai" | "chatgpt";
export type ModelCategory = "low" | "medium" | "high" | "voice";
export type ResponseSpeed = "standard" | "faster" | "fastest";
export type ServiceTier = "default" | "priority" | "ultrafast";
export type ReasoningEffort = "low" | "medium" | "high";
export interface ModelRoute {
  provider: ProviderId;
  model: string;
  maxOutputTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
}
export interface AIConfig {
  version?: 3;
  routes: Record<AIRole, ModelRoute>;
  limits: {
    requestsPerMinute: number;
    concurrency: number;
    budgetUSD: number;
    budgetEnabled?: boolean;
    budgetPeriod?: "month" | "total";
  };
  speed?: ResponseSpeed;
  voiceReplies?: boolean;
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
  /** Opaque Responses continuation items; never shown in the conversation. */
  responseItems?: Array<Record<string, unknown>>;
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
  toolChoice?: "auto" | "required";
}
export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUSD?: number;
}
export interface AIResponse {
  text: string;
  responseItems?: Array<Record<string, unknown>>;
  toolCalls: ToolCall[];
  usage?: AIUsage;
  requestId?: string;
  serviceTier?: ServiceTier;
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
  serviceTier?: ServiceTier;
  seconds?: number;
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
export const CATEGORY_ROLES: Record<ModelCategory, AIRole[]> = {
  low: ["decision", "coding-simple"],
  medium: ["conversation", "coding-standard", "application"],
  high: ["reasoning", "coding-complex"],
  voice: ["speech"],
};
export const MODEL_CHOICES = [
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    input: 0.1,
    output: 0.5,
    fastest: false,
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    input: 2,
    output: 10,
    fastest: true,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    input: 10,
    output: 50,
    fastest: true,
  },
] as const;
export function serviceTierFor(
  model: string,
  speed: ResponseSpeed = "standard",
): ServiceTier {
  if (
    speed === "fastest" &&
    MODEL_CHOICES.some((choice) => choice.id === model && choice.fastest)
  )
    return "ultrafast";
  return speed === "standard" ? "default" : "priority";
}
export function tierMultiplier(tier: ServiceTier = "default"): number {
  return tier === "ultrafast" ? 6 : tier === "priority" ? 2 : 1;
}
export function defaultModelRoute(
  provider: ProviderId = "openai",
  category: ModelCategory = "medium",
): ModelRoute {
  const model = category === "low" ? MODEL_CHOICES[0] : MODEL_CHOICES[1];
  return {
    provider,
    model:
      provider === "demo"
        ? "demo-v2"
        : category === "voice"
          ? "gpt-live-1"
          : model.id,
    maxOutputTokens: category === "high" ? 16384 : 8192,
    inputPerMillion: provider === "demo" ? 0 : model.input,
    outputPerMillion: provider === "demo" ? 0 : model.output,
    reasoningEffort:
      category === "high" ? "high" : category === "low" ? "low" : "medium",
    serviceTier: "default",
  };
}
export function defaultAIConfig(): AIConfig {
  return {
    version: 3,
    routes: Object.fromEntries(
      Object.entries(CATEGORY_ROLES).flatMap(([category, roles]) =>
        roles.map((role) => [
          role,
          defaultModelRoute("openai", category as ModelCategory),
        ]),
      ),
    ) as Record<AIRole, ModelRoute>,
    limits: {
      requestsPerMinute: 1800,
      concurrency: 8,
      budgetUSD: 20,
      budgetEnabled: false,
      budgetPeriod: "month",
    },
    speed: "standard",
    voiceReplies: true,
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
export type ProviderCredentials = Partial<Record<"openai" | "chatgpt", string>>;
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
export const MODEL_REGISTRY = MODEL_CHOICES.map((model) => ({
  provider: "openai",
  id: model.id,
  text: true,
  tools: true,
  structured: true,
  audio: false,
  endpoint: "/v1/responses",
}));
