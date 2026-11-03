const clean = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
        .replace(
          /(?:Bearer\s+\S+|0x[a-f\d]{64}|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi,
          "[redacted]",
        )
        .slice(0, 500)
    : undefined;

/** Keep actionable provider fields, never raw responses, headers, credentials or payment payloads. */
export function linkedInError(error: unknown) {
  const e = error as {
    message?: string;
    name?: string;
    responseBody?: string;
    code?: string;
    reason?: string;
    requestId?: string;
    jobId?: string;
    jobError?: string;
    statusCode?: number;
    partialResult?: unknown;
  };
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(e.responseBody ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    /* Non-JSON responses are intentionally omitted. */
  }
  const nested =
    body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
  const detail = clean(nested.message ?? body.message ?? body.detail ?? body.error);
  const message = clean(e.message) ?? "LinkedIn request failed";
  return {
    message: detail && !message.includes(detail) ? `${message}: ${detail}` : message,
    name: e.name ?? "Error",
    code: clean(e.code ?? e.reason ?? nested.code ?? body.code),
    requestId: clean(e.requestId ?? e.jobId ?? body.request_id),
    statusCode: e.statusCode,
    // An async job's failure text; linkedInMessageDeferral reads not_connected /
    // rate_limited out of it when no code is set, so it must survive transport.
    ...(clean(e.jobError) !== undefined ? { jobError: clean(e.jobError) } : {}),
    // A failed job's partial result: a refused invite names its invitation here.
    ...(partialOf(e.partialResult) ? { partialResult: partialOf(e.partialResult) } : {}),
  };
}

/** The string, number and boolean fields of a failed job's partial result, cleaned. */
function partialOf(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (typeof v === "string") out[key] = clean(v)!;
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
