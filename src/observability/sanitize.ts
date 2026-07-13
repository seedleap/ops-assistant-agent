const MAX_TRACE_STRING = 8_000;
const SECRET_KEY_RE = /token|secret|authorization|credential|password|sql/i;

function sanitizeString(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/data:[^;,]+;base64,[A-Za-z0-9+/=]+/g, "[DATA_URL_REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[PRIVATE_KEY_REDACTED]");
  return redacted.length > MAX_TRACE_STRING
    ? `${redacted.slice(0, MAX_TRACE_STRING)}…[truncated]`
    : redacted;
}

export function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (depth >= 4) return "[nested value omitted]";

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeTraceValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      output[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : sanitizeTraceValue(item, depth + 1);
    }
    return output;
  }

  return sanitizeString(String(value));
}

export function errorMessage(error: unknown): string {
  return sanitizeString(error instanceof Error ? error.message : String(error));
}
