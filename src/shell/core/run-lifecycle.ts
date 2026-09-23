export type ExternalAgentAbortKind = "user-stop" | "app-switch" | "runtime-disposed";
export type AgentTimeoutKind = "idle-timeout" | "time-budget";
export type AgentRunFailureKind = ExternalAgentAbortKind | AgentTimeoutKind | "run-error";

const REASON_PREFIX = "itsalive:";
export const AGENT_IDLE_TIMEOUT_REASON = `${REASON_PREFIX}idle-timeout`;
export const AGENT_TIME_BUDGET_REASON = `${REASON_PREFIX}time-budget`;

export interface NormalizedAgentRunFailure {
  kind: AgentRunFailureKind;
  resumable: boolean;
  userMessage?: string;
  technical: { name: string; message: string };
}

export interface PausedAgentRun {
  id: string;
  appId: string;
  trigger: string;
  pausedAt: number;
}

export function createAgentAbort(kind: ExternalAgentAbortKind): DOMException {
  return new DOMException(`${REASON_PREFIX}${kind}`, "AbortError");
}

export function createAgentTimeout(kind: AgentTimeoutKind): DOMException {
  return new DOMException(`${REASON_PREFIX}${kind}`, "TimeoutError");
}

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function markerKind(message: string): AgentRunFailureKind | undefined {
  if (!message.startsWith(REASON_PREFIX)) return undefined;
  const value = message.slice(REASON_PREFIX.length);
  if (value === "user-stop" || value === "app-switch" || value === "runtime-disposed" || value === "idle-timeout" || value === "time-budget") return value;
  return undefined;
}

export function normalizeAgentRunFailure(error: unknown, signal?: AbortSignal): NormalizedAgentRunFailure {
  const effective = signal?.aborted ? signal.reason ?? error : error;
  const technical = errorDetails(error);
  const effectiveDetails = errorDetails(effective);
  const marked = markerKind(effectiveDetails.message);

  if (marked === "user-stop") {
    return {
      kind: marked,
      resumable: false,
      userMessage: "Stopped. Changes already applied were kept.",
      technical,
    };
  }
  if (marked === "app-switch") return { kind: marked, resumable: true, technical };
  if (marked === "runtime-disposed") return { kind: marked, resumable: false, technical };
  if (marked === "idle-timeout") {
    return {
      kind: marked,
      resumable: false,
      userMessage: "The model stopped sending activity for a while, so I stopped this run. Changes already applied were kept.",
      technical,
    };
  }
  if (marked === "time-budget") {
    return {
      kind: marked,
      resumable: false,
      userMessage: "This run reached its working-time budget, so I stopped it. Changes already applied were kept.",
      technical,
    };
  }

  return {
    kind: "run-error",
    resumable: false,
    userMessage: "I hit a problem while working. Changes already applied were kept. Try again.",
    technical,
  };
}

export class PausedRunStore {
  private readonly runs = new Map<string, PausedAgentRun>();

  constructor(
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  pause(appId: string, trigger: string): PausedAgentRun {
    const run = { id: this.createId(), appId, trigger, pausedAt: this.now() };
    this.runs.set(appId, run);
    return run;
  }

  current(appId: string): PausedAgentRun | undefined { return this.runs.get(appId); }

  take(appId: string, id: string): PausedAgentRun | undefined {
    const run = this.runs.get(appId);
    if (!run || run.id !== id) return undefined;
    this.runs.delete(appId);
    return run;
  }

  restore(run: PausedAgentRun): void { this.runs.set(run.appId, run); }
  clear(appId: string): void { this.runs.delete(appId); }
}
