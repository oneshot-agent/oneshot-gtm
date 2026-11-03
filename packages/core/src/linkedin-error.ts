const clean = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
        .replace(
          /(?:Bearer\s+\S+|0x[a-f\d]{64}|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi,
          "[redacted]",
        )
        .slice(0, 500)
    : undefined;

/** What a failure code looks like: `rate_limited`, never a sentence. */
const CODE = /^[a-z][a-z0-9_]{1,63}$/;

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
  // A failed LinkedIn job carries its code in `code`, one sentence in
  // `partialResult.reason` (also its `jobError`), and the provider's error
  // type in `partialResult.upstream_reason`: kept apart, and shown.
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
  // An error's own `reason` stands in for a missing code only when it is one
  // (a payment refusal's); a sentence never becomes a code.
  const code = clean(
    e.code ??
      (CODE.test(e.reason ?? "") ? e.reason : undefined) ??
      nested.code ??
      body.code ??
      text(body.error),
  );
  let shown = detail && !message.includes(detail) ? `${message}: ${detail}` : message;
  // A payment refusal's `reason` is its code alone; a job's is shown.
  if (e.name === "JobError" || upstreamReason) {
    if (reason && reason !== code && !shown.includes(reason)) shown = `${shown}: ${reason}`;
    const tags = [code, upstreamReason].filter((v): v is string => !!v && !shown.includes(v));
    if (tags.length > 0) shown = `${shown} (${tags.join(": ")})`;
  }
  return {
    message: shown,
    name: e.name ?? "Error",
    code,
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

/** A LinkedIn failure, read the way GTM decides on it. */
export interface LinkedInFailure {
  /** OneShot's failure code. An older answer with no code: its `jobError`, when that is a code. */
  code: string | null;
  /** The one sentence a failed job carries (`partialResult.reason`). */
  reason: string | null;
  /** The provider's error type (`partialResult.upstream_reason`), when it gave one. */
  upstream: string | null;
}

/**
 * The code, sentence and provider error type of a failed LinkedIn call, raw
 * from the SDK or carried across the worker. The code is `code`; a failed
 * job's `jobError` is a sentence now, read as a code only from an older
 * answer that has no code and whose `jobError` is one.
 */
export function linkedInFailure(err: unknown): LinkedInFailure {
  const e = (err ?? {}) as {
    code?: unknown;
    reason?: unknown;
    upstreamReason?: unknown;
    jobError?: unknown;
    partialResult?: unknown;
  };
  const partial = record(e.partialResult);
  const code =
    text(e.code) ?? (typeof e.jobError === "string" && CODE.test(e.jobError) ? e.jobError : null);
  const sentence = (v: unknown) => (text(v) && v !== code ? (v as string) : undefined);
  return {
    code,
    reason: sentence(partial.reason) ?? sentence(e.reason) ?? sentence(e.jobError) ?? null,
    upstream: text(partial.upstream_reason) ?? text(e.upstreamReason) ?? null,
  };
}
