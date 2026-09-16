import { timeAgo } from "./cn.ts";

/**
 * The LinkedIn card's state machine, kept pure so the copy is testable.
 * One primary action at a time: connect, or finish the sign-in in progress.
 */

export interface LinkedInCfg {
  linkedinBrowserProfileId?: string | null;
  linkedinPendingProfileId?: string | null;
  linkedinSessionCheckedAt?: string | null;
  linkedinSessionName?: string | null;
  linkedinSessionInvalidAt?: string | null;
}

export type LinkedInPhase = "connected" | "expired" | "signing-in" | "idle";

export interface LinkedInView {
  phase: LinkedInPhase;
  /** The one line under the title. */
  headline: string;
  /** The primary button, if any. */
  primary: "connect" | "done" | null;
  /** True when the session is usable: reads run. */
  ok: boolean;
}

/**
 * `pendingHere` — a sign-in this page started (the live URL is in memory);
 * the server's pending id also counts, so a reload mid-login resumes with
 * Done instead of starting over.
 */
export function linkedinView(
  cfg: LinkedInCfg,
  cookieSet: boolean,
  pendingHere: boolean,
): LinkedInView {
  const pending = pendingHere || Boolean(cfg.linkedinPendingProfileId);
  const verified = Boolean(cfg.linkedinBrowserProfileId && cfg.linkedinSessionCheckedAt);
  if (pending) {
    return {
      phase: "signing-in",
      headline: "Sign in to LinkedIn in the tab that opened, then click Done.",
      primary: "done",
      ok: verified && !cfg.linkedinSessionInvalidAt,
    };
  }
  if (verified && !cfg.linkedinSessionInvalidAt) {
    const who = cfg.linkedinSessionName ? `Connected as ${cfg.linkedinSessionName}` : "Connected";
    return {
      phase: "connected",
      headline: `${who} · checked ${timeAgo(cfg.linkedinSessionCheckedAt!)}`,
      primary: null,
      ok: true,
    };
  }
  if (cfg.linkedinSessionInvalidAt) {
    return {
      phase: "expired",
      headline: "LinkedIn signed you out. Connect again to resume profile reads.",
      primary: "connect",
      ok: false,
    };
  }
  return {
    phase: "idle",
    headline: cookieSet
      ? "A cookie is saved but not connected yet."
      : "Not connected. Research uses the data provider's history only.",
    primary: "connect",
    ok: false,
  };
}

/**
 * What to tell the founder after a Done click that did not verify. The
 * server's reason is already a sentence; keep it, and add the one thing
 * they can do about it.
 */
export function doneFailureCopy(reason: string | null): string {
  const base = reason ?? "LinkedIn showed no signed-in member";
  return /not signed in yet/i.test(base)
    ? `${base}.`
    : `${base}. Finish signing in in the LinkedIn tab and click Done again, or start over.`;
}
