export type RunBudgetFailureKind = "generation" | "runtime" | "verification";
export type RunBudgetStopKind =
  | "cost-budget"
  | "cost-unknown"
  | "generation-failure"
  | "runtime-failure"
  | "verification-failure"
  | "stalled"
  | "emergency-ceiling";

export interface RunBudgetLimits {
  maxDurationMs: number;
  idleTimeoutMs: number;
  /** Null disables dollar enforcement but cost completeness is still tracked. */
  maxCostUsd: number | null;
  maxConsecutiveFailures: number;
  stallRepeatLimit: number;
  /** Last-resort runaway guard; this is not a normal work budget. */
  emergencyTurnCeiling: number;
}

export interface RunBudgetSnapshot {
  turns: number;
  localKnownCostUsd: number;
  localUnknownCostRequests: number;
  rootKnownCostUsd: number;
  rootUnknownCostRequests: number;
  maxCostUsd: number | null;
  rootMaxCostUsd: number | null;
  consecutiveFailures: Record<RunBudgetFailureKind, number>;
  stallRepeats: number;
  emergencyTurnCeiling: number;
}

interface SharedCostLedger {
  knownCostUsd: number;
  unknownCostRequests: number;
  maxCostUsd: number | null;
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function assertLimits(limits: RunBudgetLimits): void {
  if (!Number.isFinite(limits.maxDurationMs) || limits.maxDurationMs <= 0) throw new Error("maxDurationMs must be positive");
  if (!Number.isFinite(limits.idleTimeoutMs) || limits.idleTimeoutMs <= 0) throw new Error("idleTimeoutMs must be positive");
  if (limits.maxCostUsd !== null && (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0)) throw new Error("maxCostUsd must be null or positive");
  if (!Number.isInteger(limits.maxConsecutiveFailures) || limits.maxConsecutiveFailures < 1) throw new Error("maxConsecutiveFailures must be a positive integer");
  if (!Number.isInteger(limits.stallRepeatLimit) || limits.stallRepeatLimit < 1) throw new Error("stallRepeatLimit must be a positive integer");
  if (!Number.isInteger(limits.emergencyTurnCeiling) || limits.emergencyTurnCeiling < 1) throw new Error("emergencyTurnCeiling must be a positive integer");
}

export class RunBudgetController {
  private turns = 0;
  private localKnownCostUsd = 0;
  private localUnknownCostRequests = 0;
  private stallRepeats = 0;
  private readonly failures: Record<RunBudgetFailureKind, number> = {
    generation: 0,
    runtime: 0,
    verification: 0,
  };

  constructor(
    readonly limits: RunBudgetLimits,
    private readonly rootLedger: SharedCostLedger = {
      knownCostUsd: 0,
      unknownCostRequests: 0,
      maxCostUsd: limits.maxCostUsd,
    },
  ) {
    assertLimits(limits);
  }

  /**
   * Child controllers have their own local limits while sharing root spend.
   * This makes concurrent workers collectively consume the parent dollar cap.
   */
  fork(limits: RunBudgetLimits): RunBudgetController {
    return new RunBudgetController(limits, this.rootLedger);
  }

  startTurn(turn: number): RunBudgetStopKind | undefined {
    if (turn > this.limits.emergencyTurnCeiling) return "emergency-ceiling";
    this.turns = Math.max(this.turns, turn);
    return this.costStopReason();
  }

  recordUsage(cost: number | undefined): RunBudgetStopKind | undefined {
    if (finiteNonNegative(cost)) {
      this.localKnownCostUsd += cost;
      this.rootLedger.knownCostUsd += cost;
    } else {
      this.localUnknownCostRequests++;
      this.rootLedger.unknownCostRequests++;
    }
    return this.costStopReason();
  }

  recordFailure(kind: RunBudgetFailureKind): RunBudgetStopKind | undefined {
    this.failures[kind]++;
    if (this.failures[kind] < this.limits.maxConsecutiveFailures) return undefined;
    if (kind === "generation") return "generation-failure";
    if (kind === "runtime") return "runtime-failure";
    return "verification-failure";
  }

  recordSuccess(kind: RunBudgetFailureKind): void {
    this.failures[kind] = 0;
  }

  recordStall(): RunBudgetStopKind | undefined {
    this.stallRepeats++;
    return this.stallRepeats >= this.limits.stallRepeatLimit ? "stalled" : undefined;
  }

  clearStall(): void {
    this.stallRepeats = 0;
  }

  snapshot(): RunBudgetSnapshot {
    return {
      turns: this.turns,
      localKnownCostUsd: this.localKnownCostUsd,
      localUnknownCostRequests: this.localUnknownCostRequests,
      rootKnownCostUsd: this.rootLedger.knownCostUsd,
      rootUnknownCostRequests: this.rootLedger.unknownCostRequests,
      maxCostUsd: this.limits.maxCostUsd,
      rootMaxCostUsd: this.rootLedger.maxCostUsd,
      consecutiveFailures: { ...this.failures },
      stallRepeats: this.stallRepeats,
      emergencyTurnCeiling: this.limits.emergencyTurnCeiling,
    };
  }

  private costStopReason(): RunBudgetStopKind | undefined {
    const localLimited = this.limits.maxCostUsd !== null;
    const rootLimited = this.rootLedger.maxCostUsd !== null;
    if ((localLimited && this.localUnknownCostRequests > 0) || (rootLimited && this.rootLedger.unknownCostRequests > 0)) {
      return "cost-unknown";
    }
    if (this.limits.maxCostUsd !== null && this.localKnownCostUsd >= this.limits.maxCostUsd) return "cost-budget";
    if (this.rootLedger.maxCostUsd !== null && this.rootLedger.knownCostUsd >= this.rootLedger.maxCostUsd) return "cost-budget";
    return undefined;
  }
}

export function runBudgetMessage(kind: RunBudgetStopKind): string {
  if (kind === "cost-budget") return "I stopped because this run reached its cost budget. Changes already applied were kept.";
  if (kind === "cost-unknown") return "I stopped because a cost-limited run received usage without a reliable provider cost. Changes already applied were kept.";
  if (kind === "generation-failure") return "I stopped after repeated invalid model output. Changes already applied were kept.";
  if (kind === "runtime-failure") return "I stopped after repeated runtime failures. Changes already applied were kept.";
  if (kind === "verification-failure") return "I stopped after repeated completion checks failed. Changes already applied were kept.";
  if (kind === "stalled") return "I stopped because repeated checks were no longer changing the app. Changes already applied were kept.";
  return "I stopped at the emergency runaway guard. Changes already applied were kept.";
}
