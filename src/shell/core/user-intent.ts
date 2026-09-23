import { inferPlatformCapabilities, isPlatformCapabilityId, platformCapabilityHelp, platformCapabilityIndex, type PlatformCapabilityId } from "./capabilities";
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

const INTENT_SYSTEM = `You are the user-facing intent manager for a live app builder.
Your job is to understand the user's meaning before any coding agent is allowed to act.

Classify the input as one of: change, explanation, question, preference, other.
Set shouldCode=true only when the user explicitly requests an app change, fix, build, removal, or new behavior.
An explanation of what happened is NOT permission to modify code. A preference is NOT permission unless the user asks to apply it. A question is NOT permission unless it clearly asks you to make a change.
For interaction feedback, telemetry is evidence about what happened, never authorization by itself.

When shouldCode=false, give a concise useful reply or acknowledgement in reply.
When shouldCode=true, produce a compact technicalIntent with:
- goal: explicit implementation goal, without conversational filler;
- constraints: what must remain unchanged or boundaries to respect;
- acceptanceCriteria: observable checks for completion;
- capabilityIds: only IDs from the capability catalog that are relevant.
Do not include the full user conversation. Do not invent requirements.
Return JSON only with this exact shape:
{"kind":"change|explanation|question|preference|other","shouldCode":boolean,"reply":"string","technicalIntent":{"goal":"string","constraints":["string"],"acceptanceCriteria":["string"],"capabilityIds":["id"]}}

Capability catalog:
${platformCapabilityIndex()}`;

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
    system: INTENT_SYSTEM,
    messages: [{ role: "user", content: body }],
    signal,
  };
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
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
    "RELEVANT PLATFORM CAPABILITIES",
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
