interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;
export interface SpeechOptions {
  onText(text: string): void;
  onError(error: string): void;
  onState?(listening: boolean): void;
  language?: string;
}
/** Browser speech may use the browser vendor's remote recognition service. Start only after an explicit microphone action. */
export class SpeechInput {
  private readonly recognition: Recognition | null;
  private listening = false;
  readonly supported: boolean;
  constructor(private readonly options: SpeechOptions) {
    const browser = globalThis as typeof globalThis & {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const Constructor =
      browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    this.supported = !!Constructor;
    this.recognition = Constructor ? new Constructor() : null;
    if (this.recognition) {
      this.recognition.lang =
        options.language ??
        (typeof navigator !== "undefined" ? navigator.language : "en");
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.onresult = (event) => {
        const pieces: string[] = [];
        for (
          let index = event.resultIndex;
          index < event.results.length;
          index++
        ) {
          const result = event.results[index];
          if (result?.isFinal && result[0]?.transcript)
            pieces.push(result[0].transcript);
        }
        if (pieces.length) options.onText(pieces.join(" "));
      };
      this.recognition.onerror = (event) => {
        this.listening = false;
        options.onState?.(false);
        if (event.error === "aborted") return;
        const messages: Record<string, string> = {
          "not-allowed":
            "Microphone permission was denied. Allow microphone access in your browser settings, then try again. You can continue typing.",
          "service-not-allowed":
            "Speech recognition is blocked by this browser. Check its permissions or continue typing.",
          "audio-capture":
            "No microphone is available. Check that it is connected and try again, or continue typing.",
          "no-speech":
            "I didn't hear any speech. Try again or type your message.",
          network:
            "Speech recognition couldn't connect. Check your connection and try again, or continue typing.",
          "language-not-supported":
            "Speech recognition doesn't support this language in your browser. You can continue typing.",
        };
        options.onError(
          messages[event.error] ??
            "Speech recognition stopped. Try again or continue typing.",
        );
      };
      this.recognition.onend = () => {
        if (!this.listening) return;
        this.listening = false;
        options.onState?.(false);
      };
    }
  }
  start(): void {
    if (!this.recognition) {
      this.options.onError(
        "Speech recognition is unavailable in this browser. Type your message instead.",
      );
      return;
    }
    if (this.listening) return;
    try {
      this.listening = true;
      this.options.onState?.(true);
      this.recognition.start();
    } catch {
      this.listening = false;
      this.options.onState?.(false);
      this.options.onError(
        "Speech input couldn't start. Check microphone permission and try again, or continue typing.",
      );
    }
  }
  stop(): void {
    try {
      this.recognition?.stop();
    } catch {
      this.options.onError(
        "Speech recognition stopped. You can try again or continue typing.",
      );
    } finally {
      this.listening = false;
      this.options.onState?.(false);
    }
  }
  dispose(): void {
    if (this.recognition) {
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      this.recognition.abort();
    }
    this.listening = false;
  }
}
