import { describe, expect, it, vi } from "vitest";
import {
  AIService,
  BehaviorAdvisor,
  SpeechInput,
  ScriptedProvider,
  CONVERSATION_SYSTEM,
  converse,
  reason,
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
          reply: "What's still wrong?",
          intent: "clarify",
          changeRequest: null,
          confirmationReason: null,
        }),
        toolCalls: [],
      },
      {
        text: JSON.stringify({
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
          reply: "Done",
          changeRequest: "Rewrite everything",
        }),
        toolCalls: [],
      },
      {
        text: JSON.stringify({
          reply: "Discussing",
          intent: "conversation",
          changeRequest: "Rewrite everything",
          confirmationReason: null,
        }),
        toolCalls: [],
      },
      {
        text: JSON.stringify({
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
  it("runs explicitly requested deeper reasoning without coding authority", async () => {
    const service = new AIService(demoAIConfig());
    expect(
      await reason(
        service,
        "Help me think through a practice routine",
        [],
        context,
      ),
    ).toContain("Demo response");
    expect(service.usage.map((record) => record.role)).toEqual(["reasoning"]);
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
  it("starts browser recognition only on user action and emits final text without coding", () => {
    let recognizer: FakeRecognition | undefined;
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult:
        | ((event: {
            resultIndex: number;
            results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
          }) => void)
        | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        recognizer = this;
      }
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    try {
      const onText = vi.fn();
      const onError = vi.fn();
      const onState = vi.fn();
      const speech = new SpeechInput({
        onText,
        onError,
        onState,
        language: "nl-BE",
      });
      expect(speech.supported).toBe(true);
      expect(recognizer?.start).not.toHaveBeenCalled();
      speech.start();
      expect(recognizer?.start).toHaveBeenCalledOnce();
      expect(recognizer?.lang).toBe("nl-BE");
      recognizer?.onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: false, 0: { transcript: "partial" } },
          { isFinal: true, 0: { transcript: "Make a practice routine" } },
        ],
      });
      expect(onText).toHaveBeenCalledExactlyOnceWith("Make a practice routine");
      recognizer?.onerror?.({ error: "not-allowed" });
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining("permission was denied"),
      );
      speech.dispose();
      expect(recognizer?.abort).toHaveBeenCalledOnce();
      expect(recognizer?.onresult).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("keeps a usable typing fallback when speech is unavailable", () => {
    const onError = vi.fn();
    const onText = vi.fn();
    const speech = new SpeechInput({ onError, onText });
    expect(speech.supported).toBe(false);
    speech.start();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Type your message"),
    );
    expect(onText).not.toHaveBeenCalled();
    speech.dispose();
  });
});
