import type { captureScreenshot } from "./screenshot";
import type { ApplicationStore, JsonValue } from "./application-store";

export interface ApplicationAiApi {
  text(prompt: string): Promise<string>;
  choose<T extends string>(question: string, options: Record<T, string>, context?: JsonValue): Promise<T | null>;
  score(question: string, levels: string[], context?: JsonValue): Promise<number | null>;
  decide(question: string, context?: JsonValue): Promise<boolean | null>;
  probability(question: string, context?: JsonValue): Promise<number>;
}

export interface ApplicationRuntimeApi {
  readonly store: ApplicationStore;
  readonly ai: Readonly<ApplicationAiApi>;
  escalate(reason: string): void;
}

export interface AgentRuntimeApi {
  memory(): Promise<string>;
  screenshot: typeof captureScreenshot;
  verify<T>(work: () => T | Promise<T>): Promise<T>;
  done(message?: string): unknown;
}

declare global {
  const application: ApplicationRuntimeApi;
  const agent: AgentRuntimeApi;

  interface Window {
    readonly application: ApplicationRuntimeApi;
    readonly agent: AgentRuntimeApi;
  }
}
