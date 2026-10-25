import type { BehaviorObservation } from "../shared/types";
import type { AIContext } from "./types";
import { AIService } from "./service";

export interface ConversationReply {
  reply: string;
  appName: string | null;
  intent: "conversation" | "change" | "clarify" | "confirm";
  changeRequest: string | null;
  confirmationReason: string | null;
  workLevel: "low" | "medium" | "high";
}
export interface ConversationGoal {
  originalRequest: string;
  unresolved: boolean;
}
export const CONVERSATION_SYSTEM = `You are the conversational companion for It's Alive, an adaptive application for ordinary people. Help the person achieve their goal; never expose source files, coding agents, React, compilation, tool calls or internal handoffs. Answer questions directly. Occasionally offer one concise, relevant suggestion when helpful. Make it dismissible through conversation and never act on your own suggestion without the user accepting it. Do not repeatedly offer a dismissed suggestion. Distinguish four intents: conversation (questions/discussion), change (an explicitly requested ordinary creation, modification or repair), clarify (a genuinely unclear goal), and confirm (a destructive, costly or high-risk change that needs a specific confirmation).
An explicit request such as "Create a violin trainer", "Add an exercise", "Fix the Start button", "Can you add a timer?" or "I want an app that teaches violin" already authorizes normal work. Return intent change and a concise internal changeRequest; do not ask the user to approve again. In an unresolved-feedback conversation, a specific description of what must be corrected is authorization to continue the original repair. Vague "Not yet" alone means clarify: ask what is still wrong. Questions such as "Why is this chord difficult?" are conversation even when they mention the app. Never turn behavioral observations or your own suggestions into authorization.
For confirm, explain the concrete consequence in reply and confirmationReason and include the bounded changeRequest. For clarify/conversation set changeRequest and confirmationReason to null. For ordinary change set confirmationReason to null and reply to a concise goal-oriented acknowledgement. Never claim an application has changed, works, or passed checks before the platform verifies it. Do not promise unsupported capabilities. Choose workLevel privately: low for a small cosmetic or wording change, medium for ordinary app creation and changes, high for complex multi-feature work or unresolved repairs. Never ask the user to choose or mention this level. For conversation or clarification use medium. For app creation, include appName as a concise descriptive title (usually two to four words, such as "Violin Trainer"), never the full request. For other requests use null. Return only the required JSON.`;
export async function converse(
  service: AIService,
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  context: AIContext,
  goal?: ConversationGoal,
): Promise<ConversationReply> {
  if (!text.trim()) throw new Error("Write a question or describe your goal.");
  const response = await service.generate(
    "conversation",
    {
      messages: [
        { role: "system", content: CONVERSATION_SYSTEM },
        ...(goal?.unresolved
          ? [
              {
                role: "system" as const,
                content: `The previous change did not resolve the user's goal. Continue helping with this original request: ${JSON.stringify(goal.originalRequest)}. Seek missing detail; do not treat vague dissatisfaction as a request to rewrite the application.`,
              },
            ]
          : []),
        ...history,
        { role: "user", content: text },
      ],
      jsonSchema: {
        name: "conversation",
        schema: {
          type: "object",
          properties: {
            reply: { type: "string" },
            appName: { type: ["string", "null"] },
            workLevel: { type: "string", enum: ["low", "medium", "high"] },
            intent: {
              type: "string",
              enum: ["conversation", "change", "clarify", "confirm"],
            },
            changeRequest: { type: ["string", "null"] },
            confirmationReason: { type: ["string", "null"] },
          },
          required: [
            "reply",
            "appName",
            "intent",
            "changeRequest",
            "confirmationReason",
            "workLevel",
          ],
          additionalProperties: false,
        },
      },
    },
    context,
  );
  let value: unknown;
  try {
    value = JSON.parse(response.text);
  } catch {
    throw new Error(
      "The assistant couldn't understand the response. Please try again.",
    );
  }
  if (!value || typeof value !== "object")
    throw new Error(
      "The assistant returned an incomplete response. Please try again.",
    );
  const parsed = value as Record<string, unknown>;
  if (
    typeof parsed.reply !== "string" ||
    !["low", "medium", "high"].includes(String(parsed.workLevel)) ||
    !["conversation", "change", "clarify", "confirm"].includes(
      String(parsed.intent),
    ) ||
    !(
      parsed.changeRequest === null || typeof parsed.changeRequest === "string"
    ) ||
    !(
      parsed.confirmationReason === null ||
      typeof parsed.confirmationReason === "string"
    ) ||
    ((parsed.intent === "change" || parsed.intent === "confirm") &&
      !String(parsed.changeRequest ?? "").trim()) ||
    (parsed.intent === "confirm" &&
      !String(parsed.confirmationReason ?? "").trim()) ||
    ((parsed.intent === "conversation" || parsed.intent === "clarify") &&
      parsed.changeRequest !== null)
  )
    throw new Error(
      "The assistant returned an incomplete response. Please try again.",
    );
  return {
    reply: parsed.reply,
    appName:
      typeof parsed.appName === "string" &&
      parsed.appName.trim() &&
      parsed.appName.trim().length <= 80 &&
      parsed.appName.trim().split(/\s+/).length <= 8
        ? parsed.appName.trim()
        : null,
    workLevel: parsed.workLevel as ConversationReply["workLevel"],
    intent: parsed.intent as ConversationReply["intent"],
    changeRequest:
      typeof parsed.changeRequest === "string" ? parsed.changeRequest : null,
    confirmationReason:
      typeof parsed.confirmationReason === "string"
        ? parsed.confirmationReason
        : null,
  };
}
export interface Suggestion {
  id: string;
  appId: string;
  explanation: string;
  changeRequest: string;
  status: "offered" | "accepted" | "dismissed" | "ignored";
}
export class BehaviorAdvisor {
  private readonly lastDecision = new Map<string, number>();
  private readonly suggestions = new Map<string, Suggestion>();
  constructor(
    private readonly service: AIService,
    private readonly now: () => number = Date.now,
  ) {}
  async observe(
    observation: BehaviorObservation,
    context: AIContext,
  ): Promise<Suggestion | null> {
    if (
      observation.kind !== "repeated-click" ||
      observation.count < 3 ||
      observation.durationMs > 4_000 ||
      observation.durationMs < 0 ||
      !observation.target ||
      observation.target.length > 120
    )
      return null;
    const now = this.now();
    if (
      now - (this.lastDecision.get(context.appId) ?? -Infinity) < 60_000 ||
      [...this.suggestions.values()].some(
        (suggestion) =>
          suggestion.appId === context.appId && suggestion.status === "offered",
      )
    )
      return null;
    this.lastDecision.set(context.appId, now);
    const response = await this.service.generate(
      "decision",
      {
        messages: [
          {
            role: "system",
            content:
              "Decide whether an optional, non-blocking suggestion could help. Repeated clicks are uncertain evidence; many controls intentionally accept repeated clicks. Do not infer frustration as fact. Suggest only if useful; never run code. Return JSON suggest, explanation, changeRequest.",
          },
          { role: "user", content: JSON.stringify(observation) },
        ],
        jsonSchema: {
          name: "behavior_suggestion",
          schema: {
            type: "object",
            properties: {
              suggest: { type: "boolean" },
              explanation: { type: "string" },
              changeRequest: { type: "string" },
            },
            required: ["suggest", "explanation", "changeRequest"],
            additionalProperties: false,
          },
        },
      },
      context,
    );
    let value: unknown;
    try {
      value = JSON.parse(response.text);
    } catch {
      throw new Error("Decision model returned invalid JSON.");
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("suggest" in value) ||
      value.suggest !== true ||
      !("explanation" in value) ||
      typeof value.explanation !== "string" ||
      !("changeRequest" in value) ||
      typeof value.changeRequest !== "string"
    )
      return null;
    const suggestion: Suggestion = {
      id: crypto.randomUUID(),
      appId: context.appId,
      explanation: value.explanation,
      changeRequest: value.changeRequest,
      status: "offered",
    };
    this.suggestions.set(suggestion.id, suggestion);
    return { ...suggestion };
  }
  resolve(
    id: string,
    status: "accepted" | "dismissed" | "ignored",
  ): Suggestion | undefined {
    const suggestion = this.suggestions.get(id);
    if (!suggestion || suggestion.status !== "offered") return undefined;
    suggestion.status = status;
    this.lastDecision.set(suggestion.appId, this.now());
    return { ...suggestion };
  }
}
