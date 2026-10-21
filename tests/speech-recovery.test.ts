import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechInput } from "../src/ai/speech";

class Recognition {
  static last: Recognition;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult:
    | ((event: {
        resultIndex: number;
        results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    Recognition.last = this;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("speech recovery independent of AI credentials", () => {
  it("resets listening on permission failure and preserves the error through the subsequent end event", () => {
    vi.stubGlobal("SpeechRecognition", Recognition);
    const events: string[] = [];
    const speech = new SpeechInput({
      onText: vi.fn(),
      onState: (active) => events.push(active ? "Listening" : "Ready"),
      onError: (message) => events.push(message),
    });
    speech.start();
    Recognition.last.onerror?.({ error: "not-allowed" });
    Recognition.last.onend?.();
    expect(events.at(-1)).toContain("permission was denied");
    speech.start();
    expect(Recognition.last.start).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toBe("Listening");
  });

  it("accepts final transcription without a key or a provider call", () => {
    vi.stubGlobal("SpeechRecognition", Recognition);
    const onText = vi.fn();
    const speech = new SpeechInput({ onText, onError: vi.fn() });
    speech.start();
    Recognition.last.onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: false, 0: { transcript: "interim" } },
        { isFinal: true, 0: { transcript: "Help me practice scales" } },
      ],
    });
    expect(onText).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("Help me practice scales");
  });

  it.each(["no-speech", "network", "audio-capture", "service-not-allowed"])(
    "provides a recoverable %s state",
    (error) => {
      vi.stubGlobal("SpeechRecognition", Recognition);
      const onError = vi.fn();
      const onState = vi.fn();
      const speech = new SpeechInput({ onText: vi.fn(), onError, onState });
      speech.start();
      Recognition.last.onerror?.({ error });
      expect(onState).toHaveBeenLastCalledWith(false);
      expect(onError).toHaveBeenCalledWith(
        expect.stringMatching(/typing|type/),
      );
    },
  );

  it("keeps unsupported browsers usable through typed input", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const onError = vi.fn();
    const speech = new SpeechInput({ onText: vi.fn(), onError });
    speech.start();
    expect(speech.supported).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Type your message"),
    );
  });
});
