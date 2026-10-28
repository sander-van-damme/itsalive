/** Credential redaction is separate from retention: never silently shorten user data. */
export const credentialField =
  /^(?:(?:x[-_]?)?api[-_]?key|authorization|proxy[-_]?authorization|password|(?:client[-_]?)?secrets?|private[-_]?key|csrf|code[-_]?verifier|(?:access|refresh|id|session|api|oauth)[-_]?token|token|(?:set[-_]?)?cookies?|credentials?)$/i;

export function redactCredentialText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let result = value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret)=)[^&#\s"']*/gi,
      "$1[redacted]",
    )
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]");
  for (const secret of secrets)
    if (secret.length > 3) result = result.split(secret).join("[redacted]");
  return result;
}

/** Produces JSON-compatible evidence without array, object or string length caps. */
export function redactCredentials(
  value: unknown,
  options: { secrets?: readonly string[]; omitContent?: boolean } = {},
): unknown {
  const parents = new Set<object>();
  const content =
    /^(?:prompt|instructions|messages|message|providerMessage|providerError|stack|cause|source|sourceCode|content|rawResponse|requestBody|responseBody|arguments|toolArguments|toolOutput|toolResults|visibleText|text|responseItems)$/i;
  const visit = (item: unknown, key = ""): unknown => {
    if (credentialField.test(key)) return "[redacted]";
    if (options.omitContent && content.test(key))
      return "[content not captured]";
    if (typeof item === "string")
      return redactCredentialText(item, options.secrets);
    if (typeof item === "bigint") return item.toString();
    if (!item || typeof item !== "object") return item;
    if (parents.has(item)) return "[circular reference omitted]";
    parents.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => visit(entry));
      if (item instanceof Date) return item.toISOString();
      const fields =
        item instanceof Error
          ? {
              ...item,
              name: item.name,
              message: item.message,
              stack: item.stack,
              ...(item.cause === undefined ? {} : { cause: item.cause }),
            }
          : item;
      return Object.fromEntries(
        Object.entries(fields).map(([field, entry]) => [
          field,
          visit(entry, field),
        ]),
      );
    } finally {
      parents.delete(item);
    }
  };
  return visit(value);
}
