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
        options.onError(
          event.error === "not-allowed"
            ? "Microphone permission was denied. You can continue typing."
            : `Speech input failed (${event.error}). You can continue typing.`,
        );
      };
      this.recognition.onend = () => {
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
      this.recognition.start();
      this.listening = true;
      this.options.onState?.(true);
    } catch (error) {
      this.options.onError(
        error instanceof Error
          ? error.message
          : "Speech input could not start.",
      );
    }
  }
  stop(): void {
    this.recognition?.stop();
    this.listening = false;
    this.options.onState?.(false);
  }
  dispose(): void {
    this.recognition?.abort();
    if (this.recognition) {
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
    }
    this.listening = false;
  }
}
