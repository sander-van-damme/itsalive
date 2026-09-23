import { describe, expect, it } from "vitest";
import { buildModelContext, conservativeTokenEstimate } from "../src/shell/core/context";
import { SYSTEM_PROMPT } from "../src/shell/core/system-prompt";

const model = { provider: "test", model: "test", maxContextTokens: 8_000, outputHeadroomTokens: 200, historyContextTokens: 1_000 };

describe("shell context builder", () => {
  it("teaches only the namespaced runtime API", () => {
    for (const current of ["itsalive.done", "itsalive.history", "itsalive.dom.screenshot", "itsalive.llm", "itsalive.components"]) {
      expect(SYSTEM_PROMPT).toContain(current);
    }
    expect(SYSTEM_PROMPT).toContain("native browser IndexedDB");
    expect(SYSTEM_PROMPT).toContain("own browser origin");
  });

  it("defines a streamed multi-command drawing-board contract", () => {
    expect(SYSTEM_PROMPT).toContain("one model response containing one or more independently executable JavaScript commands");
    expect(SYSTEM_PROMPT).toContain("/* itsalive:command */");
    expect(SYSTEM_PROMPT).toContain("/* itsalive:end */");
    expect(SYSTEM_PROMPT).toContain("executes each command as soon as its closing delimiter arrives");
    expect(SYSTEM_PROMPT).toContain("Commands later in the same response cannot use the return value of an earlier command");
    expect(SYSTEM_PROMPT).toContain("Treat it as a drawing board");
    expect(SYSTEM_PROMPT).toContain("Tailwind CSS as the default styling language");
    expect(SYSTEM_PROMPT).toContain("Alpine.js as the default layer");
    expect(SYSTEM_PROMPT).toContain("Custom Elements are optional, not required");
    expect(SYSTEM_PROMPT).toContain("Chart, d3, THREE");
    expect(SYSTEM_PROMPT).toContain("alternate examples use keys such as modal/example-01");
    expect(SYSTEM_PROMPT).toMatch(/Apps must be responsive/);
    expect(SYSTEM_PROMPT).toMatch(/one column on narrow\/mobile layouts/);
  });

  it("includes the shell-owned behavioral summary as mandatory context", () => {
    const result = buildModelContext({
      model,
      appPrompt: "A violin coach",
      behaviorSummary: "The user prefers concise feedback around 90 bpm.",
      trigger: "Help me",
      history: [],
    });
    const joined = result.messages.map(message => message.content).join("\n");
    expect(joined).toContain("CURATED BEHAVIORAL HISTORY");
    expect(joined).toContain("prefers concise feedback");
  });

  it("always includes immutable app context and the current technical intent", () => {
    const result = buildModelContext({ model, appPrompt: "A violin coach", trigger: "Help me", history: [] });
    expect(result.system).toBe(SYSTEM_PROMPT);
    expect(result.messages.at(-1)?.content).toContain("A violin coach");
    expect(result.messages.at(-1)?.content).toContain("Help me");
  });

  it("includes the current trigger and latest observation only once", () => {
    const trigger = "Fix the empty screen";
    const observation = '{"error":{"message":"Unexpected token"}}';
    const history = [
      { id: 1, appId: "app", timestamp: 1, role: "user" as const, kind: "chat" as const, content: trigger },
      { id: 2, appId: "app", timestamp: 2, role: "agent" as const, kind: "javascript" as const, content: "return 1;" },
      { id: 3, appId: "app", timestamp: 3, role: "observation" as const, kind: "error" as const, content: observation },
    ];
    const result = buildModelContext({ model: { ...model, maxContextTokens: 12_000 }, appPrompt: "coach", trigger, observation, history });
    const joined = result.messages.map(message => message.content).join("\n");

    expect(joined.split(trigger)).toHaveLength(2);
    expect(joined.split(observation)).toHaveLength(2);
    expect(result.includedHistoryIds).not.toContain(1);
    expect(result.includedHistoryIds).not.toContain(3);
  });

  it("keeps newest fitting technical history rather than a fixed message count", () => {
    const tinyModel = { ...model, maxContextTokens: conservativeTokenEstimate(SYSTEM_PROMPT) + 440, outputHeadroomTokens: 100, observationHeadroomTokens: 100 };
    const history = Array.from({ length: 20 }, (_, index) => ({ id: index, appId: "550e8400-e29b-41d4-a716-446655440006", timestamp: index, role: "agent" as const, kind: "javascript" as const, content: `command-${index} ${"x".repeat(80)}` }));
    const result = buildModelContext({ model: tinyModel, appPrompt: "coach", trigger: "go", history });
    expect(result.omittedHistoryCount).toBeGreaterThan(0);
    expect(result.includedHistoryIds).toContain(19);
    expect(result.includedHistoryIds).not.toContain(0);
  });

  it("uses the configured history budget as the experiment variable", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      appId: "app",
      timestamp: index,
      role: "agent" as const,
      kind: "javascript" as const,
      content: `command-${index} ${"x".repeat(80)}`,
    }));
    const small = buildModelContext({
      model: { ...model, maxContextTokens: 128_000, historyContextTokens: 220 },
      appPrompt: "coach",
      trigger: "follow-up",
      history,
      countTokens: value => value.length,
    });
    const large = buildModelContext({
      model: { ...model, maxContextTokens: 128_000, historyContextTokens: 660 },
      appPrompt: "coach",
      trigger: "follow-up",
      history,
      countTokens: value => value.length,
    });

    expect(small.historyTokenBudget).toBe(220);
    expect(large.historyTokenBudget).toBe(660);
    expect(large.includedHistoryIds.length).toBeGreaterThan(small.includedHistoryIds.length);
    expect(small.includedHistoryIds).toContain(20);
    expect(large.includedHistoryIds).toContain(20);
  });


  it("never includes raw user or assistant chat in coding history", () => {
    const history = [
      { id: 1, appId: "app", timestamp: 1, role: "user" as const, kind: "chat" as const, content: "I thought the page was loaded already." },
      { id: 2, appId: "app", timestamp: 2, role: "assistant" as const, kind: "chat" as const, content: "Thanks for explaining." },
      { id: 3, appId: "app", timestamp: 3, role: "agent" as const, kind: "javascript" as const, content: "return document.body;" },
      { id: 4, appId: "app", timestamp: 4, role: "observation" as const, kind: "error" as const, content: "ReferenceError: missing state" },
    ];
    const result = buildModelContext({ model: { ...model, maxContextTokens: 12_000 }, appPrompt: "coach", trigger: "TECHNICAL INTENT\nFix the missing state", history });
    const joined = result.messages.map(message => message.content).join("\n");
    expect(joined).not.toContain("I thought the page was loaded already.");
    expect(joined).not.toContain("Thanks for explaining.");
    expect(joined).toContain("return document.body;");
    expect(joined).toContain("ReferenceError: missing state");
    expect(result.includedHistoryIds).toEqual(expect.arrayContaining([3, 4]));
    expect(result.includedHistoryIds).not.toEqual(expect.arrayContaining([1, 2]));
  });

  it("rejects mandatory context that cannot fit rather than truncating system prompt", () => {
    expect(() => buildModelContext({ model: { ...model, maxContextTokens: 50 }, appPrompt: "app", trigger: "go", history: [] })).toThrow(/Mandatory context/);
  });
});
