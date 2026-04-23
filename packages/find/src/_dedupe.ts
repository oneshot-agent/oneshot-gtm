import { getLedger } from "@oneshot-gtm/core";

/**
 * True if this (play, dedupe-key) pair is already in the queue
 * OR a prospect with the same email is already known.
 */
export function isDuplicate(opts: {
  playName: string;
  dedupeKey: string;
  prospectEmail?: string | null;
}): boolean {
  const ledger = getLedger();
  if (ledger.isQueueDuplicate(opts.playName, opts.dedupeKey)) return true;
  if (opts.prospectEmail) {
    const existing = ledger.findProspectByEmail(opts.prospectEmail);
    if (existing) return true;
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
