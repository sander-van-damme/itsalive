/** Utilities for bridge correlation IDs and durable entity IDs. */

/** Creates a collision-resistant, opaque ID using the required modern crypto API. */
export function createId(prefix = "id"): string {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 24) || "id";
  return `${safePrefix}_${crypto.randomUUID()}`;
}

export const createRequestId = (): string => createId("req");

/** Deliberately conservative: IDs cross a trust boundary and are used in maps/logs. */
export function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 4 && value.length <= 160 && /^[A-Za-z0-9_-]+$/.test(value);
}
