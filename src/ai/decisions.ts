import type { AIResponse, AIUsage, ModelRoute } from "./types";
import { AIError, httpFailure } from "./providers";

/** Bounded judgments, distinct from arbitrary JSON generation and tool calls. */
export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | {
      type: "choice";
      name: string;
      instructions: string;
      choices: Array<{ value: string | boolean; description?: string }>;
    }
  | {
      type: "score";
      name: string;
      instructions: string;
      levels: Array<{ label: string; description?: string }>;
    };
export interface DecisionInput {
  /** Shared evidence is text; JSON context is serialized without silent trimming. */
  input: string;
  questions: DecisionQuestion[];
}
export type DecisionAnswer =
  | { type: "predicate"; name: string; probability: number }
  | {
      type: "choice";
      name: string;
      choice: string | boolean;
      confidence: number;
      probabilities: Array<{ value: string | boolean; probability: number }>;
    }
  | {
      type: "score";
      name: string;
      score: number;
      confidence: number;
      probabilities: Array<{
        value: number;
        label: string;
        probability: number;
      }>;
    }
  | { type: "refusal"; name: string };
export interface DecisionResponse extends AIResponse {
  answers: DecisionAnswer[];
}

export function supportsDecisions(route: ModelRoute): boolean {
  return route.provider === "openai" && route.model === "gpt-6-luna";
}

/** These cardinalities come from the provider's Decisions schema, not token budgets. */
export function validateDecisionInput(input: DecisionInput): void {
  if (
    !input ||
    typeof input.input !== "string" ||
    !Array.isArray(input.questions) ||
    input.questions.length < 1 ||
    input.questions.length > 400
  )
    throw new Error("Decisions requires shared text and 1–400 questions.");
  const names = new Set<string>();
  for (const question of input.questions) {
    if (
      !question ||
      typeof question.name !== "string" ||
      !question.name ||
      names.has(question.name) ||
      typeof question.instructions !== "string" ||
      !["predicate", "choice", "score"].includes(question.type)
    )
      throw new Error(
        "Each decision needs a distinct name, instructions and a supported type.",
      );
    names.add(question.name);
    if (
      question.type === "choice" &&
      (!Array.isArray(question.choices) ||
        question.choices.length < 2 ||
        question.choices.length > 255 ||
        question.choices.some(
          (choice) =>
            !choice ||
            !["string", "boolean"].includes(typeof choice.value) ||
            (choice.description !== undefined &&
              typeof choice.description !== "string"),
        ) ||
        new Set(question.choices.map((choice) => choice.value)).size !==
          question.choices.length)
    )
      throw new Error("OpenAI Decisions requires 2–255 distinct choices.");
    if (
      question.type === "score" &&
      (!Array.isArray(question.levels) ||
        question.levels.length < 2 ||
        question.levels.length > 10 ||
        question.levels.some(
          (level) =>
            !level ||
            typeof level.label !== "string" ||
            (level.description !== undefined &&
              typeof level.description !== "string"),
        ))
    )
      throw new Error("OpenAI Decisions requires 2–10 ordered levels.");
  }
}

export function decisionRequest(
  route: ModelRoute,
  input: DecisionInput,
): Record<string, unknown> {
  if (!supportsDecisions(route))
    throw new AIError(
      "The selected model does not support OpenAI Decisions.",
      "model",
    );
  validateDecisionInput(input);
  // Decisions does not accept Responses' reasoning, stream, store, tier or token controls.
  return { model: route.model, input: input.input, questions: input.questions };
}
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const probability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

export function parseDecisionResponse(
  value: unknown,
  input: DecisionInput,
): DecisionResponse {
  const data = object(value);
  const rawUsage = object(data.usage);
  const details = object(rawUsage.input_tokens_details);
  const usage: AIUsage | undefined =
    count(rawUsage.input_tokens) &&
    count(rawUsage.output_tokens) &&
    (details.cached_tokens === undefined || count(details.cached_tokens)) &&
    (details.cache_write_tokens === undefined ||
      count(details.cache_write_tokens)) &&
    (details.cached_tokens ?? 0) + (details.cache_write_tokens ?? 0) <=
      rawUsage.input_tokens
      ? {
          inputTokens: rawUsage.input_tokens,
          outputTokens: rawUsage.output_tokens,
          cachedTokens: details.cached_tokens ?? 0,
          cacheWriteTokens: details.cache_write_tokens ?? 0,
        }
      : undefined;
  const response: DecisionResponse = {
    text: "",
    toolCalls: [],
    answers: [],
    endpoint: "decisions",
    usage,
    ...(typeof data.id === "string" ? { requestId: data.id } : {}),
  };
  const invalid = (): never => {
    throw new AIError(
      "The AI returned an invalid decision. Please try again.",
      "response",
      { reason: "invalid_decision" },
      response,
    );
  };
  if (
    data.model !== "gpt-6-luna" ||
    !Array.isArray(data.answers) ||
    data.answers.length !== input.questions.length
  )
    invalid();
  response.answers = data.answers.map(
    (raw: unknown, index: number): DecisionAnswer => {
      const answer = object(raw);
      const question = input.questions[index]!;
      if (answer.name !== question.name) invalid();
      if (answer.type === "refusal")
        return { type: "refusal", name: question.name };
      if (answer.type !== question.type) invalid();
      if (question.type === "predicate") {
        if (!probability(answer.probability)) invalid();
        return {
          type: "predicate",
          name: question.name,
          probability: answer.probability,
        };
      }
      const expected =
        question.type === "choice"
          ? question.choices.map((choice) => choice.value)
          : question.levels.map((_, index) => index);
      if (
        !probability(answer.confidence) ||
        !Array.isArray(answer.probabilities) ||
        answer.probabilities.length !== expected.length
      )
        invalid();
      const distribution = answer.probabilities.map(object);
      if (
        new Set(distribution.map((item: Record<string, any>) => item.value))
          .size !== expected.length ||
        distribution.some(
          (item: Record<string, any>) =>
            !expected.includes(item.value as never) ||
            !probability(item.probability),
        ) ||
        Math.abs(
          distribution.reduce(
            (total: number, item: Record<string, any>) =>
              total + item.probability,
            0,
          ) - 1,
        ) > 0.001
      )
        invalid();
      if (question.type === "choice") {
        if (!question.choices.some((choice) => choice.value === answer.choice))
          invalid();
        return {
          type: "choice",
          name: question.name,
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: distribution.map((item: Record<string, any>) => ({
            value: item.value,
            probability: item.probability,
          })),
        };
      }
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.levels.length - 1 ||
        distribution.some(
          (item: Record<string, any>) =>
            item.label !== question.levels[item.value]?.label,
        ) ||
        Math.abs(
          answer.score -
            distribution.reduce(
              (total: number, item: Record<string, any>) =>
                total + item.value * item.probability,
              0,
            ),
        ) > 0.001
      )
        invalid();
      return {
        type: "score",
        name: question.name,
        score: answer.score,
        confidence: answer.confidence,
        probabilities: distribution.map((item: Record<string, any>) => ({
          value: item.value,
          label: item.label,
          probability: item.probability,
        })),
      };
    },
  );
  return response;
}

export class OpenAIDecisionsProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async decide(
    route: ModelRoute,
    input: DecisionInput,
    credential: string,
    signal?: AbortSignal,
  ): Promise<DecisionResponse> {
    const body = decisionRequest(route, input);
    if (!credential.trim())
      throw new AIError("Connect OpenAI in Settings.", "credentials");
    try {
      const fetcher = this.fetcher;
      const response = await fetcher(
        typeof window === "undefined"
          ? "https://api.openai.com/v1/decisions"
          : "/api/ai/decisions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential}`,
          },
          body: JSON.stringify(body),
          signal,
        },
      );
      if (!response.ok) {
        const requestId = response.headers.get("x-request-id") ?? undefined;
        const failure = httpFailure(response.status, requestId);
        const body = object(await response.json().catch(() => null));
        let partial: AIResponse | undefined;
        try {
          parseDecisionResponse(body, input);
        } catch (error) {
          if (error instanceof AIError) partial = error.response;
        }
        const code = object(body.error).code;
        if (
          [
            "context_length_exceeded",
            "context_window_exceeded",
            "too_many_tokens",
          ].includes(code)
        )
          throw new AIError(
            "This request reached the selected model's context capacity. Your input has been preserved.",
            "context",
            { status: response.status, requestId, reason: code },
            partial,
          );
        throw new AIError(
          failure.message,
          failure.kind,
          failure.detail,
          partial,
        );
      }
      const result = parseDecisionResponse(await response.json(), input);
      result.requestId ??= response.headers.get("x-request-id") ?? undefined;
      return result;
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (signal?.aborted) throw signal.reason;
      throw new AIError(
        error instanceof SyntaxError
          ? "The AI returned an unreadable decision."
          : "Could not reach OpenAI. Please try again.",
        error instanceof SyntaxError ? "response" : "connection",
      );
    }
  }
}
