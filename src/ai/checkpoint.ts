import type { Project } from "../shared/types";
import type { AIMessage, AIRole, ToolCall } from "./types";

/** Private shell data. Drafts are never executable revisions or diagnostic exports. */
export interface CodingCheckpoint {
  version: 1;
  id: string;
  appId: string;
  baseRevisionId: string;
  intent: string;
  originalRequest: string;
  role: Extract<AIRole, `coding-${string}`>;
  correlationId: string;
  createdAt: number;
  updatedAt: number;
  project: Project;
  changedFiles: string[];
  messages: AIMessage[];
  archivedContexts?: AIMessage[][];
  receipts?: Record<
    string,
    { name: string; arguments: string; output: string; ok: boolean }
  >;
  turns: number;
  toolCalls: number;
  /** Response and each completed result are saved together with the candidate. */
  pending?: { calls: ToolCall[]; next: number; incomplete: boolean };
  finishRequested: boolean;
  summary: string;
  status: "working" | "paused";
  lastFailure?: { kind: string; reason?: string };
}
