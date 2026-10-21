export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface Project {
  files: Record<string, string>;
  dependencies: Record<string, string>;
  entry: string;
  lock: Record<string, { url: string; integrity: string }>;
}
export interface Revision {
  id: string;
  appId: string;
  parent: string | null;
  createdAt: number;
  message: string;
  project: Project;
}
export interface AppRecord {
  id: string;
  name: string;
  currentRevision: string;
  createdAt: number;
  state: Record<string, Json>;
}
export interface ChatMessage {
  id: string;
  appId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}
export interface Diagnostic {
  id: string;
  sessionId?: string;
  timestamp: number;
  level: "INFO" | "DEBUG";
  event: string;
  correlationId: string;
  appId?: string;
  revisionId?: string;
  data?: unknown;
}
export interface CompiledModule {
  code: string;
  hash: string;
}
export interface BuildArtifact {
  entry: string;
  modules: Record<string, CompiledModule>;
  css: string;
  revisionId: string;
  metrics: Record<string, number>;
}
export interface BuildDiagnostic {
  file?: string;
  message: string;
  line?: number;
}
export type BuildResult =
  | { ok: true; artifact: BuildArtifact; project: Project }
  | { ok: false; diagnostics: BuildDiagnostic[] };
export type RuntimeMode = "app" | "verify" | "backup";
export interface RuntimeInit {
  appId: string;
  mode: RuntimeMode;
  state: Record<string, Json>;
  observe: boolean;
}
export interface RuntimeInspection {
  text: string;
  errors: string[];
  revisionId: string | null;
}
export interface BehaviorObservation {
  target: string;
  count: number;
  durationMs: number;
  kind: "repeated-click";
}
