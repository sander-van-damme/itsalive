const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|x-goog-api-key|password|secret|credential|access[-_]?token|refresh[-_]?token)$/i;

/** Produces console-safe diagnostic data without retaining credential-shaped fields. */
export function sanitizeDiagnostic(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b((?:api[-_ ]?key|authorization|password|secret|credential|access[-_ ]?token)\s*(?:is|:|=)\s*)[^\s,;]+/gi, '$1[redacted]');
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitizeDiagnostic(item, seen));
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    clean[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitizeDiagnostic(item, seen);
  }
  return clean;
}
