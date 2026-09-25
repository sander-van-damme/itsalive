import { describe, expect, it } from "vitest";
import { platformCapabilityHelp, platformCapabilityIndex } from "../src/shell/core/capabilities";
import {
  buildUserIntentRequest,
  initialBuildTechnicalIntent,
  parseUserIntentDecision,
  reconcileRepairIntentWithRouting,
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

  it("turns a confident direct broken-app report into a focused repair intent", () => {
    const input: UserIntentInput = {
      appPrompt: "A stopwatch",
      source: "chat",
      userText: "the buttons dont work",
    };
    const baseline = parseUserIntentDecision(JSON.stringify({
      kind: "explanation",
      shouldCode: false,
      reply: "Thanks for flagging that.",
    }), input);
    const repaired = reconcileRepairIntentWithRouting(baseline, input, {
      route: "debug",
      routeConfidence: 0.99,
      profileRoute: "repair",
      profileConfidence: 0.98,
      confident: true,
      preferredWorkerProfile: "repair-worker",
    });

    expect(repaired).toMatchObject({
      kind: "change",
      shouldCode: true,
      technicalIntent: {
        goal: "Repair the reported app problem: the buttons dont work",
        constraints: expect.arrayContaining([
          "Preserve unrelated app behavior and existing user data.",
          "Limit changes to the reported broken behavior; do not rebuild unrelated app functionality.",
        ]),
      },
    });
    expect(repaired.technicalIntent?.acceptanceCriteria[0]).toContain("the buttons dont work");
  });

  it("does not turn questions, interaction telemetry, or low-confidence routing into repair authorization", () => {
    const routing = {
      route: "debug" as const,
      routeConfidence: 0.99,
      profileRoute: "repair" as const,
      profileConfidence: 0.98,
      confident: true,
      preferredWorkerProfile: "repair-worker" as const,
    };
    const questionInput: UserIntentInput = {
      appPrompt: "A stopwatch",
      source: "chat",
      userText: "Why don't the buttons work?",
    };
    const question = parseUserIntentDecision(JSON.stringify({
      kind: "question",
      shouldCode: false,
      reply: "I can inspect that.",
    }), questionInput);
    expect(reconcileRepairIntentWithRouting(question, questionInput, routing)).toEqual(question);

    const interactionInput: UserIntentInput = {
      appPrompt: "A stopwatch",
      source: "interaction",
      userText: "Repeated Start clicks did not change the display.",
    };
    const interactionDecision = parseUserIntentDecision(JSON.stringify({
      kind: "explanation",
      shouldCode: false,
      reply: "Observed.",
    }), interactionInput);
    expect(reconcileRepairIntentWithRouting(interactionDecision, interactionInput, routing)).toEqual(interactionDecision);

    const reportInput: UserIntentInput = {
      appPrompt: "A stopwatch",
      source: "chat",
      userText: "the buttons dont work",
    };
    const reportDecision = parseUserIntentDecision(JSON.stringify({
      kind: "explanation",
      shouldCode: false,
      reply: "Thanks.",
    }), reportInput);
    expect(reconcileRepairIntentWithRouting(reportDecision, reportInput, {
      ...routing,
      routeConfidence: 0.6,
      confident: false,
    })).toEqual(reportDecision);
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
    expect(intent.capabilityIds).toContain("ai");
    const block = technicalIntentBlock(intent);
    expect(block).toContain("application.ai.text");
    expect(block).toContain("text: await application.ai.text('Name this note') -> 'Trip ideas'");
  });

  it("selects the same AI capability for bounded decisions", () => {
    const intent = initialBuildTechnicalIntent("Classify each support ticket as billing or technical and show the chosen route.");
    expect(intent.capabilityIds).toContain("ai");
  });

  it("uses one canonical capability definition for both compact index and selected help", () => {
    const index = platformCapabilityIndex();
    const selected = platformCapabilityHelp(["ai"]);
    expect(index).toContain("application.ai.text / choose / score / decide / probability");
    expect(selected).toContain("text: await application.ai.text('Name this note') -> 'Trip ideas'");
    expect(selected).toContain("choose: await application.ai.choose");
    expect(selected).toContain("score: await application.ai.score");
    expect(selected).toContain("decide: await application.ai.decide");
    expect(selected).toContain("probability: await application.ai.probability");
    expect(selected).toContain("Do not implement your own confidence threshold");
  });
});
