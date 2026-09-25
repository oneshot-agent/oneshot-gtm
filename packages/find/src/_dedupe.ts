import { getLedger } from "@oneshot-gtm/core";

/**
 * True if this (play, dedupe-key) pair is already in the queue,
 * OR a prospect with the same email is already known,
 * OR the same email is already pending in the queue under ANOTHER play
 * (cross-play dedup — don't queue + enrich someone a different play already
 * surfaced and is about to email).
 *
 * `playName` accepts an array so a finder that can route its rows to a
 * different play (`play`/`buyerType` config keys, issue #705) can check
 * dedupe against every play it might have enqueued this candidate under —
 * toggling `play` between runs must not let the same person back through.
 *
 * The email-based checks are gated on `prospectEmail`, so callers that pass
 * `undefined` (breakup-revive, by design) still bypass them to re-engage.
 */
export function isDuplicate(opts: {
  playName: string | string[];
  dedupeKey: string;
  prospectEmail?: string | null;
}): boolean {
  const ledger = getLedger();
  const playNames = Array.isArray(opts.playName) ? opts.playName : [opts.playName];
  if (playNames.some((p) => ledger.isQueueDuplicate(p, opts.dedupeKey))) return true;
  if (opts.prospectEmail) {
    const existing = ledger.findProspectByEmail(opts.prospectEmail);
    if (existing) return true;
    if (ledger.isEmailPendingInQueue(opts.prospectEmail)) return true;
  }
  return false;
}

/** Extract a domain from an email address. Returns null on garbage input. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

/** Extract a domain from a URL. Returns null on garbage input. */
export function urlDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
