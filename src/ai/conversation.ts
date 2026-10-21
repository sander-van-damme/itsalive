import type { BehaviorObservation } from "../shared/types";
import type { AIContext } from "./types";
import { AIService } from "./service";

export interface ConversationReply {
  reply: string;
  changeRequest: string | null;
}
export async function converse(
  service: AIService,
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  context: AIContext,
): Promise<ConversationReply> {
  if (!text.trim() || text.length > 12_000)
    throw new Error("Message must contain 1–12000 characters.");
  const response = await service.generate(
    "conversation",
    {
      messages: [
        {
          role: "system",
          content: `You are the responsive conversational partner for It's Alive. Answer questions directly, discuss uncertain goals, and distinguish conversation from source changes. For a requested structural change, return a concise technical changeRequest, which the user must approve before the coding harness executes. Never claim to have edited, verified, or deployed anything. Observations are evidence, not proof of user intent. Keep the reply useful and concise. Return JSON with reply and changeRequest (string or null).`,
        },
        ...history.slice(-12).map((message) => ({
          ...message,
          content: message.content.slice(0, 3_000),
        })),
        { role: "user", content: text },
      ],
      jsonSchema: {
        name: "conversation",
        schema: {
          type: "object",
          properties: {
            reply: { type: "string" },
            changeRequest: { type: ["string", "null"] },
          },
          required: ["reply", "changeRequest"],
          additionalProperties: false,
        },
      },
    },
    context,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("Conversation model returned invalid JSON.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("reply" in parsed) ||
    typeof parsed.reply !== "string" ||
    !("changeRequest" in parsed) ||
    !(parsed.changeRequest === null || typeof parsed.changeRequest === "string")
  )
    throw new Error("Conversation model returned an invalid response.");
  return {
    reply: parsed.reply.slice(0, 12_000),
    changeRequest:
      typeof parsed.changeRequest === "string"
        ? parsed.changeRequest.slice(0, 12_000)
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
      explanation: value.explanation.slice(0, 600),
      changeRequest: value.changeRequest.slice(0, 4_000),
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

/** Explicit deeper analysis; it returns advice and has no coding tools or mutation authority. */
export async function reason(
  service: AIService,
  text: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  context: AIContext,
): Promise<string> {
  if (!text.trim() || text.length > 12_000)
    throw new Error(
      "Give a question or goal of at most 12000 characters for deeper reasoning.",
    );
  const response = await service.generate(
    "reasoning",
    {
      messages: [
        {
          role: "system",
          content:
            "The user explicitly requested deeper reasoning about this application or goal. Analyze the problem, state uncertainty, explain useful tradeoffs, and recommend a concrete next step. You have no tools and cannot modify code. Do not claim to have inspected, changed, tested or deployed the application. Any proposed structural change still requires a separate user-authorized coding request. Keep the result focused and readable.",
        },
        ...history.slice(-12).map((message) => ({
          ...message,
          content: message.content.slice(0, 3_000),
        })),
        { role: "user", content: text },
      ],
    },
    context,
  );
  return response.text;
}
