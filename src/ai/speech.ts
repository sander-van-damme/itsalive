export interface VoiceOptions {
  key: string;
  spokenReplies: boolean;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  onState(state: "connecting" | "listening" | "closing" | "closed"): void;
  onTranscript(role: "user" | "assistant", text: string): void;
  onDelegate(
    text: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string>;
  onUsage(seconds: number, final: boolean, confirmed: boolean): void;
  onError(error: Error): void;
}
interface Transcript {
  role: "user" | "assistant";
  text: string;
  end: number;
}
/** GPT-Live media and events only. No browser speech-recognition fallback. */
export class LiveVoice {
  private peer?: RTCPeerConnection;
  private media?: MediaStream;
  private channel?: RTCDataChannel;
  private audio?: HTMLAudioElement;
  private controller = new AbortController();
  private startedAt = 0;
  private usageSeconds = 0;
  private interval?: ReturnType<typeof setInterval>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closing = false;
  private ready = false;
  private transcripts: Transcript[] = [];
  private delegated = new Set<string>();
  private lastDelegatedEnd = -1;
  private transcriptBytes = 0;
  private creationAttempted = false;
  constructor(private readonly options: VoiceOptions) {}
  get active() {
    return !this.closed;
  }
  async start() {
    this.options.onState("connecting");
    try {
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
      const peer = new RTCPeerConnection();
      this.peer = peer;
      this.audio = new Audio();
      this.audio.autoplay = true;
      this.audio.muted = !this.options.spokenReplies;
      peer.ontrack = (event) => {
        if (this.audio) {
          this.audio.srcObject =
            event.streams[0] ?? new MediaStream([event.track]);
          void this.audio.play().catch(() => {
            if (this.options.spokenReplies)
              this.options.onError(
                new Error(
                  "Your browser paused spoken replies. Turn spoken replies off and on to resume.",
                ),
              );
          });
        }
      };
      for (const track of this.media.getAudioTracks())
        peer.addTrack(track, this.media);
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.onmessage = (event) => {
        try {
          this.acceptEvent(JSON.parse(String(event.data)));
        } catch (error) {
          this.fail(error);
        }
      };
      channel.onclose = () => {
        if (!this.closed)
          this.fail(
            new Error(
              "The voice connection ended. You can reconnect or continue typing.",
            ),
          );
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" && !this.closed)
          this.fail(
            new Error(
              "The voice connection was interrupted. Please reconnect.",
            ),
          );
      };
      await peer.setLocalDescription(await peer.createOffer());
      await this.waitForIce(peer);
      this.controller.signal.throwIfAborted();
      this.creationAttempted = true;
      this.startedAt = Date.now();
      const response = await fetch("/api/voice/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.key}`,
        },
        body: JSON.stringify({
          sdp: peer.localDescription?.sdp,
          history: this.options.history ?? [],
          spokenReplies: this.options.spokenReplies,
        }),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(30_000),
        ]),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ??
            "Live voice could not connect. Check your OpenAI API key in Settings.",
        );
      }
      const result = (await response.json()) as {
        transport?: { sdp?: string };
        session?: { id?: string };
      };
      if (!result.transport?.sdp || !result.session?.id)
        throw new Error("The voice service returned an incomplete connection.");
      this.controller.signal.throwIfAborted();
      await peer.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
      if (!this.ready)
        this.connectTimer = setTimeout(
          () =>
            this.fail(
              new Error(
                "The voice connection took too long. Please try again.",
              ),
            ),
          20_000,
        );
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
      change();
    });
  }
  acceptEvent(event: Record<string, any>) {
    if (this.closed) return;
    if (event.type === "session.started") {
      if (this.ready) return;
      this.ready = true;
      clearTimeout(this.connectTimer);
      this.options.onState("listening");
      this.interval = setInterval(() => {
        try {
          this.options.onUsage(
            Math.max(this.usageSeconds, (Date.now() - this.startedAt) / 1000),
            false,
            false,
          );
        } catch (error) {
          this.options.onError(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.stop();
        }
      }, 1000);
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
        end:
          typeof event.end_ms === "number"
            ? event.end_ms
            : Date.now() - this.startedAt,
      } as Transcript;
      this.transcripts.push(transcript);
      this.transcriptBytes += event.delta.length;
      while (this.transcriptBytes > 24000 && this.transcripts.length > 1)
        this.transcriptBytes -= this.transcripts.shift()!.text.length;
      this.options.onTranscript(role, event.delta);
    } else if (
      event.type === "session.delegation.created" &&
      event.delegation?.target === "client"
    ) {
      const id = event.delegation.id;
      if (typeof id !== "string" || this.delegated.has(id) || this.closing)
        return;
      this.delegated.add(id);
      if (this.delegated.size > 100) {
        this.fail(
          new Error(
            "This voice session has completed many tasks. Start a new conversation to continue.",
          ),
        );
        return;
      }
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
        } else
          turns.push({ role: part.role, content: part.text, end: part.end });
      }
      let currentIndex = -1;
      for (let i = turns.length - 1; i >= 0; i--)
        if (
          turns[i]!.role === "user" &&
          turns[i]!.end > this.lastDelegatedEnd
        ) {
          currentIndex = i;
          break;
        }
      if (currentIndex < 0) {
        this.sendResult(
          id,
          "Please ask the user to repeat the request; the transcript has not arrived.",
        );
        return;
      }
      const current = turns[currentIndex]!;
      this.lastDelegatedEnd = current.end;
      const text = current.content.trim();
      const history = turns
        .slice(0, currentIndex)
        .slice(-8)
        .map(({ role, content }) => ({ role, content: content.slice(-3000) }));
      void this.options
        .onDelegate(text, history)
        .then((result) => this.sendResult(id, result))
        .catch((error) => {
          this.options.onError(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.sendResult(
            id,
            "The request did not complete. The previous application is safe. Explain the error without claiming success.",
          );
        });
    } else if (event.type === "session.usage") {
      if (typeof event.usage?.seconds === "number")
        this.usageSeconds = event.usage.seconds;
    } else if (event.type === "session.closed") {
      const confirmed = typeof event.usage?.seconds === "number";
      this.finish(
        confirmed
          ? event.usage.seconds
          : Math.max(this.usageSeconds, (Date.now() - this.startedAt) / 1000),
        confirmed,
      );
    } else if (event.type === "error") {
      this.fail(
        new Error(
          "Live voice encountered a problem. Please reconnect; your application is safe.",
        ),
      );
    }
  }
  private sendResult(id: string, content: string) {
    if (this.ready && !this.closing && this.channel?.readyState === "open")
      this.channel.send(
        JSON.stringify({
          type: "session.commentary.append",
          event_id: crypto.randomUUID(),
          delegation_id: id,
          content: content.slice(0, 12000),
        }),
      );
  }
  setSpokenReplies(enabled: boolean) {
    this.options.spokenReplies = enabled;
    if (this.audio) {
      this.audio.muted = !enabled;
      if (enabled)
        void this.audio
          .play()
          .catch(() =>
            this.options.onError(
              new Error(
                "Allow audio playback in your browser to hear replies.",
              ),
            ),
          );
    }
  }
  setMicrophone(enabled: boolean) {
    this.media?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }
  stop() {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.setMicrophone(false);
    this.options.onState("closing");
    if (this.ready && this.channel?.readyState === "open") {
      this.channel.send(
        JSON.stringify({
          type: "session.close",
          event_id: crypto.randomUUID(),
        }),
      );
      this.closeTimer = setTimeout(
        () =>
          this.finish(
            Math.max(this.usageSeconds, (Date.now() - this.startedAt) / 1000),
            false,
          ),
        15_000,
      );
    } else
      this.finish(
        this.creationAttempted
          ? Math.max(15, (Date.now() - this.startedAt) / 1000)
          : 0,
        false,
      );
  }
  private fail(error: unknown) {
    if (error instanceof DOMException && error.name === "NotAllowedError")
      error = new Error(
        "Microphone permission was denied. Allow microphone access or continue typing.",
      );
    this.options.onError(
      error instanceof Error ? error : new Error(String(error)),
    );
    this.finish(
      this.creationAttempted
        ? Math.max(this.usageSeconds, 15, (Date.now() - this.startedAt) / 1000)
        : 0,
      false,
    );
  }
  private finish(seconds: number, confirmed: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    clearInterval(this.interval);
    clearTimeout(this.closeTimer);
    clearTimeout(this.connectTimer);
    this.media?.getTracks().forEach((track) => track.stop());
    this.channel?.close();
    this.peer?.close();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    try {
      this.options.onUsage(seconds, true, confirmed);
    } finally {
      this.options.onState("closed");
    }
  }
}
