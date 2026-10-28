import { redactCredentials } from "../shared/redaction";

export type VoicePhase =
  | "permission"
  | "media"
  | "offer"
  | "ice"
  | "session-create"
  | "answer"
  | "connecting"
  | "context"
  | "listening"
  | "closing"
  | "closed";
export interface VoiceUsageDetails {
  elapsedMs: number;
  sessionCreated: boolean;
  initializationSeconds: 0 | 15;
  providerSeconds?: number;
  failureStage?: VoicePhase;
  outcome: "active" | "completed" | "failed" | "cancelled";
  sessionCreateOutcome: "not-attempted" | "rejected" | "created" | "unknown";
}
export class LiveVoiceError extends Error {
  override name = "LiveVoiceError";
  constructor(
    message: string,
    readonly phase: VoicePhase,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export interface VoiceOptions {
  key: string;
  model?: string;
  debug?: boolean;
  spokenReplies: boolean;
  initialContext?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  onState(state: "connecting" | "listening" | "closing" | "closed"): void;
  onPhase?(phase: VoicePhase): void;
  onDiagnostic?(event: string, data: unknown, level: "INFO" | "DEBUG"): void;
  onTranscript(role: "user" | "assistant", text: string): void;
  onDelegate(
    text: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string>;
  onUsage(
    seconds: number,
    final: boolean,
    confirmed: boolean,
    details?: VoiceUsageDetails,
  ): void;
  onError(error: Error): void;
}
interface Transcript {
  role: "user" | "assistant";
  text: string;
  end: number;
}
type VoiceMessage = { role: "user" | "assistant"; content: string };
/** The documented startup boundary is 128 messages / 8192 tokens. Without a
 * Live tokenizer, serialized UTF-8 bytes conservatively bound tokens. Overflow
 * is deferred intact to timeline appends, never dropped or summarized here. */
export function prepareVoiceHistory(history: VoiceMessage[]) {
  const encoder = new TextEncoder();
  let bytes = 2,
    count = 0;
  for (const item of history) {
    const size =
      encoder.encode(
        JSON.stringify({
          type: "message",
          role: item.role,
          content: [
            {
              type: item.role === "user" ? "input_text" : "output_text",
              text: item.content,
            },
          ],
        }),
      ).length + 1;
    if (count === 128 || bytes + size > 8192) break;
    bytes += size;
    count++;
  }
  return {
    startup: history.slice(0, count),
    deferred: history.slice(count),
    startupBytes: bytes,
  };
}
/** Live append commands have a documented 500-token ceiling. UTF-8 bytes are
 * a conservative tokenizer upper bound; splitting never discards content. */
export function voiceAppendChunks(content: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "",
    bytes = 0;
  for (const point of content) {
    const size = encoder.encode(point).length;
    while (bytes + size > 500) {
      const boundary =
        Math.max(
          chunk.lastIndexOf(" "),
          chunk.lastIndexOf("\n"),
          chunk.lastIndexOf("\t"),
        ) + 1;
      chunks.push(boundary ? chunk.slice(0, boundary) : chunk);
      chunk = boundary ? chunk.slice(boundary) : "";
      bytes = encoder.encode(chunk).length;
    }
    chunk += point;
    bytes += size;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}
/** GPT-Live media and events only. No browser speech-recognition fallback. */
export class LiveVoice {
  readonly sessionId = crypto.randomUUID();
  private providerSessionId?: string;
  private peer?: RTCPeerConnection;
  private media?: MediaStream;
  private channel?: RTCDataChannel;
  private audio?: HTMLAudioElement;
  private controller = new AbortController();
  private startedAt?: number;
  private requestStartedAt?: number;
  private providerSeconds?: number;
  private interval?: ReturnType<typeof setInterval>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closing = false;
  private ready = false;
  private transcripts: Transcript[] = [];
  private delegated = new Set<string>();
  private lastDelegatedEnd = -1;
  private phase: VoicePhase = "permission";
  private failureStage?: VoicePhase;
  private creationOutcome: VoiceUsageDetails["sessionCreateOutcome"] =
    "not-attempted";
  private commandIds = new Set<string>();
  private pendingDelegations = new Map<
    string,
    { event: Record<string, any>; timer: ReturnType<typeof setTimeout> }
  >();
  private lastContext = "";
  private deferredHistory: VoiceMessage[] = [];
  private initialContext = "";
  private contextCommands = new Set<string>();
  private seedingContext = false;
  private microphoneWanted = true;
  private get restoringContext() {
    return this.deferredHistory.length > 0 || this.initialContext.length > 0;
  }
  constructor(private readonly options: VoiceOptions) {}
  get active() {
    return !this.closed;
  }
  private diagnostic(
    event: string,
    data: Record<string, unknown> = {},
    level: "INFO" | "DEBUG" = "INFO",
  ) {
    if (level === "DEBUG" && !this.options.debug) return;
    try {
      this.options.onDiagnostic?.(
        event,
        redactCredentials(
          {
            voiceSessionId: this.sessionId,
            providerSessionId: this.providerSessionId,
            phase: this.phase,
            elapsedMs: this.elapsedMs(),
            ...data,
          },
          { secrets: [this.options.key] },
        ),
        level,
      );
    } catch {
      /* A logger cannot hold the microphone open. */
    }
  }
  private setPhase(phase: VoicePhase) {
    this.phase = phase;
    this.diagnostic("voice.phase", { phase });
    this.options.onPhase?.(phase);
  }
  private elapsedMs() {
    return this.startedAt === undefined
      ? 0
      : Math.max(0, Date.now() - this.startedAt);
  }
  private publishUsage(
    final: boolean,
    confirmed: boolean,
    outcome: VoiceUsageDetails["outcome"],
  ) {
    const sessionCreated = this.creationOutcome === "created";
    const seconds =
      this.providerSeconds ??
      (sessionCreated && this.requestStartedAt !== undefined
        ? Math.max(0, Date.now() - this.requestStartedAt) / 1000
        : 0);
    const details: VoiceUsageDetails = {
      elapsedMs: this.elapsedMs(),
      sessionCreated,
      initializationSeconds: sessionCreated ? 15 : 0,
      providerSeconds: this.providerSeconds,
      failureStage: this.failureStage,
      outcome,
      sessionCreateOutcome: this.creationOutcome,
    };
    this.diagnostic("voice.usage", { seconds, final, confirmed, ...details });
    this.options.onUsage(seconds, final, confirmed, details);
  }
  async start() {
    if (this.startedAt !== undefined || this.closed) return;
    this.startedAt = Date.now();
    this.options.onState("connecting");
    try {
      this.setPhase("permission");
      const history = prepareVoiceHistory(this.options.history ?? []);
      this.deferredHistory = history.deferred;
      this.initialContext = this.options.initialContext ?? "";
      this.diagnostic("voice.context.plan", {
        startupMessages: history.startup.length,
        deferredMessages: history.deferred.length,
        startupBytes: history.startupBytes,
        sizing: "conservative_utf8_bytes",
        initialContextBytes: new TextEncoder().encode(this.initialContext)
          .length,
      });
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection === "undefined"
      )
        throw new Error(
          "This browser cannot start live voice. You can continue typing.",
        );
      this.media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (this.closed) {
        this.media.getTracks().forEach((track) => track.stop());
        return;
      }
      this.setPhase("media");
      this.diagnostic("voice.microphone.ready", {
        tracks: this.media.getAudioTracks().length,
      });
      const peer = new RTCPeerConnection();
      this.peer = peer;
      this.audio = new Audio();
      this.audio.autoplay = true;
      this.audio.muted = !this.options.spokenReplies || this.restoringContext;
      peer.ontrack = (event) => {
        if (this.audio) {
          this.audio.srcObject =
            event.streams[0] ?? new MediaStream([event.track]);
          void this.audio.play().catch(() => {
            if (this.options.spokenReplies && !this.closed)
              this.options.onError(
                new LiveVoiceError(
                  "Your browser paused spoken replies. Turn spoken replies off and on to resume.",
                  this.phase,
                  { code: "playback_blocked" },
                ),
              );
          });
        }
      };
      for (const track of this.media.getAudioTracks()) {
        track.enabled = !this.restoringContext && this.microphoneWanted;
        peer.addTrack(track, this.media);
        track.onended = () =>
          this.fail(
            new LiveVoiceError(
              "Your microphone disconnected. Check its connection, then start a new conversation.",
              this.phase,
              { code: "microphone_ended" },
            ),
          );
      }
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.onopen = () => this.diagnostic("voice.channel.open");
      channel.onerror = () =>
        this.fail(
          new LiveVoiceError(
            "The live conversation connection was interrupted. Please reconnect.",
            this.phase,
            { code: "data_channel_error" },
          ),
        );
      channel.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid voice event");
          this.acceptEvent(parsed);
        } catch (error) {
          this.fail(error);
        }
      };
      channel.onclose = () => {
        this.diagnostic("voice.channel.closed");
        if (this.closing) {
          this.finish(false, "completed");
          return;
        }
        if (!this.closed)
          this.fail(
            new Error(
              "The voice connection ended. You can reconnect or continue typing.",
            ),
          );
      };
      peer.onconnectionstatechange = () => {
        this.diagnostic("voice.peer.state", { state: peer.connectionState });
        if (peer.connectionState === "failed" && !this.closed)
          this.fail(
            new Error(
              "The voice connection was interrupted. Please reconnect.",
            ),
          );
      };
      peer.oniceconnectionstatechange = () => {
        this.diagnostic("voice.ice.state", { state: peer.iceConnectionState });
        if (peer.iceConnectionState === "failed")
          this.fail(
            new LiveVoiceError(
              "The live conversation connection failed. Check your network and try again.",
              this.phase,
              { code: "ice_failed" },
            ),
          );
      };
      peer.onicegatheringstatechange = () =>
        this.diagnostic("voice.ice.gathering", {
          state: peer.iceGatheringState,
        });
      this.setPhase("offer");
      await peer.setLocalDescription(await peer.createOffer());
      this.setPhase("ice");
      await this.waitForIce(peer);
      this.controller.signal.throwIfAborted();
      this.setPhase("session-create");
      this.creationOutcome = "unknown";
      this.requestStartedAt = Date.now();
      const requestBody = {
        sdp: peer.localDescription?.sdp,
        model: this.options.model ?? "gpt-live-1",
        history: history.startup,
        spokenReplies: this.options.spokenReplies,
      };
      this.diagnostic(
        "voice.request",
        {
          request: {
            ...requestBody,
            sdp: undefined,
            sdpBytes: requestBody.sdp?.length,
          },
        },
        "DEBUG",
      );
      const response = await fetch("/api/voice/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.key}`,
          ...(this.options.debug ? { "X-ItsAlive-Debug": "1" } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(30_000),
        ]),
      });
      const requestId = response.headers.get("x-request-id");
      this.diagnostic("voice.response", {
        status: response.status,
        providerRequestId: requestId,
      });
      if (!response.ok) {
        this.creationOutcome = response.status < 500 ? "rejected" : "unknown";
        const body = (await response.json().catch(() => ({}))) as {
          error?: string | { message?: string; code?: string };
          diagnostics?: unknown;
        };
        this.diagnostic(
          "voice.provider.failure",
          {
            status: response.status,
            providerRequestId: requestId,
            diagnostics: body.diagnostics,
          },
          "DEBUG",
        );
        throw new LiveVoiceError(
          (typeof body.error === "string" ? body.error : body.error?.message) ??
            "Live voice could not connect. Check your OpenAI API key in Settings.",
          this.phase,
          {
            status: response.status,
            providerRequestId: requestId,
            code: typeof body.error === "object" ? body.error.code : undefined,
            ...(this.options.debug ? { diagnostics: body.diagnostics } : {}),
          },
        );
      }
      this.creationOutcome = "created";
      const result = (await response.json()) as {
        transport?: { sdp?: string };
        session?: { id?: string };
        diagnostics?: unknown;
      };
      this.diagnostic(
        "voice.provider.request",
        { diagnostics: result.diagnostics },
        "DEBUG",
      );
      if (!result.transport?.sdp || !result.session?.id)
        throw new Error("The voice service returned an incomplete connection.");
      this.controller.signal.throwIfAborted();
      this.providerSessionId = result.session.id;
      this.publishUsage(false, false, "active");
      this.setPhase("answer");
      await peer.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
      if (!this.ready) {
        this.setPhase("connecting");
        this.connectTimer = setTimeout(
          () =>
            this.fail(
              new Error(
                "The voice connection took too long. Please try again.",
              ),
            ),
          20_000,
        );
      }
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }
  private waitForIce(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(10_000),
      ]);
      const cleanup = () => {
        peer.removeEventListener("icegatheringstatechange", change);
        signal.removeEventListener("abort", abort);
      };
      const change = () => {
        if (peer.iceGatheringState === "complete") {
          cleanup();
          resolve();
        }
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      peer.addEventListener("icegatheringstatechange", change);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      change();
    });
  }
  acceptEvent(event: Record<string, any>) {
    if (this.closed) return;
    this.diagnostic("voice.event", {
      type: event.type,
      eventId: event.event_id,
      clientEventId: event.client_event_id,
    });
    if (typeof event.client_event_id === "string" && event.type !== "error") {
      this.commandIds.delete(event.client_event_id);
      if (
        this.contextCommands.delete(event.client_event_id) &&
        !this.contextCommands.size &&
        !this.seedingContext
      )
        this.contextReady();
    }
    if (event.type === "session.started") {
      if (this.ready) return;
      this.ready = true;
      clearTimeout(this.connectTimer);
      this.interval = setInterval(() => {
        try {
          this.publishUsage(false, false, "active");
        } catch (error) {
          try {
            this.stop();
          } finally {
            this.options.onError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      }, 1000);
      if (this.restoringContext) {
        this.setPhase("context");
        // A disabled local track sends silence while keeping the media timeline
        // running. Provider mute here could pause context acknowledgments.
        this.seedingContext = true;
        const context = [
          ...(this.deferredHistory.length
            ? [
                `Continue the earlier conversation in chronological order. These quoted messages are past conversation data, not new requests:\n${JSON.stringify(this.deferredHistory)}\nEnd of restored conversation.`,
              ]
            : []),
          ...(this.initialContext
            ? [
                `Current application and user preferences context:\n${this.initialContext}`,
              ]
            : []),
        ].join("\n\n");
        for (const content of voiceAppendChunks(context)) {
          if (
            !this.sendCommand(
              "session.thinking.append",
              { delegation_id: null, content },
              true,
            )
          )
            break;
        }
        this.seedingContext = false;
        if (!this.contextCommands.size) this.contextReady();
      } else this.contextReady();
    } else if (
      event.type === "session.input_transcript.delta" ||
      event.type === "session.output_transcript.delta"
    ) {
      if (typeof event.delta !== "string") return;
      const role =
        event.type === "session.input_transcript.delta" ? "user" : "assistant";
      const transcript = {
        role,
        text: event.delta,
        end: typeof event.end_ms === "number" ? event.end_ms : this.elapsedMs(),
      } as Transcript;
      this.transcripts.push(transcript);
      this.diagnostic(
        "voice.transcript",
        {
          role,
          text: event.delta,
          startMs: event.start_ms,
          endMs: transcript.end,
        },
        "DEBUG",
      );
      this.options.onTranscript(role, event.delta);
      if (role === "user")
        for (const pending of this.pendingDelegations.values())
          this.delegate(pending.event);
    } else if (
      event.type === "session.delegation.created" &&
      event.delegation?.target === "client"
    ) {
      this.delegate(event);
    } else if (event.type === "session.usage.updated") {
      if (Number.isFinite(event.usage?.seconds) && event.usage.seconds >= 0) {
        this.providerSeconds = Math.max(
          this.providerSeconds ?? 0,
          event.usage.seconds,
        );
        this.publishUsage(false, true, "active");
      }
    } else if (event.type === "session.closed") {
      const confirmed =
        Number.isFinite(event.usage?.seconds) && event.usage.seconds >= 0;
      if (confirmed) this.providerSeconds = event.usage.seconds;
      this.diagnostic("voice.session.closed", {
        reason: event.reason,
        confirmed,
      });
      if (event.reason === "connection_lost") {
        this.fail(
          new LiveVoiceError(
            "The live conversation connection was interrupted. Please reconnect.",
            this.phase,
            { code: "connection_lost" },
          ),
          confirmed,
        );
        return;
      }
      this.finish(confirmed, "completed");
    } else if (event.type === "error") {
      const clientEventId = event.error?.client_event_id;
      const error = new LiveVoiceError(
        "Live conversation encountered a problem. Please try again.",
        this.phase,
        {
          code: event.error?.code,
          type: event.error?.type,
          ...(this.options.debug
            ? {
                providerMessage: event.error?.message,
                param: event.error?.param,
              }
            : {}),
          clientEventId,
        },
      );
      if (
        this.ready &&
        typeof clientEventId === "string" &&
        this.commandIds.delete(clientEventId)
      ) {
        if (this.contextCommands.has(clientEventId)) {
          this.fail(error);
          return;
        }
        this.diagnostic("voice.command.failed", { error }, "DEBUG");
        this.options.onError(error);
      } else this.fail(error);
    }
  }
  private contextReady() {
    if (this.closed || this.closing) return;
    const restored = this.deferredHistory.length;
    const initialContext = this.initialContext;
    this.deferredHistory = [];
    this.initialContext = "";
    if (initialContext) this.lastContext = initialContext;
    this.setPhase("listening");
    this.options.onState("listening");
    if (restored || initialContext) {
      this.diagnostic("voice.context.restored", {
        messages: restored,
        initialContext: Boolean(initialContext),
      });
      this.setMicrophone(this.microphoneWanted);
      this.setSpokenReplies(this.options.spokenReplies);
    }
  }
  private delegate(event: Record<string, any>) {
    const id = event.delegation.id;
    if (typeof id !== "string" || this.delegated.has(id) || this.closing)
      return;
    // Preserve the live dialogue so follow-ups such as “yes, add that” retain
    // their meaning. Already-delegated user fragments are context, never a new action.
    const cutoff =
      typeof event.offset_ms === "number" ? event.offset_ms : Infinity;
    const relevant = this.transcripts.filter((part) => part.end <= cutoff);
    const turns: Array<{
      role: "user" | "assistant";
      content: string;
      end: number;
    }> = [];
    for (const part of relevant) {
      const previous = turns.at(-1);
      if (
        previous?.role === part.role &&
        !(
          part.role === "user" &&
          previous.end <= this.lastDelegatedEnd &&
          part.end > this.lastDelegatedEnd
        )
      ) {
        previous.content += part.text;
        previous.end = part.end;
      } else turns.push({ role: part.role, content: part.text, end: part.end });
    }
    let currentIndex = -1;
    for (let i = turns.length - 1; i >= 0; i--)
      if (turns[i]!.role === "user" && turns[i]!.end > this.lastDelegatedEnd) {
        currentIndex = i;
        break;
      }
    if (currentIndex < 0) {
      // Data-channel events can arrive before the last transcript fragment.
      if (!this.pendingDelegations.has(id))
        this.pendingDelegations.set(id, {
          event,
          timer: setTimeout(() => {
            this.pendingDelegations.delete(id);
            this.delegated.add(id);
            this.diagnostic("voice.delegation.missing_transcript", {
              delegationId: id,
            });
            this.sendResult(
              id,
              "Ask the user to repeat the request; its transcript did not arrive.",
            );
          }, 5000),
        });
      return;
    }
    clearTimeout(this.pendingDelegations.get(id)?.timer);
    this.pendingDelegations.delete(id);
    this.delegated.add(id);
    const current = turns[currentIndex]!;
    this.lastDelegatedEnd = current.end;
    const text = current.content.trim();
    const history = turns
      .slice(0, currentIndex)
      .map(({ role, content }) => ({ role, content }));
    this.diagnostic("voice.delegation.started", {
      delegationId: id,
      offsetMs: event.offset_ms,
    });
    this.diagnostic(
      "voice.delegation.input",
      { delegationId: id, text, history },
      "DEBUG",
    );
    void this.options
      .onDelegate(text, history)
      .then((result) => {
        this.diagnostic("voice.delegation.completed", { delegationId: id });
        this.sendResult(id, result);
      })
      .catch((error) => {
        this.diagnostic(
          "voice.delegation.failed",
          { delegationId: id, error },
          "DEBUG",
        );
        this.options.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.sendResult(
          id,
          "The request did not complete. The previous application is safe. Explain the error without claiming success.",
        );
      });
  }
  private sendCommand(
    type: string,
    payload: Record<string, unknown> = {},
    restoresContext = false,
  ) {
    if (!this.ready || this.closed || this.channel?.readyState !== "open")
      return false;
    const eventId = crypto.randomUUID();
    try {
      this.commandIds.add(eventId);
      if (restoresContext) this.contextCommands.add(eventId);
      this.channel.send(
        JSON.stringify({ type, event_id: eventId, ...payload }),
      );
      this.diagnostic("voice.command", {
        type,
        eventId,
        delegationId: payload.delegation_id,
      });
      this.diagnostic(
        "voice.command.content",
        { type, eventId, ...payload },
        "DEBUG",
      );
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  private sendResult(id: string, content: string) {
    if (this.closing) return;
    for (const chunk of voiceAppendChunks(content))
      if (
        !this.sendCommand("session.commentary.append", {
          delegation_id: id,
          content: chunk,
        })
      )
        break;
  }
  updateContext(content: string) {
    if (content === this.lastContext || this.closing) return;
    for (const chunk of voiceAppendChunks(content))
      if (
        !this.sendCommand("session.thinking.append", {
          delegation_id: null,
          content: chunk,
        })
      )
        return;
    this.lastContext = content;
  }
  reportProgress(content: string, delegationId: string | null = null) {
    if (this.closing) return;
    for (const chunk of voiceAppendChunks(content))
      if (
        !this.sendCommand("session.thinking.append", {
          delegation_id: delegationId,
          content: chunk,
        })
      )
        break;
  }
  setSpokenReplies(enabled: boolean) {
    this.diagnostic("voice.playback", { enabled });
    this.options.spokenReplies = enabled;
    if (this.audio) {
      this.audio.muted = !enabled || this.restoringContext;
      if (enabled)
        void this.audio.play().catch(() => {
          if (!this.closed)
            this.options.onError(
              new LiveVoiceError(
                "Allow audio playback in your browser to hear replies.",
                this.phase,
                { code: "playback_blocked" },
              ),
            );
        });
    }
  }
  setMicrophone(enabled: boolean) {
    this.microphoneWanted = enabled;
    const effective = enabled && !this.restoringContext;
    this.media?.getAudioTracks().forEach((track) => {
      track.enabled = effective;
    });
    this.diagnostic("voice.microphone", { enabled });
    if (!this.closing && !this.restoringContext)
      this.sendCommand(
        effective ? "session.input_audio.unmute" : "session.input_audio.mute",
      );
  }
  stop() {
    if (this.closed || this.closing) return;
    this.closing = true;
    clearInterval(this.interval);
    this.setMicrophone(false);
    this.setPhase("closing");
    this.options.onState("closing");
    if (this.ready && this.channel?.readyState === "open") {
      if (!this.sendCommand("session.close")) return;
      this.closeTimer = setTimeout(
        () => this.finish(false, "completed"),
        15_000,
      );
    } else this.finish(false, "cancelled");
  }
  private fail(cause: unknown, confirmed = false) {
    if (this.closed) return;
    this.failureStage = this.phase;
    const name = cause instanceof Error ? cause.name : "";
    const message =
      name === "NotAllowedError"
        ? "Microphone permission was denied. Allow microphone access in your browser and Windows privacy settings, then try again."
        : name === "NotFoundError"
          ? "No microphone was found. Connect one, then try again."
          : name === "NotReadableError"
            ? "Your microphone is unavailable. Check whether another app is using it, then try again."
            : name === "TimeoutError"
              ? "The live conversation connection took too long. Please try again."
              : this.phase === "permission"
                ? "This browser cannot start a live conversation. Check microphone access or continue typing."
                : this.phase === "session-create"
                  ? "Live conversation could not connect. Check your connection and try again."
                  : "The live conversation connection was interrupted. Please try again.";
    const error =
      cause instanceof LiveVoiceError
        ? cause
        : new LiveVoiceError(message, this.phase, { cause });
    this.diagnostic("voice.failed", { error }, "DEBUG");
    this.diagnostic("voice.failure", {
      failureStage: this.phase,
      code: error.detail.code,
      status: error.detail.status,
      providerRequestId: error.detail.providerRequestId,
    });
    // Release the microphone before callbacks: rendering or accounting failures
    // must never prevent cleanup or leave a Windows permission indicator active.
    try {
      this.finish(confirmed, "failed");
    } finally {
      this.options.onError(error);
    }
  }
  private finish(confirmed: boolean, outcome: VoiceUsageDetails["outcome"]) {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    clearInterval(this.interval);
    clearTimeout(this.closeTimer);
    clearTimeout(this.connectTimer);
    for (const pending of this.pendingDelegations.values())
      clearTimeout(pending.timer);
    this.pendingDelegations.clear();
    this.media?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (this.channel) {
      this.channel.onmessage =
        this.channel.onclose =
        this.channel.onerror =
        this.channel.onopen =
          null;
      this.channel.close();
    }
    if (this.peer) {
      this.peer.ontrack =
        this.peer.onconnectionstatechange =
        this.peer.oniceconnectionstatechange =
        this.peer.onicegatheringstatechange =
          null;
      this.peer.close();
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    try {
      this.diagnostic("voice.resources.released");
      this.publishUsage(true, confirmed, outcome);
    } finally {
      this.setPhase("closed");
      this.options.onState("closed");
    }
  }
}
