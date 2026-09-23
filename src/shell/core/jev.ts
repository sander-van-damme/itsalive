import type { JevState } from "../../shared";
import type { Credential, DecisionModel, DecisionRequest, DecisionResult } from "./types";

export const JEV_MODEL = "~typesafe/jev-latest";
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_ESCALATION_THRESHOLD = 0.7;
export const JEV_PATTERN_SIGNAL_FLOOR = 0.12;

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface JevNoulAnswer { type: "noul"; noul: number }
export interface JevChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface JevScoreAnswer { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export interface JevDecisionRequest extends DecisionRequest { questions?: JevQuestions }
export interface JevDecisionDiagnostics {
  requestId?: string;
  provider?: string;
  model?: string;
  elapsedMs: number;
}
export interface JevDecisionResult extends DecisionResult {
  answers: JevAnswers;
  diagnostics: JevDecisionDiagnostics;
}

export const GENERIC_JEV_QUESTION: JevQuestions = {
  requires_llm_attention: {
    type: "noul",
    instructions: "Given this user interaction, recent interactions, optional locally-derived interaction pattern, and current semantic application document, should the application invoke its reasoning agent because an intelligent or adaptive response may be useful?",
    criteria: {
      true: "Meaningful adaptation, assistance, or deeper contextual reasoning may be useful, including repeated unchanged attempts suggesting an unmet need.",
      false: "This is an ordinary expected interaction and existing application behavior is sufficient. A pattern marked likelyBenign usually represents intentional repeatable use rather than frustration.",
    },
  },
};

function finiteProbability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Jev provider returned malformed ${label}`);
  return value;
}

function probabilityMap(value: unknown, label: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Jev provider returned malformed ${label}`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) throw new Error(`Jev provider returned malformed ${label}`);
  return Object.fromEntries(entries.map(([key, probability]) => [key, finiteProbability(probability, label)]));
}

function parseAnswer(id: string, question: JevQuestion, value: unknown): JevAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Jev provider returned malformed answer for ${id}`);
  const answer = value as Record<string, unknown>;
  if (answer.type !== question.type) throw new Error(`Jev provider returned mismatched answer type for ${id}`);
  if (question.type === "noul") return { type: "noul", noul: finiteProbability(answer.noul, `Noul probability for ${id}`) };
  if (question.type === "choice") {
    if (typeof answer.choice !== "string" || !(answer.choice in question.criteria)) throw new Error(`Jev provider returned malformed Choice for ${id}`);
    const probabilities = probabilityMap(answer.probabilities, `Choice probabilities for ${id}`);
    for (const option of Object.keys(question.criteria)) if (!(option in probabilities)) throw new Error(`Jev provider returned incomplete Choice probabilities for ${id}`);
    return { type: "choice", choice: answer.choice, probabilities, confidence: finiteProbability(answer.confidence, `Choice confidence for ${id}`) };
  }
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) throw new Error(`Jev provider returned malformed Score for ${id}`);
  if (!answer.legend || typeof answer.legend !== "object" || Array.isArray(answer.legend)) throw new Error(`Jev provider returned malformed Score legend for ${id}`);
  const legend = answer.legend as Record<string, unknown>;
  const normalizedLegend: Record<string, string> = {};
  for (let index = 0; index < question.criteria.length; index++) {
    const description = legend[String(index)];
    if (typeof description !== "string") throw new Error(`Jev provider returned incomplete Score legend for ${id}`);
    normalizedLegend[String(index)] = description;
  }
  const probabilities = probabilityMap(answer.probabilities, `Score probabilities for ${id}`);
  for (let index = 0; index < question.criteria.length; index++) if (!(String(index) in probabilities)) throw new Error(`Jev provider returned incomplete Score probabilities for ${id}`);
  return { type: "score", score: answer.score, legend: normalizedLegend, probabilities, confidence: finiteProbability(answer.confidence, `Score confidence for ${id}`) };
}

/** Typed bounded-decision adapter; deliberately separate from text generation and action policy. */
export class OpenRouterJevAdapter implements DecisionModel {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async evaluate(request: JevDecisionRequest, credential?: Credential): Promise<JevDecisionResult> {
    if (!credential?.value) throw new Error("Jev credential is not configured");
    const questions = request.questions ?? GENERIC_JEV_QUESTION;
    const questionEntries = Object.entries(questions);
    if (!questionEntries.length) throw new Error("Jev request must contain at least one question");
    const startedAt = performance.now();
    const response = await this.fetcher.call(globalThis, OPENROUTER_DECISIONS_URL, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential.value}` },
      body: JSON.stringify({ model: JEV_MODEL, state: request.state, questions }), signal: request.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`OpenRouter Jev failed (${response.status})`);
    const rawAnswers = body.answers;
    if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) throw new Error("Jev provider returned malformed answers");
    const answerRecord = rawAnswers as Record<string, unknown>;
    const answers: JevAnswers = {};
    for (const [id, question] of questionEntries) {
      if (!(id in answerRecord)) throw new Error(`Jev provider omitted answer for ${id}`);
      answers[id] = parseAnswer(id, question, answerRecord[id]);
    }
    const unexpected = Object.keys(answerRecord).filter(id => !(id in questions));
    if (unexpected.length) throw new Error(`Jev provider returned unexpected answer(s): ${unexpected.join(", ")}`);
    const usage = body.usage as Record<string, unknown> | undefined;
    const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
    const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined;
    const cost = typeof usage?.cost === "number" ? usage.cost : undefined;
    const normalizedUsage = inputTokens !== undefined || outputTokens !== undefined || cost !== undefined
      ? { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(cost !== undefined ? { cost } : {}) }
      : undefined;
    const wakeAnswer = answers.requires_llm_attention;
    const probability = wakeAnswer?.type === "noul" ? wakeAnswer.noul : 0;
    return {
      answers,
      probability,
      ...(normalizedUsage ? { usage: normalizedUsage } : {}),
      diagnostics: {
        ...(typeof body.id === "string" ? { requestId: body.id } : {}),
        ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        elapsedMs: Math.round(performance.now() - startedAt),
      },
    };
  }
}

export interface JevEscalationDecision {
  escalated: boolean;
  reason: "model-threshold" | "repeated-unchanged-action" | "none";
}

export function decideJevEscalation(probability: number, state: JevState, threshold = JEV_ESCALATION_THRESHOLD): JevEscalationDecision {
  if (probability >= threshold) return { escalated: true, reason: "model-threshold" };
  const pattern = state.pattern;
  if (pattern?.frustrationSignal && !pattern.likelyBenign && probability >= JEV_PATTERN_SIGNAL_FLOOR) {
    return { escalated: true, reason: "repeated-unchanged-action" };
  }
  return { escalated: false, reason: "none" };
}
