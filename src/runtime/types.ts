export interface RuntimeOptions {
  rootOrigin: string;
  appId: string;
  port: MessagePort;
  autosaveDelay?: number;
  maxResultBytes?: number;
  screenshot?: (element: HTMLElement) => Promise<string>;
}

export interface RuntimeBootstrapContext {
  rootOrigin: string;
  appId: string;
  port: MessagePort;
}

export interface LogEntry {
  timestamp: string;
  level: "debug" | "log" | "info" | "warn" | "error";
  message: string;
  source: "app" | "agent" | "cron" | "bridge";
  stack?: string;
}
