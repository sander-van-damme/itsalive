/** Serializable failure evidence. Credential redaction happens in the shell logger. */
export interface FailureEvidence {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  detail?: Record<string, unknown>;
  cause?: FailureEvidence;
}

/** Error details come from generated applications and can contain values that
 * MessagePort or the persisted JSON transcript cannot carry directly. */
function serializableDetail(detail: object): Record<string, unknown> {
  const seen = new WeakSet<object>();
  try {
    const result: unknown = JSON.parse(
      JSON.stringify(detail, (_key, value: unknown) => {
        if (typeof value === "bigint") return `${value}n`;
        if (typeof value === "function")
          return `[Function ${value.name || "anonymous"}]`;
        if (typeof value === "symbol") return String(value);
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[Circular or repeated reference]";
          seen.add(value);
        }
        return value;
      }),
    );
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { value: result };
  } catch (error) {
    return {
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
}

export function failureEvidence(
  error: unknown,
  seen = new Set<object>(),
): FailureEvidence {
  if (!error || typeof error !== "object")
    return { name: "Error", message: String(error) };
  if (seen.has(error))
    return { name: "Error", message: "Circular error cause" };
  // Match the transport validator so a pathological cause chain still produces
  // a useful failure response rather than being discarded and timing out.
  if (seen.size >= 31)
    return { name: "Error", message: "Further nested error causes omitted" };
  seen.add(error);
  const value = error as Error & {
    code?: unknown;
    detail?: unknown;
    cause?: unknown;
    remoteStack?: string;
  };
  return {
    name: typeof value.name === "string" ? value.name : "Error",
    message: typeof value.message === "string" ? value.message : String(error),
    ...(typeof value.remoteStack === "string" || typeof value.stack === "string"
      ? { stack: value.remoteStack ?? value.stack }
      : {}),
    ...(typeof value.code === "string" || typeof value.code === "number"
      ? { code: value.code }
      : {}),
    ...(value.detail &&
    typeof value.detail === "object" &&
    !Array.isArray(value.detail)
      ? { detail: serializableDetail(value.detail) }
      : {}),
    ...(value.cause !== undefined
      ? { cause: failureEvidence(value.cause, seen) }
      : {}),
  };
}

export function remoteError(evidence: FailureEvidence): Error {
  const error = new Error(evidence.message, {
    ...(evidence.cause ? { cause: remoteError(evidence.cause) } : {}),
  });
  error.name = evidence.name;
  return Object.assign(error, {
    remoteStack: evidence.stack,
    ...(evidence.code !== undefined ? { code: evidence.code } : {}),
    ...(evidence.detail ? { detail: evidence.detail } : {}),
  });
}
