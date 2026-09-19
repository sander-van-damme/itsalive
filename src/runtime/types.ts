export interface RuntimeOptions {
  rootOrigin: string;
  appId?: string;
  autosaveDelay?: number;
  maxResultBytes?: number;
  screenshot?: (element: HTMLElement) => Promise<string>;
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "log" | "info" | "warn" | "error";
  message: string;
  source: "app" | "agent" | "cron" | "bridge";
  stack?: string;
}
