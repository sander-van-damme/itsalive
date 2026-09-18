export type BridgeRequestType = "execute" | "ready" | "metadata" | "reload";

export interface BridgeEnvelope<T = unknown> {
  type: string;
  id?: string;
  appId?: string;
  payload?: T;
  code?: string;
}

export interface RuntimeOptions {
  rootOrigin: string;
  appId?: string;
  autosaveDelay?: number;
  maxResultBytes?: number;
  screenshot?: (element: HTMLElement) => Promise<string>;
}

export interface LogEntry {
  timestamp: string;
  level: "log" | "info" | "warn" | "error";
  message: string;
  source: "app" | "agent" | "tool" | "cron" | "bridge";
  stack?: string;
}

export interface ToolRecord {
  name: string;
  description: string;
  parameters?: unknown;
  code: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronRegistration {
  id: string;
  schedule: string;
}
