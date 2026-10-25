import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveVoice, type VoiceOptions } from "../src/ai/speech";
let peer: FakePeer;
let audio: FakeAudio;
let track: { enabled: boolean; stop: ReturnType<typeof vi.fn> };
class FakeAudio {
  autoplay = false;
  muted = false;
  srcObject: unknown;
  play = vi.fn(async () => {});
  pause = vi.fn();
  constructor() {
    audio = this;
  }
}
class FakePeer extends EventTarget {
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription = { sdp: "offer" };
  ontrack: ((event: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channel = {
    readyState: "open",
    onmessage: null as ((event: any) => void) | null,
    onclose: null as (() => void) | null,
    send: vi.fn(),
    close: vi.fn(),
  };
  addTrack = vi.fn();
  close = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer" }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {
    this.channel.onmessage?.({
      data: JSON.stringify({ type: "session.started" }),
    });
  });
  createDataChannel() {
    return this.channel;
  }
  constructor() {
    super();
    peer = this;
  }
}
function options(overrides: Partial<VoiceOptions> = {}): VoiceOptions {
  return {
    key: "test-key",
    spokenReplies: false,
    onState: vi.fn(),
    onTranscript: vi.fn(),
    onDelegate: vi.fn(async () => "Completed"),
    onUsage: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  track = { enabled: true, stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      })),
    },
  });
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        session: { id: "live-test" },
        transport: { sdp: "answer" },
      }),
    ),
  );
  vi.stubGlobal(
    "SpeechRecognition",
    vi.fn(() => {
      throw new Error("Native speech must not be used");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("AI live voice", () => {
  it("preserves long spoken goals, earlier context and complete delegated results", async () => {
    const result = "A detailed result. ".repeat(900);
    const opts = options({ onDelegate: vi.fn(async () => result) });
    const voice = new LiveVoice(opts);
    await voice.start();
    const originalGoal =
      "Keep this original musical practice requirement. ".repeat(600);
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: originalGoal,
      end_ms: 1,
    });
    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: originalGoal },
    ];
    for (let i = 0; i < 14; i++) {
      const role = i % 2 === 0 ? "assistant" : "user";
      const content = `Turn ${i}`;
      history.push({ role, content });
      voice.acceptEvent({
        type:
          role === "user"
            ? "session.input_transcript.delta"
            : "session.output_transcript.delta",
        delta: content,
        end_ms: i + 2,
      });
    }
    voice.acceptEvent({
      type: "session.output_transcript.delta",
      delta: "Ready?",
      end_ms: 20,
    });
    history.push({ role: "assistant", content: "Ready?" });
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "Yes, build that.",
      end_ms: 21,
    });
    voice.acceptEvent({
      type: "session.delegation.created",
      delegation: { id: "long-session", target: "client" },
    });
    expect(opts.onDelegate).toHaveBeenCalledExactlyOnceWith(
      "Yes, build that.",
      history,
    );
    await Promise.resolve();
    expect(
      peer.channel.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .find((event) => event.delegation_id === "long-session")?.content,
    ).toBe(result);
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 30 } });
  });
  it("includes conversational context for an accepted spoken suggestion", async () => {
    const opts = options();
    const voice = new LiveVoice(opts);
    await voice.start();
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "How could practice be easier?",
      end_ms: 100,
    });
    voice.acceptEvent({
      type: "session.output_transcript.delta",
      delta: "Would a practice timer help?",
      end_ms: 200,
    });
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "Yes, add that.",
      end_ms: 300,
    });
    voice.acceptEvent({
      type: "session.delegation.created",
      offset_ms: 300,
      delegation: { id: "accepted-suggestion", target: "client" },
    });
    expect(opts.onDelegate).toHaveBeenCalledWith("Yes, add that.", [
      { role: "user", content: "How could practice be easier?" },
      { role: "assistant", content: "Would a practice timer help?" },
    ]);
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 20 } });
  });
  it("starts AI media, guarantees silent playback, preserves fragments and delegates once per ID", async () => {
    const opts = options();
    const voice = new LiveVoice(opts);
    await voice.start();
    expect(audio.muted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/voice/sessions",
      expect.anything(),
    );
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "Add a ",
      end_ms: 100,
    });
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "timer",
      end_ms: 200,
    });
    const event = {
      type: "session.delegation.created",
      delegation: { id: "one", target: "client" },
    };
    voice.acceptEvent(event);
    voice.acceptEvent(event);
    await Promise.resolve();
    expect(opts.onDelegate).toHaveBeenCalledExactlyOnceWith("Add a timer", []);
    expect(peer.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("Completed"),
    );
    voice.setSpokenReplies(true);
    expect(audio.muted).toBe(false);
    voice.setMicrophone(false);
    expect(track.enabled).toBe(false);
    voice.stop();
    expect(peer.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("session.close"),
    );
    expect(peer.close).not.toHaveBeenCalled();
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 30 } });
    expect(peer.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(opts.onUsage).toHaveBeenLastCalledWith(30, true, true);
  });
  it("continues receiving transcripts while a delegated action is still running", async () => {
    let finish!: (text: string) => void;
    const opts = options({
      onDelegate: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const voice = new LiveVoice(opts);
    await voice.start();
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "Build a timer",
      end_ms: 100,
    });
    voice.acceptEvent({
      type: "session.delegation.created",
      delegation: { id: "task", target: "client" },
    });
    voice.acceptEvent({
      type: "session.output_transcript.delta",
      delta: "I am working on it.",
      end_ms: 200,
    });
    expect(opts.onTranscript).toHaveBeenCalledWith(
      "assistant",
      "I am working on it.",
    );
    finish("The app is ready.");
    await Promise.resolve();
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 20 } });
  });
  it.each([
    "Key rejected",
    { code: "invalid_api_key", message: "Key rejected" },
  ])(
    "releases the microphone and explains a sanitized connection failure (%j)",
    async (error) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error }, { status: 401 })),
      );
      const opts = options();
      const voice = new LiveVoice(opts);
      await voice.start();
      expect(opts.onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Key rejected" }),
      );
      expect(track.stop).toHaveBeenCalledOnce();
      expect(voice.active).toBe(false);
      expect((globalThis as any).SpeechRecognition).not.toHaveBeenCalled();
    },
  );
  it("handles microphone denial without contacting the provider", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("Denied", "NotAllowedError");
        }),
      },
    });
    const opts = options();
    await new LiveVoice(opts).start();
    expect(opts.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("permission"),
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(opts.onUsage).toHaveBeenLastCalledWith(0, true, false);
  });
  it("stops a permission request cleanly even if microphone access arrives late", async () => {
    let allow!: (stream: any) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise((resolve) => {
              allow = resolve;
            }),
        ),
      },
    });
    const voice = new LiveVoice(options());
    const started = voice.start();
    voice.stop();
    allow({ getTracks: () => [track] });
    await started;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
