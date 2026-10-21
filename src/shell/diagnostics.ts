import type { Diagnostic } from "../shared/types";
import type { Repository } from "../storage/repository";
const sensitive =
  /^(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|token|cookie|credentials?)$/i;
export function redact(value: unknown, key = "", depth = 0): unknown {
  if (sensitive.test(key)) return "[redacted]";
  if (depth > 6) return "[depth limit]";
  if (typeof value === "string")
    return value
      .replace(/\b(?:sk-[\w-]+|Bearer\s+[\w.\/-]+)/gi, "[redacted]")
      .slice(0, 8000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((v) => redact(v, "", depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [k, redact(v, k, depth + 1)]),
    );
  return value;
}
export class Diagnostics {
  debug = false;
  readonly sessionId = crypto.randomUUID();
  constructor(private repo: Repository) {}
  async record(
    event: string,
    data?: unknown,
    context: Partial<
      Pick<Diagnostic, "appId" | "revisionId" | "correlationId">
    > = {},
    level: "INFO" | "DEBUG" = "INFO",
  ) {
    if (level === "DEBUG" && !this.debug) return;
    await this.repo.appendDiagnostic({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      level,
      event,
      correlationId: context.correlationId ?? crypto.randomUUID(),
      ...context,
      data: redact(data),
    });
  }
}
