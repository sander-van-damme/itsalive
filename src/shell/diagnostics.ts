import type { Diagnostic } from "../shared/types";
import type { Repository } from "../storage/repository";
const sensitive =
  /^(?:(?:x[-_]?)?api[-_]?key|authorization|proxy[-_]?authorization|password|(?:client[-_]?)?secret|private[-_]?key|csrf|(?:access|refresh|id|session|api|oauth)[-_]?token|token|(?:set[-_]?)?cookies?|credentials?|headers)$/i;
// Logs describe execution, never the application's source, prompts, tool arguments
// or rendered user content. This applies to DEBUG as well as default diagnostics.
const privateContent =
  /^(?:prompt|messages|source|sourceCode|content|rawResponse|requestBody|responseBody|arguments|toolArguments|visibleText|text)$/i;
export function redact(value: unknown, key = "", depth = 0): unknown {
  if (sensitive.test(key) || privateContent.test(key)) return "[redacted]";
  if (depth > 6) return "[depth limit]";
  if (typeof value === "string")
    return value
      .replace(/\b(?:sk-[\w-]+|Bearer\s+[\w.\/-]+)/gi, "[redacted]")
      .replace(
        /([?&](?:api[-_]?key|access[-_]?token|token|secret)=)[^&#\s]*/gi,
        "$1[redacted]",
      )
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]")
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
    // Runtime errors and revision messages can contain private user state or
    // source excerpts. Export outcomes, not arbitrary generated-app content.
    if (event.startsWith("runtime.")) {
      const payload =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      data = {
        kind: ["runtime.error", "runtime.rejection", "console.error"].includes(
          String(payload.event),
        )
          ? payload.event
          : "runtime.error",
        errorCount: Array.isArray(payload.errors) ? payload.errors.length : 1,
      };
    } else if (
      event === "revision.applied" &&
      data &&
      typeof data === "object"
    ) {
      const {
        message: _message,
        files,
        ...metadata
      } = data as Record<string, unknown>;
      data = {
        ...metadata,
        fileCount: Array.isArray(files) ? files.length : undefined,
      };
    } else if (event === "app.created") {
      data = { created: true };
    } else if (
      ["operation.failed", "coding.failed", "revision.failed"].includes(
        event,
      ) &&
      data &&
      typeof data === "object"
    ) {
      const { message, ...metadata } = data as Record<string, unknown>;
      const errorClass =
        /^(?:Error|TypeError|RangeError|SyntaxError|DOMException|AIError)(?=:)/.exec(
          String(message),
        )?.[0] ?? "Error";
      data = { ...metadata, errorClass };
    }
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
