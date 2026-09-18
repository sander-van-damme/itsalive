import type { captureScreenshot } from "./screenshot";

export interface LlmApi {
  ask<T = unknown>(prompt: unknown): Promise<T>;
}

export interface ItsaliveRuntimeApi {
  readonly apiVersion: 2;
  readonly llm: Readonly<LlmApi>;
  readonly history: Readonly<{ search(input: { query: string; limit?: number }): Promise<unknown> }>;
  readonly agent: Readonly<{ wake(prompt: string): Promise<unknown> }>;
  readonly dom: Readonly<{
    screenshot: typeof captureScreenshot;
  }>;
  readonly logs: Readonly<{
    get(input?: { level?: "log" | "info" | "warn" | "error"; limit?: number }): unknown[];
  }>;
  readonly cron: (id: string, schedule: string, callback: () => unknown) => { id: string; schedule: string };
  readonly done: (message?: string) => unknown;
}

declare global {
  const itsalive: ItsaliveRuntimeApi;

  interface Window {
    readonly itsalive: ItsaliveRuntimeApi;
  }
}
