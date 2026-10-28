import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveVoice,
  voiceAppendChunks,
  prepareVoiceHistory,
  type VoiceOptions,
} from "../src/ai/speech";
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
    onerror: null as (() => void) | null,
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
        .filter((event) => event.delegation_id === "long-session")
        .map((event) => event.content)
        .join(""),
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
    expect(opts.onUsage).toHaveBeenLastCalledWith(
      30,
      true,
      true,
      expect.objectContaining({
        providerSeconds: 30,
        outcome: "completed",
        sessionCreated: true,
      }),
    );
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
      expect(opts.onUsage).toHaveBeenLastCalledWith(
        0,
        true,
        false,
        expect.objectContaining({
          sessionCreateOutcome: "rejected",
          sessionCreated: false,
          initializationSeconds: 0,
          failureStage: "session-create",
        }),
      );
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
    expect(opts.onUsage).toHaveBeenLastCalledWith(
      0,
      true,
      false,
      expect.objectContaining({
        sessionCreateOutcome: "not-attempted",
        initializationSeconds: 0,
        failureStage: "permission",
      }),
    );
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
  it("uses the documented usage event and separates provider seconds from measured elapsed time", async () => {
    const opts = options();
    const voice = new LiveVoice(opts);
    await voice.start();
    await vi.advanceTimersByTimeAsync(2100);
    voice.acceptEvent({
      type: "session.usage.updated",
      usage: { seconds: 15 },
    });
    expect(opts.onUsage).toHaveBeenLastCalledWith(
      15,
      false,
      true,
      expect.objectContaining({
        elapsedMs: 2100,
        providerSeconds: 15,
        initializationSeconds: 15,
      }),
    );
    voice.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(opts.onUsage).toHaveBeenLastCalledWith(
      15,
      true,
      false,
      expect.objectContaining({
        elapsedMs: 17100,
        providerSeconds: 15,
        outcome: "completed",
      }),
    );
  });
  it("distinguishes ambiguous network failure from a confirmed rejected creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const opts = options();
    await new LiveVoice(opts).start();
    expect(opts.onUsage).toHaveBeenLastCalledWith(
      0,
      true,
      false,
      expect.objectContaining({
        sessionCreateOutcome: "unknown",
        initializationSeconds: 0,
        outcome: "failed",
      }),
    );
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it("records accepted initialization independently when the SDP response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ session: { id: "billed" } }, { status: 201 }),
      ),
    );
    const opts = options();
    await new LiveVoice(opts).start();
    expect(opts.onUsage).toHaveBeenLastCalledWith(
      0,
      true,
      false,
      expect.objectContaining({
        sessionCreateOutcome: "created",
        initializationSeconds: 15,
        providerSeconds: undefined,
      }),
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
  });
  it("captures request IDs, exact debug errors and connection phases without credentials or SDP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: { message: "Live setup rejected", code: "invalid_value" },
            diagnostics: {
              providerError: {
                message: "Bad input Bearer test-key",
                param: "session.input[0].content",
              },
            },
          },
          { status: 400, headers: { "x-request-id": "req-voice" } },
        ),
      ),
    );
    const onDiagnostic = vi.fn();
    const onPhase = vi.fn();
    const opts = options({ debug: true, onDiagnostic, onPhase });
    await new LiveVoice(opts).start();
    expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "permission",
      "media",
      "offer",
      "ice",
      "session-create",
      "closed",
    ]);
    const logs = JSON.stringify(onDiagnostic.mock.calls);
    expect(logs).toContain("req-voice");
    expect(logs).toContain("session.input[0].content");
    expect(logs).toContain("Bad input Bearer [redacted]");
    expect(logs).not.toContain("test-key");
    expect(logs).not.toContain('"sdp":"offer"');
    expect(opts.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "session-create",
        detail: expect.objectContaining({
          status: 400,
          providerRequestId: "req-voice",
        }),
      }),
    );
  });
  it("keeps a live connection after a correlated command error and accepts new speech", async () => {
    const opts = options();
    const voice = new LiveVoice(opts);
    await voice.start();
    voice.updateContext("The user is viewing the stopwatch.");
    const command = JSON.parse(peer.channel.send.mock.calls.at(-1)![0]);
    expect(command.type).toBe("session.thinking.append");
    voice.acceptEvent({
      type: "error",
      error: {
        code: "invalid_value",
        message: "Command failed",
        client_event_id: command.event_id,
      },
    });
    expect(voice.active).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "Keep listening",
      end_ms: 1,
    });
    expect(opts.onTranscript).toHaveBeenCalledWith("user", "Keep listening");
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 15 } });
  });
  it("handles delegation preceding its transcript without losing the request", async () => {
    const opts = options();
    const voice = new LiveVoice(opts);
    await voice.start();
    voice.acceptEvent({
      type: "session.delegation.created",
      offset_ms: 100,
      delegation: { id: "early", target: "client" },
    });
    expect(opts.onDelegate).not.toHaveBeenCalled();
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "Add a timer",
      end_ms: 100,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(opts.onDelegate).toHaveBeenCalledExactlyOnceWith("Add a timer", []);
    expect(
      peer.channel.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((event) => event.type === "session.commentary.append")
        .map((event) => event.content)
        .join(""),
    ).toBe("Completed");
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 15 } });
  });
  it("chunks Unicode append commands within the provider bound without losing text", () => {
    const input =
      "🎻Practice é with 東京. ".repeat(200) + " " + "x".repeat(498) + "🎻";
    const chunks = voiceAppendChunks(input);
    expect(chunks.join("")).toBe(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 500),
    ).toBe(true);
    expect(
      chunks.every((chunk) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(chunk)),
    ).toBe(true);
  });
  it("releases media before a failing UI callback and allows a fresh retry", async () => {
    const opts = options({
      onError: vi.fn(() => {
        throw new Error("Rendering failed");
      }),
    });
    const first = new LiveVoice(opts);
    await first.start();
    expect(() =>
      first.acceptEvent({ type: "error", error: { code: "server_error" } }),
    ).toThrow("Rendering failed");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(first.active).toBe(false);
    const next = new LiveVoice(options());
    await next.start();
    expect(next.active).toBe(true);
    expect(next.sessionId).not.toBe(first.sessionId);
    next.acceptEvent({ type: "session.closed", usage: { seconds: 15 } });
  });
  it("does not capture conversation content when debug logging is off", async () => {
    const onDiagnostic = vi.fn();
    const opts = options({ onDiagnostic });
    const voice = new LiveVoice(opts);
    await voice.start();
    voice.acceptEvent({
      type: "session.input_transcript.delta",
      delta: "Personal medical question",
      end_ms: 10,
    });
    voice.reportProgress("Personal source content");
    const command = JSON.parse(peer.channel.send.mock.calls.at(-1)![0]);
    voice.acceptEvent({
      type: "error",
      error: {
        code: "invalid_value",
        message: "Personal content echoed by provider",
        client_event_id: command.event_id,
      },
    });
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 15 } });
    const logs = JSON.stringify(onDiagnostic.mock.calls);
    expect(logs).toContain("voice.phase");
    expect(logs).not.toContain("Personal");
    expect(JSON.stringify(vi.mocked(opts.onError).mock.calls)).not.toContain(
      "Personal",
    );
  });
  it.each([128, 129])(
    "preserves all %i chronological messages across the documented startup boundary",
    (count) => {
      const history: NonNullable<VoiceOptions["history"]> = Array.from(
        { length: count },
        (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: `Turn ${i}`,
        }),
      );
      const prepared = prepareVoiceHistory(history);
      expect(prepared.startup.length).toBeLessThanOrEqual(128);
      expect(prepared.startupBytes).toBeLessThanOrEqual(8192);
      expect([...prepared.startup, ...prepared.deferred]).toEqual(history);
    },
  );
  it("restores oversized history without losing roles or text, and waits for all acknowledgments before listening", async () => {
    const history: NonNullable<VoiceOptions["history"]> = [
      { role: "user", content: "🎻Long original need. ".repeat(1200) },
      { role: "assistant", content: "When do your hands become tight?" },
      { role: "user", content: "The left hand on the G string." },
    ];
    const opts = options({ history, spokenReplies: true });
    const voice = new LiveVoice(opts);
    await voice.start();
    expect(opts.onState).not.toHaveBeenCalledWith("listening");
    expect(track.enabled).toBe(false);
    expect(audio.muted).toBe(true);
    const commands = peer.channel.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((item) => item.type === "session.thinking.append");
    const reconstructed = commands.map((item) => item.content).join("");
    expect(
      JSON.parse(
        reconstructed.slice(
          reconstructed.indexOf("\n") + 1,
          reconstructed.lastIndexOf("\n"),
        ),
      ),
    ).toEqual(history);
    for (const command of commands.slice(0, -1))
      voice.acceptEvent({
        type: "session.thinking.appended",
        client_event_id: command.event_id,
      });
    expect(opts.onState).not.toHaveBeenCalledWith("listening");
    voice.acceptEvent({
      type: "session.thinking.appended",
      client_event_id: commands.at(-1)!.event_id,
    });
    expect(opts.onState).toHaveBeenCalledWith("listening");
    expect(track.enabled).toBe(true);
    expect(audio.muted).toBe(false);
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 15 } });
  });
  it("releases media if restoring deferred conversation fails", async () => {
    const opts = options({
      history: [{ role: "user", content: "Long history ".repeat(2000) }],
    });
    const voice = new LiveVoice(opts);
    await voice.start();
    const command = peer.channel.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((item) => item.type === "session.thinking.append");
    voice.acceptEvent({
      type: "error",
      error: { code: "invalid_value", client_event_id: command.event_id },
    });
    expect(voice.active).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(opts.onState).not.toHaveBeenCalledWith("listening");
  });
  it("loads the active app and scoped preferences before listening, without appending them twice", async () => {
    const initialContext = JSON.stringify({
      app: { id: "practice", name: "Violin practice" },
      preferences: [{ scope: "all-apps", text: "Prefer dark mode" }],
      instructions: "Ask when my goal is ambiguous",
    });
    const opts = options({ initialContext });
    const voice = new LiveVoice(opts);
    await voice.start();
    expect(opts.onState).not.toHaveBeenCalledWith("listening");
    expect(track.enabled).toBe(false);
    const commands = peer.channel.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((event) => event.type === "session.thinking.append");
    expect(commands.map((event) => event.content).join("")).toContain(
      initialContext,
    );
    for (const command of commands)
      voice.acceptEvent({
        type: "session.thinking.appended",
        client_event_id: command.event_id,
      });
    expect(opts.onState).toHaveBeenCalledWith("listening");
    const count = peer.channel.send.mock.calls.length;
    voice.updateContext(initialContext);
    expect(peer.channel.send.mock.calls).toHaveLength(count);
    voice.updateContext("The user switched to the stopwatch.");
    expect(peer.channel.send.mock.calls).toHaveLength(count + 1);
    voice.acceptEvent({ type: "session.closed", usage: { seconds: 15 } });
  });
  it("releases media if its device is removed while listening", async () => {
    const opts = options();
    const voice = new LiveVoice(opts);
    await voice.start();
    (track as unknown as MediaStreamTrack).onended?.(new Event("ended") as any);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(opts.onError).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { code: "microphone_ended" } }),
    );
  });
  it("releases media on ICE transport failure without requiring another browser event", async () => {
    const opts = options();
    const voice = new LiveVoice(opts);
    await voice.start();
    const connection = peer as unknown as RTCPeerConnection;
    Object.defineProperty(connection, "iceConnectionState", {
      value: "failed",
    });
    connection.oniceconnectionstatechange?.(
      new Event("iceconnectionstatechange"),
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(voice.active).toBe(false);
    expect(opts.onError).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { code: "ice_failed" } }),
    );
  });
});
