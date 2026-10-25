import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  BehaviorAdvisor,
  ScriptedProvider,
  CONVERSATION_SYSTEM,
  converse,
  demoAIConfig,
} from "../src/ai";
const context = { appId: "app", correlationId: "trace" };
describe("conversation and optional behavioral adaptations", () => {
  it("separates questions from proposed structural changes without coding", async () => {
    const service = new AIService(demoAIConfig());
    expect(
      (await converse(service, "How does this work?", [], context))
        .changeRequest,
    ).toBeNull();
    const proposed = await converse(
      service,
      "Change the title to Notes",
      [],
      context,
    );
    expect(proposed.changeRequest).toBe("Change the title to Notes");
    expect(proposed.intent).toBe("change");
    expect(proposed.confirmationReason).toBeNull();
    expect(
      service.usage.every((record) => record.role === "conversation"),
    ).toBe(true);
  });
  it("requires specific risk confirmation and does not treat uncertain feedback as authorization", async () => {
    const provider = new ScriptedProvider([
      {
        text: JSON.stringify({
          workLevel: "medium",
          reply: "This will erase your saved exercises.",
          intent: "confirm",
          changeRequest: "Clear all saved exercises",
          confirmationReason:
            "Your saved exercises will be permanently deleted.",
        }),
        toolCalls: [],
      },
      {
        text: JSON.stringify({
          workLevel: "medium",
          reply: "What's still wrong?",
          intent: "clarify",
          changeRequest: null,
          confirmationReason: null,
        }),
        toolCalls: [],
      },
      {
        text: JSON.stringify({
          workLevel: "medium",
          reply: "I'll investigate the Start button.",
          intent: "change",
          changeRequest: "Inspect and repair the Start button",
          confirmationReason: null,
        }),
        toolCalls: [],
      },
    ]);
    const service = new AIService(demoAIConfig(), {
      providers: { demo: provider },
    });
    const destructive = await converse(
      service,
      "Clear all saved exercises",
      [],
      context,
    );
    expect(destructive.intent).toBe("confirm");
    expect(destructive.confirmationReason).toContain("permanently deleted");
    const negative = await converse(service, "Not yet", [], context, {
      originalRequest: "Fix Start",
      unresolved: true,
    });
    expect(negative.changeRequest).toBeNull();
    const correction = await converse(
      service,
      "The exercise doesn't respond when I click Start",
      [],
      context,
      { originalRequest: "Fix Start", unresolved: true },
    );
    expect(correction.intent).toBe("change");
    expect(correction.changeRequest).toContain("repair the Start button");
    expect(
      service.usage.every((record) => record.role === "conversation"),
    ).toBe(true);
    expect(CONVERSATION_SYSTEM).toContain("already authorizes normal work");
  });
  it("rejects incomplete or contradictory model authorization before any coding", async () => {
    const provider = new ScriptedProvider([
      {
        text: JSON.stringify({
          workLevel: "medium",
          reply: "Done",
          changeRequest: "Rewrite everything",
        }),
        toolCalls: [],
      },
      {
        text: JSON.stringify({
          workLevel: "medium",
          reply: "Discussing",
          intent: "conversation",
          changeRequest: "Rewrite everything",
          confirmationReason: null,
        }),
        toolCalls: [],
      },
      {
        text: JSON.stringify({
          workLevel: "medium",
          reply: "Confirm",
          intent: "confirm",
          changeRequest: "Delete data",
          confirmationReason: null,
        }),
        toolCalls: [],
      },
    ]);
    const service = new AIService(demoAIConfig(), {
      providers: { demo: provider },
    });
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(
        converse(service, "What's this?", [], context),
      ).rejects.toThrow("incomplete response");
  });
  it("preserves long messages, complete history and the unresolved goal", async () => {
    const text = "Create exercises. ".repeat(1000);
    const originalRequest = "Preserve all practice goals. ".repeat(400);
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `${i}: ${"practice ".repeat(600)}`,
    }));
    const provider = new ScriptedProvider([
      {
        text: JSON.stringify({
          reply: "Understanding your goal. ".repeat(1000),
          appName: "Violin Practice",
          workLevel: "medium",
          intent: "change",
          changeRequest: text,
          confirmationReason: null,
        }),
        toolCalls: [],
      },
    ]);
    const generate = vi.spyOn(provider, "generate");
    const service = new AIService(demoAIConfig(), {
      providers: { demo: provider },
    });
    const reply = await converse(service, text, history, context, {
      originalRequest,
      unresolved: true,
    });
    const messages = generate.mock.calls[0]![1].messages;
    expect(messages).toHaveLength(history.length + 3);
    expect(messages[1]!.content).toContain(originalRequest);
    expect(messages[2]).toEqual(history[0]);
    expect(messages.at(-1)!.content).toBe(text);
    expect(reply.changeRequest).toBe(text);
    expect(reply.reply.length).toBeGreaterThan(12000);
    expect(reply.appName).toBe("Violin Practice");
  });
  it("uses a safe fallback when the model returns a request instead of a concise title", async () => {
    const provider = new ScriptedProvider([
      {
        text: JSON.stringify({
          reply: "I’ll create your app.",
          appName: "I want to learn to play chords and scales on the violin",
          workLevel: "medium",
          intent: "change",
          changeRequest: "Build a violin practice app",
          confirmationReason: null,
        }),
        toolCalls: [],
      },
    ]);
    const service = new AIService(demoAIConfig(), {
      providers: { demo: provider },
    });
    expect(
      (await converse(service, "Build a violin trainer", [], context)).appName,
    ).toBeNull();
  });
  it("filters signals, offers once, and never turns dismissal/ignoring into coding", async () => {
    let now = 100_000;
    const service = new AIService(demoAIConfig());
    const advisor = new BehaviorAdvisor(service, () => now);
    expect(
      await advisor.observe(
        { kind: "repeated-click", target: "button", count: 2, durationMs: 500 },
        context,
      ),
    ).toBeNull();
    expect(service.usage).toHaveLength(0);
    const suggestion = await advisor.observe(
      { kind: "repeated-click", target: "button", count: 4, durationMs: 700 },
      context,
    );
    expect(suggestion?.status).toBe("offered");
    expect(
      await advisor.observe(
        { kind: "repeated-click", target: "button", count: 4, durationMs: 700 },
        context,
      ),
    ).toBeNull();
    expect(advisor.resolve(suggestion!.id, "dismissed")?.status).toBe(
      "dismissed",
    );
    expect(advisor.resolve(suggestion!.id, "accepted")).toBeUndefined();
    now += 61_000;
    const next = await advisor.observe(
      { kind: "repeated-click", target: "button", count: 4, durationMs: 700 },
      context,
    );
    expect(advisor.resolve(next!.id, "ignored")?.status).toBe("ignored");
    expect(service.usage.every((record) => record.role === "decision")).toBe(
      true,
    );
  });
});
