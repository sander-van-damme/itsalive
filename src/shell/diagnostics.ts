import type { Diagnostic } from "../shared/types";
import type { Repository } from "../storage/repository";
import { redactCredentials } from "../shared/redaction";

/** Default exports omit user content; the explicit debug switch includes it. */
export function redact(
  value: unknown,
  _key = "",
  _depth = 0,
  captureContent = false,
): unknown {
  return redactCredentials(value, { omitContent: !captureContent });
}

function metadataOnly(event: string, data: unknown): unknown {
  const payload =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (event.startsWith("runtime."))
    return {
      kind: payload.event ?? event,
      errorCount: Array.isArray(payload.errors) ? payload.errors.length : 1,
    };
  if (event === "revision.applied") {
    const { message: _message, files, ...metadata } = payload;
    return {
      ...metadata,
      fileCount: Array.isArray(files) ? files.length : undefined,
    };
  }
  if (event === "app.created") return { created: true };
  if (
    [
      "operation.failed",
      "coding.failed",
      "coding.cancelled",
      "revision.failed",
    ].includes(event)
  ) {
    const {
      message,
      error,
      stack: _stack,
      cause: _cause,
      ...metadata
    } = payload;
    const detail = error ?? message;
    const errorClass =
      detail &&
      typeof detail === "object" &&
      "name" in detail &&
      typeof detail.name === "string"
        ? detail.name
        : (/^(?:Error|TypeError|RangeError|SyntaxError|DOMException|AIError)(?=:)/.exec(
            String(detail),
          )?.[0] ?? "Error");
    return { ...metadata, errorClass };
  }
  return data;
}

export class Diagnostics {
  debug = false;
  readonly sessionId = crypto.randomUUID();
  private writes: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private failedWrites = 0;
  private lastPersistenceFailure: unknown;
  private recorded = 0;
  constructor(
    private repo: Repository,
    public sanitizeDiagnostic?: (value: unknown) => unknown,
  ) {}

  record(
    event: string,
    data?: unknown,
    context: Partial<
      Pick<Diagnostic, "appId" | "revisionId" | "correlationId">
    > = {},
    level: "INFO" | "DEBUG" = "INFO",
  ): Promise<void> {
    if (level === "DEBUG" && !this.debug) return Promise.resolve();
    if (this.sanitizeDiagnostic) {
      try {
        data = this.sanitizeDiagnostic(data);
      } catch {
        // A failing credential boundary must never fall back to raw content.
        data = { contentOmitted: "Credential sanitization failed" };
      }
    }
    const captureContent = this.debug;
    const payload =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const cancelled =
      event.includes("cancelled") ||
      (data &&
        typeof data === "object" &&
        "kind" in data &&
        data.kind === "cancelled");
    const record: Diagnostic & {
      captureMode: string;
      severity: string;
      sequence: number;
    } = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      timestamp: Date.now(),
      sequence: this.recorded + 1,
      level,
      event,
      captureMode: captureContent ? "debug-with-content" : "metadata-only",
      severity: cancelled
        ? "info"
        : /(?:failed|failure|error)(?:\.|$)/.test(event) ||
            (event === "runtime.diagnostic" &&
              (/(?:failed|failure|error)(?:\.|$)/.test(String(payload.event)) ||
                (Array.isArray(payload.errors) && payload.errors.length > 0)))
          ? "error"
          : level === "DEBUG"
            ? "debug"
            : "info",
      appId: context.appId,
      revisionId: context.revisionId,
      correlationId: context.correlationId ?? crypto.randomUUID(),
      data: redact(
        captureContent ? data : metadataOnly(event, data),
        "",
        0,
        captureContent,
      ),
    };
    this.pendingWrites++;
    this.recorded++;
    // Track every write, including callers that intentionally do not await logging.
    // A storage failure must remain visible in the next export without breaking AI work.
    this.writes = this.writes
      .then(() => this.repo.appendDiagnostic(record))
      .catch((error: unknown) => {
        this.failedWrites++;
        this.lastPersistenceFailure = redactCredentials(error);
      })
      .finally(() => {
        this.pendingWrites--;
      });
    return this.writes;
  }

  async flush(): Promise<void> {
    const through = this.writes;
    await through;
  }

  async snapshot() {
    const requestedAt = Date.now();
    const queuedThrough = this.recorded;
    await this.flush();
    const persisted = await this.repo.diagnosticSnapshot();
    return {
      ...persisted,
      metadata: {
        schemaVersion: 4,
        requestedAt,
        capturedAt: persisted.capturedAt,
        browserSessionId: this.sessionId,
        debugEnabled: this.debug,
        contentCapture: this.debug
          ? "full-request-response-tool-evidence"
          : "metadata-only",
        credentialsRedacted: true,
        redactionPolicyVersion: 2,
        retainedContentModes: [
          ...new Set(
            persisted.diagnostics.map(
              (record) =>
                (record as Diagnostic & { captureMode?: string }).captureMode ??
                "legacy-unspecified",
            ),
          ),
        ],
        // Earlier collectors silently clipped content, so do not certify legacy rows.
        contentTruncated: persisted.diagnostics.some(
          (record) => !("captureMode" in record),
        )
          ? null
          : false,
        contentTruncationScope:
          "No per-field or array caps in current records; legacy content completeness is unknown.",
        omittedContentCategories: this.debug
          ? []
          : [
              "prompts",
              "model-output",
              "tool-content",
              "source",
              "rendered-content",
            ],
        retention: persisted.retention,
        retainedEvents: persisted.diagnostics.length,
        oldestRetainedAt: persisted.diagnostics.at(0)?.timestamp ?? null,
        newestRetainedAt: persisted.diagnostics.at(-1)?.timestamp ?? null,
        queuedWritesThrough: queuedThrough,
        pendingWrites: this.pendingWrites,
        failedWrites: this.failedWrites,
        ...(this.lastPersistenceFailure === undefined
          ? {}
          : { lastPersistenceFailure: this.lastPersistenceFailure }),
        severityConvention:
          "Each new record declares severity separately from logging level. Older records may lack it.",
      },
    };
  }
}
