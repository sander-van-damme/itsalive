import type { captureScreenshot } from "./screenshot";
import type { ApplicationStore } from "./application-store";

export interface ApplicationRuntimeApi {
  readonly store: ApplicationStore;
  generate<T = unknown>(prompt: unknown): Promise<T>;
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
