export const DEFAULT_MAX_TEXT_LENGTH = 32_000;
export const DEFAULT_MAX_SERIALIZED_BYTES = 128_000;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError | string;
}

export function truncateText(text: string, maximum = DEFAULT_MAX_TEXT_LENGTH): string {
  if (maximum < 0 || !Number.isFinite(maximum)) throw new RangeError("maximum must be a finite non-negative number");
  if (text.length <= maximum) return text;
  const marker = `\n… [truncated ${text.length - maximum} characters]`;
  return `${text.slice(0, Math.max(0, maximum - marker.length))}${marker}`.slice(0, maximum);
}

export function serializeError(value: unknown, maximum = 16_000): SerializedError {
  const error = value instanceof Error ? value : new Error(typeof value === "string" ? value : safeStringify(value, maximum));
  const result: SerializedError = {
    name: truncateText(error.name || "Error", 120),
    message: truncateText(error.message || String(value), maximum),
  };
  if (error.stack) result.stack = truncateText(error.stack, maximum);
  if ("cause" in error && error.cause !== undefined) {
    result.cause = error.cause instanceof Error
      ? { name: truncateText(error.cause.name, 120), message: truncateText(error.cause.message, maximum) }
      : truncateText(String(error.cause), maximum);
  }
  return result;
}

/** JSON serialization that survives cycles, BigInt, Error, DOM-ish and exotic values. */
export function safeStringify(value: unknown, maximum = DEFAULT_MAX_SERIALIZED_BYTES): string {
  const seen = new WeakSet<object>();
  let output: string;
  try {
    output = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return `${item}n`;
      if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
      if (typeof item === "symbol") return String(item);
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    }) ?? "undefined";
  } catch (error) {
    output = `[Unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return truncateText(output, maximum);
}

/** Produces data safe to pass through postMessage and bounds unexpectedly large observations. */
export function toBoundedClone(value: unknown, maximum = DEFAULT_MAX_SERIALIZED_BYTES): unknown {
  const serialized = safeStringify(value, maximum);
  try { return JSON.parse(serialized) as unknown; } catch { return serialized; }
}
