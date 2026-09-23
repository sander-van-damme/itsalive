import type {
  FailureAssessmentDecision,
  FailureAssessmentPhase,
  RunOptions,
  RunResult,
} from "./agent-runner";
import { sanitizeDiagnostic } from "./diagnostics";
import type { RunBudgetController } from "./run-budget";

function boundText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : normalized.slice(0, Math.max(0, max - 16)) + " …[truncated]";
}

export async function assessFailureRoute(
  options: RunOptions,
  phase: FailureAssessmentPhase,
  evidence: string,
  turn: number,
  budget: RunBudgetController,
  signal: AbortSignal,
): Promise<FailureAssessmentDecision | undefined> {
  if (!options.failureAssessor) return undefined;
  const snapshot = budget.snapshot();
  const attempt = snapshot.consecutiveFailures[phase];
  const correlationId = [
    options.trace?.runId ?? options.appId,
    "failure",
    String(turn),
    phase,
    String(attempt),
  ].join(":");

  try {
    const decision = await options.failureAssessor({
      correlationId,
      requestedOutcome: boundText(options.trigger, 4_000),
      phase,
      failureEvidence: boundText(evidence, 3_000),
      ...(options.scopeSelector ? { scopeSelector: options.scopeSelector } : {}),
      attempt,
      maxAttempts: budget.limits.maxConsecutiveFailures,
    }, signal);
    console.info("Failure route decision", sanitizeDiagnostic({
      correlationId,
      phase,
      turn,
      action: decision.action,
      reason: decision.reason,
      failureClass: decision.failureClass,
    }));
    return decision;
  } catch (error) {
    console.warn(
      "Failure assessor unavailable; preserving existing repair behavior",
      sanitizeDiagnostic(error instanceof Error ? { name: error.name, message: error.message } : error),
    );
    return { action: "uncertain", reason: "assessor-unavailable-existing-repair-fallback" };
  }
}

export function failureRouteStopResult(
  decision: FailureAssessmentDecision,
  turn: number,
): RunResult | undefined {
  if (decision.action === "clarify") {
    return {
      status: "clarification-needed",
      message: "I need clarification before I continue. Please tell me what should happen in this failing case. Changes already applied were kept.",
      turns: turn,
    };
  }
  if (decision.action === "stop") {
    return {
      status: "failure-stop",
      message: decision.failureClass === "environment"
        ? "I stopped because this looks like a platform or runtime-environment failure rather than generated app code. Changes already applied were kept."
        : "I stopped because another autonomous repair attempt is unlikely to help. Changes already applied were kept.",
      turns: turn,
    };
  }
  return undefined;
}

export function appendFailureRoute(
  observation: string,
  decision: FailureAssessmentDecision,
): string {
  const diagnostic = {
    action: decision.action,
    reason: decision.reason,
    ...(decision.failureClass ? { failureClass: decision.failureClass } : {}),
  };
  return observation + "\n\nPlatform failure route: " + JSON.stringify(diagnostic);
}
