const clean = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
        .replace(
          /(?:Bearer\s+\S+|0x[a-f\d]{64}|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi,
          "[redacted]",
        )
        .slice(0, 500)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Keep actionable provider fields, never raw responses, headers, credentials or payment payloads. */
export function linkedInError(error: unknown) {
  const e = error as {
    message?: string;
    name?: string;
    responseBody?: string;
    code?: string;
    reason?: string;
    upstreamReason?: string;
    upstream_reason?: string;
    requestId?: string;
    jobId?: string;
    jobError?: string;
    statusCode?: number;
    partialResult?: unknown;
  };
  let body: Record<string, unknown> = {};
  try {
    body = record(JSON.parse(e.responseBody ?? "{}"));
  } catch {
    /* Non-JSON responses are intentionally omitted. */
  }
  const nested = record(body.error);
  // A 409 `duplicate_request` puts the original request in `details`.
  const details = record(body.details);
  const partial = record(e.partialResult);
  const detail = clean(nested.message ?? body.message ?? body.detail ?? body.error);
  const message = clean(e.message) ?? "LinkedIn request failed";
  // Every failed LinkedIn job names why (`reason`) and what LinkedIn's
  // provider said (`upstream_reason`): kept apart from the code, and shown.
  const reason = clean(
    text(e.reason) ?? text(partial.reason) ?? text(nested.reason) ?? text(body.reason),
  );
  const upstreamReason = clean(
    text(e.upstreamReason) ??
      text(e.upstream_reason) ??
      text(partial.upstream_reason) ??
      text(nested.upstream_reason) ??
      text(body.upstream_reason),
  );
  const withDetail = detail && !message.includes(detail) ? `${message}: ${detail}` : message;
  // A payment refusal's `reason` is its code alone; a job's is shown.
  const why =
    e.name === "JobError" || upstreamReason
      ? [reason, upstreamReason].filter((v): v is string => !!v && !withDetail.includes(v))
      : [];
  return {
    message: why.length > 0 ? `${withDetail} (${why.join(": ")})` : withDetail,
    name: e.name ?? "Error",
    code: clean(e.code ?? e.reason ?? nested.code ?? body.code ?? text(body.error)),
    requestId: clean(e.requestId ?? e.jobId ?? body.request_id ?? details.request_id),
    statusCode: e.statusCode,
    ...(reason !== undefined ? { reason } : {}),
    ...(upstreamReason !== undefined ? { upstreamReason } : {}),
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
