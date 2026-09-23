import { describe, expect, it } from "vitest";
import { platformCapabilityHelp, platformCapabilityIndex } from "../src/shell/core/capabilities";
import {
  buildUserIntentRequest,
  initialBuildTechnicalIntent,
  parseUserIntentDecision,
  technicalIntentBlock,
  type UserIntentInput,
} from "../src/shell/core/user-intent";

const model = { provider: "test", model: "test", maxContextTokens: 32_000, outputHeadroomTokens: 2_000, historyContextTokens: 1_000 };

describe("user-facing intent boundary", () => {
  const interaction: UserIntentInput = {
    appPrompt: "A stopwatch",
    source: "interaction",
    userText: "I thought the page was already loaded, but it was not.",
    telemetrySummary: "The user clicked Start while the page was still hydrating.",
  };

  it("explicitly teaches the user-facing manager that explanation is not code authorization", () => {
    const request = buildUserIntentRequest(interaction, model);
    expect(request.system).toContain("An explanation of what happened is NOT permission to modify code");
    expect(request.system).toContain("telemetry is evidence");
    expect(request.messages[0]?.content).toContain(interaction.userText);
    expect(request.messages[0]?.content).toContain(interaction.telemetrySummary);
  });

  it("records explanation-only interpretation without producing a technical coding intent", () => {
    const decision = parseUserIntentDecision(JSON.stringify({
      kind: "explanation",
      shouldCode: false,
      reply: "Thanks, that explains what happened. I won’t change the app from that alone.",
    }), interaction);

    expect(decision).toEqual({
      kind: "explanation",
      shouldCode: false,
      reply: "Thanks, that explains what happened. I won’t change the app from that alone.",
    });
    expect(decision.technicalIntent).toBeUndefined();
  });

  it("rejects contradictory authorization for an explanation", () => {
    expect(() => parseUserIntentDecision(JSON.stringify({
      kind: "explanation",
      shouldCode: true,
      reply: "",
      technicalIntent: {
        goal: "Add a loading screen",
        constraints: [],
        acceptanceCriteria: [],
        capabilityIds: [],
      },
    }), interaction)).toThrow("may authorize coding only for a change request");
  });

  it("turns an explicit requested change into a compact technical intent", () => {
    const input: UserIntentInput = {
      appPrompt: "A stopwatch",
      source: "chat",
      userText: "Add a reset button, but keep the current lap list.",
    };
    const decision = parseUserIntentDecision(JSON.stringify({
      kind: "change",
      shouldCode: true,
      reply: "",
      technicalIntent: {
        goal: "Add a reset control that resets elapsed time.",
        constraints: ["Keep the existing lap list unchanged."],
        acceptanceCriteria: ["Reset returns the timer to zero.", "Existing laps remain visible."],
        capabilityIds: [],
      },
    }), input);

    expect(decision.shouldCode).toBe(true);
    expect(decision.technicalIntent).toMatchObject({
      goal: "Add a reset control that resets elapsed time.",
      constraints: ["Keep the existing lap list unchanged."],
      acceptanceCriteria: ["Reset returns the timer to zero.", "Existing laps remain visible."],
    });
    const block = technicalIntentBlock(decision.technicalIntent!);
    expect(block).toContain("TECHNICAL INTENT");
    expect(block).toContain("Keep the existing lap list unchanged.");
    expect(block).not.toContain(input.userText);
  });

  it("surfaces native LLM help for an open-ended poem generator without the full manual", () => {
    const intent = initialBuildTechnicalIntent("A button that generates a new poem on click");
    expect(intent.capabilityIds).toContain("llm.ask");
    const block = technicalIntentBlock(intent);
    expect(block).toContain("itsalive.llm.ask");
    expect(block).toContain("Write a short poem about the sea.");
    expect(block).not.toContain("itsalive.cron");
    expect(block).not.toContain("itsalive.history.search");
  });

  it("uses one canonical capability definition for both compact index and selected help", () => {
    const index = platformCapabilityIndex();
    const selected = platformCapabilityHelp(["llm.ask"]);
    expect(index).toContain("await itsalive.llm.ask<T>(prompt)");
    expect(selected).toContain("await itsalive.llm.ask<T>(prompt)");
    expect(selected).toContain("open-ended generated or transformed content");
  });
});
