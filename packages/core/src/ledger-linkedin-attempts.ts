import type { Database } from "bun:sqlite";
import { linkedInFailure } from "./linkedin-error.ts";

/**
 * Send attempts per LinkedIn idempotency key. OneShot never sends twice
 * under one key: a retry of a failed job replays that failure (invite,
 * withdraw) or answers 409 `duplicate_request` (message, reply). A send that
 * failed is tried again under a new key, `<base>:r<n>`; one that may have
 * gone out keeps its key, so a retry can only find the original.
 */

/** The key of attempt `attempt` of a send whose first key is `base`. */
export function linkedInSendKeyAt(base: string, attempt: number): string {
  return attempt > 0 ? `${base}:r${attempt}` : base;
}

/** The first key of the send a key belongs to: `<base>:r<n>` → `<base>`. */
export function linkedInSendBaseKey(key: string): string {
  return key.replace(/:r[1-9]\d*$/, "");
}

/**
 * Whether an error proves a LinkedIn send's job ended failed, so nothing
 * went out: a failed job (JobError), never `send_unverified` (it may have
 * gone out), a 429 (OneShot may have delivered it), a pending job, or a
 * transport or local error.
 */
export function isFailedLinkedInSend(err: unknown): boolean {
  const e = (err ?? {}) as { name?: unknown; statusCode?: unknown; jobError?: unknown };
  if (e.name !== "JobError" || e.statusCode === 429) return false;
  // The code decides; an older answer with no code names it in `jobError`.
  const { code } = linkedInFailure(err);
  if (code) return code !== "send_unverified";
  return !/(?<![a-z_])send_unverified(?![a-z_])/.test(
    typeof e.jobError === "string" ? e.jobError : "",
  );
}

export class LinkedInSendAttemptStore {
  constructor(private readonly db: Database) {}

  /** Failed attempts recorded so far under `base`. */
  attempt(base: string): number {
    const row = this.db
      .query<{ attempt: number }, [string]>(
        "SELECT attempt FROM linkedin_send_attempts WHERE base_key = ?",
      )
      .get(base);
    return row?.attempt ?? 0;
  }

  /** The key the next send under `base` uses. */
  key(base: string): string {
    return linkedInSendKeyAt(base, this.attempt(base));
  }

  /**
   * After a send under `key` threw: when the error proves its job failed
   * (`isFailedLinkedInSend`), the next send uses a new key. True when it moved.
   */
  noteFailed(key: string, err: unknown): boolean {
    if (!isFailedLinkedInSend(err)) return false;
    const code = (err as { code?: unknown }).code;
    return this.markFailed(key, typeof code === "string" ? code : null);
  }

  /**
   * The job sent under `key` failed (the caller holds the proof): the next
   * send uses a new key. Only the current key moves on, so a failure read
   * twice (the click and the sweep) counts once. True when it moved.
   */
  markFailed(key: string, code: string | null): boolean {
    const base = linkedInSendBaseKey(key);
    const attempt = this.attempt(base);
    if (linkedInSendKeyAt(base, attempt) !== key) return false;
    this.db
      .prepare(
        `INSERT INTO linkedin_send_attempts(base_key, attempt, last_code, updated_at)
         VALUES(?, ?, ?, datetime('now'))
         ON CONFLICT(base_key) DO UPDATE SET attempt = excluded.attempt,
           last_code = excluded.last_code, updated_at = excluded.updated_at`,
      )
      .run(base, attempt + 1, code ? code.slice(0, 80) : null);
    return true;
  }
}
