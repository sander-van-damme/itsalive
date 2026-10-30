import { redactCredentials } from "../shared/redaction";

/** Ordinary failures expose only accounting and known codes. Debug requests may
 * retain diagnostic provider fields, with credentials removed in both modes. */
export function safeProviderFailure(
  value: unknown,
  options: { includeContent?: boolean; secrets?: readonly string[] } = {},
): Record<string, unknown> {
  const object = (candidate: unknown): Record<string, any> =>
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
      ? (candidate as Record<string, any>)
      : {};
  const body = object(value);
  const error = object(body.error);
  const allowed = [
    "context_length_exceeded",
    "context_window_exceeded",
    "too_many_tokens",
    "max_output_tokens",
    "rate_limit_exceeded",
    "insufficient_quota",
    "usage_limit_reached",
    "usage_limit_exceeded",
    "usage_unavailable",
    "model_not_found",
    "invalid_api_key",
    "invalid_request_error",
    "server_error",
    "unsupported_parameter",
    "invalid_value",
    "content_filter",
  ];
  const metadata: Record<string, unknown> = {
    error: { ...(allowed.includes(error.code) ? { code: error.code } : {}) },
  };
  if (options.includeContent)
    metadata.diagnostics = {
      providerError: redactCredentials(
        {
          ...(typeof body.error === "string" ? { message: body.error } : {}),
          ...Object.fromEntries(
            ["code", "type", "message", "param"]
              .filter(
                (key) => typeof error[key] === "string" || error[key] === null,
              )
              .map((key) => [key, error[key]]),
          ),
        },
        { secrets: options.secrets },
      ),
    };
  const usage = object(body.usage);
  const details = object(usage.input_tokens_details);
  const count = (candidate: unknown) =>
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0;
  if (
    count(usage.input_tokens) &&
    count(usage.output_tokens) &&
    (details.cached_tokens === undefined || count(details.cached_tokens)) &&
    (details.cache_write_tokens === undefined ||
      count(details.cache_write_tokens)) &&
    (details.cached_tokens ?? 0) + (details.cache_write_tokens ?? 0) <=
      usage.input_tokens
  ) {
    metadata.usage = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      input_tokens_details: {
        cached_tokens: details.cached_tokens ?? 0,
        cache_write_tokens: details.cache_write_tokens ?? 0,
      },
    };
  }
  return metadata;
}
