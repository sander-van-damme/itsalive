import { describe, expect, it } from "vitest";
import {
  APPLICATION_AI_CONFIDENCE_THRESHOLD,
  APPLICATION_AI_DECIDE_FALSE_THRESHOLD,
  APPLICATION_AI_DECIDE_TRUE_THRESHOLD,
  applicationAiJevRequest,
  resolveApplicationAiDecision,
} from "../src/shell/core/application-ai";
import type { ApplicationAiDecisionRequest } from "../src/shared";

describe("application AI decision policy", () => {
  it("builds Jev Choice, Score, and Noul questions from the public abstraction", () => {
    const choose: ApplicationAiDecisionRequest = {
      kind: "choose",
      question: "Which route?",
      options: { billing: "Payments", technical: "Broken feature" },
      contextJson: '{"ticket":"refund"}',
    };
    expect(applicationAiJevRequest(choose)).toEqual({
      state: { ticket: "refund" },
      questions: {
        result: {
          type: "choice",
          instructions: "Which route?",
          criteria: { billing: "Payments", technical: "Broken feature" },
        },
      },
    });

    expect(applicationAiJevRequest({
      kind: "score",
      question: "Severity?",
      levels: ["Low", "Medium", "High"],
    })).toEqual({
      state: {},
      questions: {
        result: { type: "score", instructions: "Severity?", criteria: ["Low", "Medium", "High"] },
      },
    });

    expect(applicationAiJevRequest({ kind: "decide", question: "Refund request?" })).toEqual({
      state: {},
      questions: { result: { type: "noul", instructions: "Refund request?" } },
    });
  });

  it("returns only a confident Choice value", () => {
    const decision: ApplicationAiDecisionRequest = {
      kind: "choose",
      question: "Which route?",
      options: { billing: "Payments", technical: "Broken feature" },
    };
    expect(resolveApplicationAiDecision(decision, {
      answers: { result: { type: "choice", choice: "billing", probabilities: { billing: .9, technical: .1 }, confidence: APPLICATION_AI_CONFIDENCE_THRESHOLD } },
    })).toBe("billing");
    expect(resolveApplicationAiDecision(decision, {
      answers: { result: { type: "choice", choice: "billing", probabilities: { billing: .7, technical: .3 }, confidence: APPLICATION_AI_CONFIDENCE_THRESHOLD - .01 } },
    })).toBeNull();
  });

  it("returns only a confident continuous Score", () => {
    const decision: ApplicationAiDecisionRequest = {
      kind: "score",
      question: "Severity?",
      levels: ["Low", "Medium", "High"],
    };
    expect(resolveApplicationAiDecision(decision, {
      answers: { result: { type: "score", score: 1.2, legend: { "0": "Low", "1": "Medium", "2": "High" }, probabilities: { "0": .05, "1": .7, "2": .25 }, confidence: .9 } },
    })).toBe(1.2);
    expect(resolveApplicationAiDecision(decision, {
      answers: { result: { type: "score", score: 1.2, legend: { "0": "Low", "1": "Medium", "2": "High" }, probabilities: { "0": .05, "1": .7, "2": .25 }, confidence: .79 } },
    })).toBeNull();
  });

  it("maps Noul into conservative decide bands while probability stays raw", () => {
    const answer = (noul: number) => ({ answers: { result: { type: "noul" as const, noul } } });
    expect(resolveApplicationAiDecision({ kind: "decide", question: "Refund?" }, answer(APPLICATION_AI_DECIDE_TRUE_THRESHOLD))).toBe(true);
    expect(resolveApplicationAiDecision({ kind: "decide", question: "Refund?" }, answer(APPLICATION_AI_DECIDE_FALSE_THRESHOLD))).toBe(false);
    expect(resolveApplicationAiDecision({ kind: "decide", question: "Refund?" }, answer(.5))).toBeNull();
    expect(resolveApplicationAiDecision({ kind: "probability", question: "Refund?" }, answer(.93))).toBe(.93);
  });
});
