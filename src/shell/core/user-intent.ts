import { inferPlatformCapabilities, isPlatformCapabilityId, platformCapabilityHelp, type PlatformCapabilityId } from "./capabilities";
import { USER_INTENT_SYSTEM_PROMPT } from "./prompts";
import type { TriggerRoutingDecision } from "./jev-routing";
import type { GenerateRequest, ModelConfig } from "./types";

export type UserInputKind = "change" | "explanation" | "question" | "preference" | "other";
export type UserInputSource = "chat" | "interaction";

export interface TechnicalIntent {
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  capabilityIds: PlatformCapabilityId[];
  telemetrySummary?: string;
}

export interface UserIntentDecision {
  kind: UserInputKind;
  shouldCode: boolean;
  reply: string;
  technicalIntent?: TechnicalIntent;
}

export interface UserIntentInput {
  appPrompt: string;
  userText: string;
  source: UserInputSource;
  behaviorSummary?: string;
  telemetrySummary?: string;
}

export function buildUserIntentRequest(input: UserIntentInput, model: ModelConfig, signal?: AbortSignal): GenerateRequest {
  const body = [
    `APP PURPOSE\n${input.appPrompt.trim()}`,
    input.behaviorSummary?.trim() ? `CURATED USER BEHAVIOR\n${input.behaviorSummary.trim()}` : "",
    `INPUT SOURCE\n${input.source}`,
    `USER INPUT\n${input.userText.trim()}`,
    input.telemetrySummary?.trim() ? `RELEVANT INTERACTION TELEMETRY\n${input.telemetrySummary.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  return {
    purpose: "user intent interpretation",
    model,
    system: USER_INTENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: body }],
    signal,
  };
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\\s*([\\s\\S]*?)\\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function parseUserIntentDecision(raw: string, input: UserIntentInput): UserIntentDecision {
  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonFence(raw)); }
  catch { throw new Error("Intent manager returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Intent manager returned an invalid decision");
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (!["change", "explanation", "question", "preference", "other"].includes(String(kind))) throw new Error("Intent manager returned an unknown input kind");
  if (typeof record.shouldCode !== "boolean") throw new Error("Intent manager omitted shouldCode");
  const reply = typeof record.reply === "string" ? record.reply.trim().slice(0, 2_000) : "";

  if (!record.shouldCode) {
    return { kind: kind as UserInputKind, shouldCode: false, reply };
  }
  if (kind !== "change") throw new Error("Intent manager may authorize coding only for a change request");
  if (!record.technicalIntent || typeof record.technicalIntent !== "object" || Array.isArray(record.technicalIntent)) {
    throw new Error("Intent manager authorized coding without a technical intent");
  }
  const technical = record.technicalIntent as Record<string, unknown>;
  const goal = typeof technical.goal === "string" ? technical.goal.trim().slice(0, 4_000) : "";
  if (!goal) throw new Error("Intent manager returned an empty technical goal");
  const constraints = stringArray(technical.constraints, 12);
  const acceptanceCriteria = stringArray(technical.acceptanceCriteria, 12);
  const requestedIds = stringArray(technical.capabilityIds, 12).filter(isPlatformCapabilityId);
  const inferred = inferPlatformCapabilities(`${input.userText}\n${goal}`);
  const capabilityIds = [...new Set<PlatformCapabilityId>([...requestedIds, ...inferred])];

  return {
    kind: "change",
    shouldCode: true,
    reply,
    technicalIntent: {
      goal,
      constraints: constraints.length ? constraints : ["Preserve unrelated app behavior and existing user data."],
      acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : ["The requested behavior works from the visible app UI."],
      capabilityIds,
      ...(input.telemetrySummary?.trim() ? { telemetrySummary: input.telemetrySummary.trim() } : {}),
    },
  };
}

export function reconcileRepairIntentWithRouting(
  decision: UserIntentDecision,
  input: UserIntentInput,
  routing: TriggerRoutingDecision | undefined,
): UserIntentDecision {
  if (decision.shouldCode || input.source !== "chat" || !routing?.confident) return decision;
  if (routing.route !== "debug" || routing.preferredWorkerProfile !== "repair-worker") return decision;
  if (decision.kind === "question" || decision.kind === "preference") return decision;

  const report = input.userText.replace(/\s+/g, " ").trim().slice(0, 1_000);
  if (!report) return decision;
  return {
    kind: "change",
    shouldCode: true,
    reply: "",
    technicalIntent: {
      goal: `Repair the reported app problem: ${report}`,
      constraints: [
        "Preserve unrelated app behavior and existing user data.",
        "Limit changes to the reported broken behavior; do not rebuild unrelated app functionality.",
      ],
      acceptanceCriteria: [
        `The reported broken behavior is fixed from the visible app UI: ${report}`,
      ],
      capabilityIds: inferPlatformCapabilities(report),
      ...(input.telemetrySummary?.trim() ? { telemetrySummary: input.telemetrySummary.trim() } : {}),
    },
  };
}

export function technicalIntentBlock(intent: TechnicalIntent): string {
  return [
    "TECHNICAL INTENT",
    "",
    "GOAL",
    intent.goal.trim(),
    "",
    "CONSTRAINTS",
    intent.constraints.length ? intent.constraints.map(value => `- ${value}`).join("\n") : "- (none)",
    "",
    "ACCEPTANCE CRITERIA",
    intent.acceptanceCriteria.length ? intent.acceptanceCriteria.map(value => `- ${value}`).join("\n") : "- (none)",
    "",
    "SELECTED PLATFORM API HELP",
    platformCapabilityHelp(intent.capabilityIds),
    ...(intent.telemetrySummary?.trim() ? ["", "SELECTED TELEMETRY", intent.telemetrySummary.trim()] : []),
  ].join("\n");
}

export function initialBuildTechnicalIntent(appPrompt: string): TechnicalIntent {
  return {
    goal: `Build the initial usable version of this app: ${appPrompt.trim()}`,
    constraints: [
      "Implement only the app described by the app purpose; do not add unrelated product scope.",
      "Preserve the platform-owned #itsalive-root and runtime boundaries.",
    ],
    acceptanceCriteria: [
      "The primary user-facing workflow described by the app purpose is visibly usable.",
      "Core visible controls work before the app is marked complete.",
    ],
    capabilityIds: inferPlatformCapabilities(appPrompt),
  };
}
