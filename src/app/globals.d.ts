import type { appDatabaseApi } from "./db";
import type { inspectDom, ref } from "./inspect";
import type { captureScreenshot } from "./screenshot";
import type { createToolsApi } from "./tools";

declare global {
  interface Window {
    app: {
      db: typeof appDatabaseApi;
      ai: { ask<T = unknown>(prompt: unknown, settings?: unknown): Promise<T> };
      meta: { update(metadata: { name: string }): Promise<{ name: string } | undefined> };
      reload(): void;
    };
    agent: { wake(prompt: string): Promise<unknown> };
    history: { search(input: { query: string; limit?: number }): Promise<unknown> };
    tools: ReturnType<typeof createToolsApi>;
    cron(id: string, schedule: string, callback: () => unknown): { id: string; schedule: string };
    inspectDom: typeof inspectDom;
    ref: typeof ref;
    screenshot: typeof captureScreenshot;
    getLogs(input?: { level?: "log" | "info" | "warn" | "error"; limit?: number }): unknown[];
    done(message?: string): unknown;
  }
}

export {};
