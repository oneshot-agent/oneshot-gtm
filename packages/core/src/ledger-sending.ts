import type { Database } from "bun:sqlite";

/**
 * Sending-identity persistence over a raw Database handle: which
 * `EmailIdentity` a prospect email is pinned to (`sender_assignments`), and
 * per-identity send accounting read off `receipts`/`sequence_events`
 * (`countEmailSendsSince`, `hasPriorEmailSend`, `firstEmailSendAt`).
 * `send-routing.ts` is the caller-facing policy built on these primitives.
 * Extracted from `Ledger` (issue #751); `Ledger` delegates every method here
 * unchanged.
 */

/**
 * Canonical form for matching prospect emails: trim + lowercase. Mirrors the
 * copy in `ledger.ts`, `delivery-health.ts` and `ledger-queue.ts`: a 3-line
 * pure helper, not worth widening any module's public surface for.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getSenderAssignment(db: Database, email: string): string | null {
  const row = db
    .query("SELECT identity_id FROM sender_assignments WHERE email = ?")
    .get(canonEmail(email)) as { identity_id: string } | undefined;
  return row?.identity_id ?? null;
}

/**
 * Pin a prospect email to a sending identity. INSERT OR IGNORE + read-back
 * makes concurrent first-touches race-safe: both callers end up using the
 * single winning assignment instead of splitting the thread across senders.
 */
export function assignSender(db: Database, email: string, identityId: string): string {
  const canon = canonEmail(email);
  db.prepare("INSERT OR IGNORE INTO sender_assignments(email, identity_id) VALUES(?, ?)").run(
    canon,
    identityId,
  );
  return getSenderAssignment(db, canon) ?? identityId;
}

/**
 * Sends by an identity since `sinceUtcSqlite`. The timestamp MUST be in
 * SQLite datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC): receipts
 * default created_at to that format, and an ISO string with its 'T'
 * separator compares GREATER than any same-day SQLite timestamp, silently
 * excluding today's rows.
 */
export function countEmailSendsSince(
  db: Database,
  identityId: string,
  sinceUtcSqlite: string,
): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM receipts
       WHERE call_type = 'email.send' AND sender_identity = ? AND created_at >= ?`,
    )
    .get(identityId, sinceUtcSqlite) as { n: number };
  return row.n;
}

/**
 * Did we ever email this address pre-rotation? Used to lazy-pin legacy
 * prospects (e.g. in-flight cadences) to the legacy identity instead of
 * letting the rotation picker move their thread to a new From address.
 */
export function hasPriorEmailSend(db: Database, email: string): boolean {
  const row = db
    .query(
      `SELECT 1 FROM sequence_events se
       JOIN prospects p ON p.id = se.prospect_id
       WHERE p.email = ? AND se.channel = 'email'
         AND se.status IN ('sent','delivered','replied')
       LIMIT 1`,
    )
    .get(canonEmail(email)) as 1 | undefined;
  return row != null;
}

/** First email.send by this identity (warm-up ramp anchor). SQLite-format UTC or null. */
export function firstEmailSendAt(db: Database, identityId: string): string | null {
  const row = db
    .query(
      `SELECT MIN(created_at) AS first FROM receipts
       WHERE call_type = 'email.send' AND sender_identity = ?`,
    )
    .get(identityId) as { first: string | null };
  return row.first;
}
