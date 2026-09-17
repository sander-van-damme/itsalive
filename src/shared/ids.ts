/** Utilities for bridge correlation IDs and durable entity IDs. */

let fallbackSequence = 0;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto?.getRandomValues?.(buffer);
  if (!buffer.some(Boolean)) {
    // This is only a compatibility fallback for unusual/non-browser test hosts.
    for (let index = 0; index < bytes; index += 1) {
      buffer[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buffer, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Creates a collision-resistant, opaque ID safe for logs and IndexedDB keys. */
export function createId(prefix = "id"): string {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 24) || "id";
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${safePrefix}_${globalThis.crypto.randomUUID()}`;
  }
  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${safePrefix}_${Date.now().toString(36)}_${fallbackSequence.toString(36)}_${randomHex(12)}`;
}

export const createRequestId = (): string => createId("req");
export const createMessageId = (): string => createId("msg");

/** Deliberately conservative: IDs cross a trust boundary and are used in maps/logs. */
export function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 4 && value.length <= 160 && /^[A-Za-z0-9_-]+$/.test(value);
}
