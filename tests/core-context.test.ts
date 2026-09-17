import { describe, expect, it } from "vitest";
import { buildModelContext, conservativeTokenEstimate } from "../src/shell/core/context";
import { SYSTEM_PROMPT } from "../src/shell/core/system-prompt";

const model = { id: "test", provider: "test", model: "test", maxContextTokens: 4_000, maxOutputTokens: 200 };

describe("shell context builder", () => {
  it("teaches only the namespaced runtime API", () => {
    for (const current of ["itsalive.done", "itsalive.db", "itsalive.tools", "itsalive.history", "itsalive.dom"]) {
      expect(SYSTEM_PROMPT).toContain(current);
    }
    for (const obsolete of [/return\s+done\(/, /(^|[^.\w])app\.db/, /(^|[^.\w])app\.ai/, /(^|[^.\w])agent\.wake/, /(^|[^.\w])history\.search/, /(^|[^.\w])getLogs\(/]) {
      expect(SYSTEM_PROMPT).not.toMatch(obsolete);
    }
  });

  it("always includes immutable and mandatory context plus every tool", () => {
    const result = buildModelContext({ model, appPrompt: "A violin coach", trigger: "Help me", tools: [{ name: "tally", description: "Add totals" }, { name: "find", description: "Find notes" }], history: [] });
    expect(result.system).toBe(SYSTEM_PROMPT);
    expect(result.messages.at(-1)?.content).toContain("A violin coach");
    expect(result.messages.at(-1)?.content).toContain("tally — Add totals");
    expect(result.messages.at(-1)?.content).toContain("find — Find notes");
    expect(result.messages.at(-1)?.content).toContain("Help me");
  });

  it("keeps newest fitting history rather than a fixed message count", () => {
    const tinyModel = { ...model, maxContextTokens: conservativeTokenEstimate(SYSTEM_PROMPT) + 440, maxOutputTokens: 100, observationHeadroomTokens: 100 };
    const history = Array.from({ length: 20 }, (_, index) => ({ id: index, appSlug: "a", timestamp: index, role: "user" as const, content: `message-${index} ${"x".repeat(80)}` }));
    const result = buildModelContext({ model: tinyModel, appPrompt: "coach", trigger: "go", tools: [], history });
    expect(result.omittedHistoryCount).toBeGreaterThan(0);
    expect(result.includedHistoryIds).toContain(19);
    expect(result.includedHistoryIds).not.toContain(0);
  });

  it("rejects mandatory context that cannot fit rather than truncating system prompt", () => {
    expect(() => buildModelContext({ model: { ...model, maxContextTokens: 50 }, appPrompt: "app", trigger: "go", tools: [], history: [] })).toThrow(/Mandatory context/);
  });
});
