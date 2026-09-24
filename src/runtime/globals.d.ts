import type { captureScreenshot } from "./screenshot";
import type { ApplicationStore } from "./application-store";

export interface ApplicationAiApi {
  text(prompt: unknown): Promise<string>;
  choose(question: string, options: Record<string, string>, context?: unknown): Promise<string | null>;
  score(question: string, levels: string[], context?: unknown): Promise<number | null>;
  decide(question: string, context?: unknown): Promise<boolean | null>;
  probability(question: string, context?: unknown): Promise<number>;
}

export interface ApplicationRuntimeApi {
  readonly store: ApplicationStore;
  readonly ai: Readonly<ApplicationAiApi>;
  escalate(reason: string): void;
}

export interface AgentRuntimeApi {
  memory(): Promise<string>;
  screenshot: typeof captureScreenshot;
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
