import { describe, expect, it } from "vitest";
import { buildModelContext, conservativeTokenEstimate } from "../src/shell/core/context";
import { SYSTEM_PROMPT } from "../src/shell/core/system-prompt";

const model = { id: "test", provider: "test", model: "test", maxContextTokens: 4_000, maxOutputTokens: 200 };

describe("shell context builder", () => {
  it("teaches only the namespaced runtime API", () => {
    for (const current of ["itsalive.done", "itsalive.tools", "itsalive.history", "itsalive.dom", "itsalive.llm"]) {
      expect(SYSTEM_PROMPT).toContain(current);
    }
    expect(SYSTEM_PROMPT).toContain("native browser IndexedDB");
    expect(SYSTEM_PROMPT).toContain("own browser origin");
    for (const obsolete of [/itsalive\.db/, /itsalive\.reload/, /return\s+done\(/, /itsalive\.ai/, /(^|[^.\w])app\.db/, /(^|[^.\w])app\.ai/, /(^|[^.\w])agent\.wake/, /(^|[^.\w])history\.search/, /(^|[^.\w])getLogs\(/]) {
      expect(SYSTEM_PROMPT).not.toMatch(obsolete);
    }
  });

  it("defines a streamed multi-command drawing-board contract", () => {
    expect(SYSTEM_PROMPT).toContain("one model response containing one or more independently executable JavaScript commands");
    expect(SYSTEM_PROMPT).toContain("/* itsalive:command */");
    expect(SYSTEM_PROMPT).toContain("/* itsalive:end */");
    expect(SYSTEM_PROMPT).toContain("executes each command as soon as its closing delimiter arrives");
    expect(SYSTEM_PROMPT).toContain("Commands later in the same response cannot use the return value of an earlier command");
    expect(SYSTEM_PROMPT).toContain("Treat it as a drawing board");
    expect(SYSTEM_PROMPT).toContain("ordinary semantic HTML and browser DOM APIs by default");
    expect(SYSTEM_PROMPT).toContain("Custom Elements are optional, not required");
    expect(SYSTEM_PROMPT).not.toMatch(/MUST be implemented as native Custom Elements/);
    expect(SYSTEM_PROMPT).toMatch(/Apps must be responsive/);
    expect(SYSTEM_PROMPT).toMatch(/one column on narrow\/mobile layouts/);
  });

  it("always includes immutable and mandatory context plus every tool", () => {
    const result = buildModelContext({ model, appPrompt: "A violin coach", trigger: "Help me", tools: [{ name: "tally", description: "Add totals" }, { name: "find", description: "Find notes" }], history: [] });
    expect(result.system).toBe(SYSTEM_PROMPT);
    expect(result.messages.at(-1)?.content).toContain("A violin coach");
    expect(result.messages.at(-1)?.content).toContain("tally — Add totals");
    expect(result.messages.at(-1)?.content).toContain("find — Find notes");
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
    const result = buildModelContext({ model: { ...model, maxContextTokens: 12_000 }, appPrompt: "coach", trigger, observation, tools: [], history });
    const joined = result.messages.map(message => message.content).join("\n");

    expect(joined.split(trigger)).toHaveLength(2);
    expect(joined.split(observation)).toHaveLength(2);
    expect(result.includedHistoryIds).not.toContain(1);
    expect(result.includedHistoryIds).not.toContain(3);
  });

  it("keeps newest fitting history rather than a fixed message count", () => {
    const tinyModel = { ...model, maxContextTokens: conservativeTokenEstimate(SYSTEM_PROMPT) + 440, maxOutputTokens: 100, observationHeadroomTokens: 100 };
    const history = Array.from({ length: 20 }, (_, index) => ({ id: index, appId: "550e8400-e29b-41d4-a716-446655440006", timestamp: index, role: "user" as const, content: `message-${index} ${"x".repeat(80)}` }));
    const result = buildModelContext({ model: tinyModel, appPrompt: "coach", trigger: "go", tools: [], history });
    expect(result.omittedHistoryCount).toBeGreaterThan(0);
    expect(result.includedHistoryIds).toContain(19);
    expect(result.includedHistoryIds).not.toContain(0);
  });

  it("hard-bounds operational trace history even with a very large context window", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      appId: "app",
      timestamp: index,
      role: index % 2 ? "observation" as const : "agent" as const,
      kind: index % 2 ? "execution" as const : "javascript" as const,
      content: `operation-${index} ${"x".repeat(1_000)}`,
    }));
    const result = buildModelContext({
      model: { ...model, maxContextTokens: 128_000, maxOutputTokens: 8_192 },
      appPrompt: "coach",
      trigger: "tiny follow-up",
      tools: [],
      history,
    });

    expect(result.includedHistoryIds).toEqual([25, 26, 27, 28, 29, 30]);
    expect(result.estimatedInputTokens).toBeLessThan(10_000);
  });

  it("rejects mandatory context that cannot fit rather than truncating system prompt", () => {
    expect(() => buildModelContext({ model: { ...model, maxContextTokens: 50 }, appPrompt: "app", trigger: "go", tools: [], history: [] })).toThrow(/Mandatory context/);
  });
});
