/**
 * Everything GTM assumes about OneShot's `linkedin/message` (a first message to
 * a connection with no conversation). It has only been exercised against a mock
 * upstream, so a difference found on the first real send is fixed here.
 */

/** The conversation a sent message went into. Optional in the SDK's result: null when absent. */
export function linkedInMessageConversationId(result: unknown): string | null {
  const id = (result as { conversation_id?: unknown } | null)?.conversation_id;
  return typeof id === "string" && id.trim() ? id : null;
}

export type LinkedInMessageDeferral = "not_connected" | "rate_limited";

/**
 * A failed send carries an error code. `not_connected` (invite them first) and
 * `rate_limited` mean "try again later", not "give up". Null for any other error.
 */
export function linkedInMessageDeferral(err: unknown): LinkedInMessageDeferral | null {
  const e = err as { code?: unknown; reason?: unknown; jobError?: unknown } | null;
  for (const field of [e?.code, e?.reason]) {
    if (field === "not_connected" || field === "rate_limited") return field;
  }
  const jobError = typeof e?.jobError === "string" ? e.jobError : "";
  const m = /\b(not_connected|rate_limited)\b/.exec(jobError);
  return m ? (m[1] as LinkedInMessageDeferral) : null;
}
