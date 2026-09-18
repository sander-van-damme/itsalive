import type { appDatabaseApi } from "./db";
import type { inspectDom, ref } from "./inspect";
import type { captureScreenshot } from "./screenshot";
import type { createToolsApi } from "./tools";

export interface LlmApi {
  ask<T = unknown>(prompt: unknown, settings?: unknown): Promise<T>;
}

export interface ItsaliveRuntimeApi {
  readonly apiVersion: 1;
  readonly db: typeof appDatabaseApi;
  readonly llm: Readonly<LlmApi>;
  readonly history: Readonly<{ search(input: { query: string; limit?: number }): Promise<unknown> }>;
  readonly tools: Readonly<ReturnType<typeof createToolsApi>>;
  readonly agent: Readonly<{ wake(prompt: string): Promise<unknown> }>;
  readonly dom: Readonly<{
    inspect: typeof inspectDom;
    ref: typeof ref;
    screenshot: typeof captureScreenshot;
  }>;
  readonly logs: Readonly<{
    get(input?: { level?: "log" | "info" | "warn" | "error"; limit?: number }): unknown[];
  }>;
  readonly cron: (id: string, schedule: string, callback: () => unknown) => { id: string; schedule: string };
  readonly reload: () => void;
  readonly done: (message?: string) => unknown;
}

declare global {
  const itsalive: ItsaliveRuntimeApi;

  interface Window {
    readonly itsalive: ItsaliveRuntimeApi;
  }
}
