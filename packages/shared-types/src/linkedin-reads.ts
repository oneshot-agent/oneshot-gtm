/**
 * Live LinkedIn profile reads: the /setup counter and the queue case's
 * read-on-open route.
 */

/**
 * What live profile reads go through on this install, from `GET /api/setup`
 * as `linkedinReads`. `account`: the connected LinkedIn account's silent
 * profile view (the browser session is not needed). `browser`: no account
 * may view profiles, so the per-workspace browser session is the read path.
 * `null`: neither (reads are off; research uses provider history).
 */
export interface LinkedInReadsView {
  via: "account" | "browser" | null;
  /** Reads written today, counted over the day the daily cap counts. */
  today: number;
  /** The daily cap (`linkedinReadsPerDay`). */
  perDay: number;
  /** Unsent rows in this workspace with a LinkedIn seed and no live read. */
  waiting: number;
}

/** Why a read did not produce a profile. */
export type LiveReadSkipView =
  | "not-linkedin"
  | "failed"
  | "daily-limit"
  | "cost-cap"
  | "not-connected"
  | "session-invalid"
  | "session-unchecked"
  | "different-person"
  | "interrupted"
  | "no-seed"
  | "not-live"
  | "fresh";

/** `POST /api/queue/:id/read-profile`. */
export interface ReadProfileResult {
  /** A live profile was read (or a fresh cached read applied) and written to the row. */
  read: boolean;
  /** Why not, when `read` is false. `fresh`: the row already has a recent live read. */
  skipped: LiveReadSkipView | null;
  /** The read changed the current role or company the offer and draft were written against. */
  roleChanged: boolean;
  /** The row's offer and draft were regenerated because the role changed. */
  redrafted: boolean;
  /** What the write did: `rejected` when the re-judge rejected a pending row as off-ICP. */
  outcome: "patched" | "rejected" | "skipped" | "unavailable";
  /** The reject reason when `outcome` is `rejected`. */
  reason?: string;
}
