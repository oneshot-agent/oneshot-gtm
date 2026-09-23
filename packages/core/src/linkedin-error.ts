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
    statusCode?: number;
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
  };
}
