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

const deferralOf = (code: string): LinkedInMessageDeferral | null =>
  code === "not_connected" || code === "recipient_not_connected"
    ? "not_connected"
    : code === "rate_limited"
      ? "rate_limited"
      : null;

/**
 * A failed send carries an error code. `not_connected` (invite them first) and
 * `rate_limited` mean "try again later", not "give up". Null for any other error.
 * OneShot is renaming message's `not_connected` to `recipient_not_connected`
 * (reply's code already): both read as `not_connected`.
 */
export function linkedInMessageDeferral(err: unknown): LinkedInMessageDeferral | null {
  const e = err as { code?: unknown; reason?: unknown; jobError?: unknown } | null;
  // The code decides: a job's `jobError` is a sentence, and one that mentions
  // a rate limit is not `rate_limited` when the code says otherwise.
  if (typeof e?.code === "string" && e.code) return deferralOf(e.code);
  if (typeof e?.reason === "string") {
    const deferral = deferralOf(e.reason);
    if (deferral) return deferral;
  }
  // An older answer with no code names it in `jobError`. Not `\b`: an
  // underscore is a word character, so `\bnot_connected` misses
  // `recipient_not_connected`.
  const jobError = typeof e?.jobError === "string" ? e.jobError : "";
  const m =
    /(?<![A-Za-z0-9_])(recipient_not_connected|not_connected|rate_limited)(?![A-Za-z0-9_])/.exec(
      jobError,
    );
  return m ? deferralOf(m[1]!) : null;
}
