import type { Database } from "bun:sqlite";
import type {
  AuthVerdict,
  BounceKind,
  BounceRecord,
  CanaryResultRecord,
  GmailPlacement,
} from "./types.ts";

/**
 * Bounce, suppression, and placement-canary persistence over a raw Database
 * handle. Ledger delegates delivery-health operations here.
 */

/**
 * Keep bounce and suppression keys consistent with prospect, reply, and sender
 * assignment keys in Ledger: trim and lowercase.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Record one delivery failure. INSERT OR IGNORE on (message_id, recipient):
 * the sweep re-sees the same DSN every tick and it must count once. Returns
 * true only for a NEW bounce: callers gate receipt-tagging/logging on that.
 */
export function recordBounce(
  db: Database,
  input: {
    messageId: string;
    recipient: string;
    identityId: string | null;
    kind: BounceKind;
    statusCode: string | null;
    diagnostic: string | null;
    prospectId: number | null;
    bouncedAt: string;
  },
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO bounces
         (message_id, recipient, identity_id, kind, status_code, diagnostic, prospect_id, bounced_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      canonEmail(input.recipient),
      input.identityId,
      input.kind,
      input.statusCode,
      input.diagnostic?.slice(0, 300) ?? null,
      input.prospectId,
      input.bouncedAt,
    );
  return result.changes > 0;
}

/**
 * The hard bounce that suppresses this address, or null if it's still
 * sendable. HARD ONLY. A `block` is the receiving server refusing a message
 * on policy, not a statement that the mailbox is dead, so suppressing on it
 * would permanently burn valid prospects over one spam-filter verdict.
 * Soft bounces are transient by definition.
 */
export function suppressionFor(db: Database, email: string): BounceRecord | null {
  return (
    (db
      .query(
        `SELECT * FROM bounces WHERE recipient = ? AND kind = 'hard'
         ORDER BY bounced_at DESC LIMIT 1`,
      )
      .get(canonEmail(email)) as BounceRecord) ?? null
  );
}

/**
 * Cache whether inbox_replies has an intent column. Older ledgers may lack it.
 * The schema is stable during a process, so dispatch need not query PRAGMA on
 * every send.
 */
const intentColumnCache = new WeakMap<Database, boolean>();
function hasIntentColumn(db: Database): boolean {
  let cached = intentColumnCache.get(db);
  if (cached === undefined) {
    cached = (db.query("PRAGMA table_info(inbox_replies)").all() as Array<{ name: string }>).some(
      (c) => c.name === "intent",
    );
    intentColumnCache.set(db, cached);
  }
  return cached;
}

/**
 * Suppress addresses with unsubscribe or auto_permanent replies across all
 * cadences, including future enrollment. Check both kind and intent: the phrase
 * classifier can miss an opt-out that sentiment classification catches. Older
 * ledgers without intent fall back to kind.
 *
 * Return the suppression reason, not the raw kind. An intent-only unsubscribe
 * must report unsubscribe so callers do not label the opt-out as a bounce.
 */
export function contactSuppressionFor(
  db: Database,
  email: string,
): { kind: string; received_at: string } | null {
  const intentClause = hasIntentColumn(db) ? " OR intent = 'unsubscribe'" : "";
  return (
    (db
      .query(
        `SELECT
           CASE WHEN kind IN ('unsubscribe', 'auto_permanent') THEN kind ELSE 'unsubscribe' END AS kind,
           received_at
         FROM inbox_replies
         WHERE (from_email = ? OR prospect_id IN (SELECT id FROM prospects WHERE email = ?))
           AND (kind IN ('unsubscribe', 'auto_permanent')${intentClause})
         ORDER BY received_at DESC LIMIT 1`,
      )
      .get(canonEmail(email), canonEmail(email)) as { kind: string; received_at: string }) ?? null
  );
}

/** Bounce counts per sending identity since `sinceIso`. The doctor check's numerator. */
export function bounceStatsByIdentity(
  db: Database,
  opts: { sinceIso: string },
): Map<string, { hard: number; block: number; soft: number }> {
  const rows = db
    .query(
      `SELECT identity_id, kind, COUNT(*) AS n FROM bounces
       WHERE bounced_at >= ? AND identity_id IS NOT NULL
       GROUP BY identity_id, kind`,
    )
    .all(opts.sinceIso) as Array<{ identity_id: string; kind: BounceKind; n: number }>;
  const out = new Map<string, { hard: number; block: number; soft: number }>();
  for (const r of rows) {
    let entry = out.get(r.identity_id);
    if (!entry) {
      entry = { hard: 0, block: 0, soft: 0 };
      out.set(r.identity_id, entry);
    }
    entry[r.kind] = r.n;
  }
  return out;
}

/** Most recent bounces for display (doctor detail lines, debugging). */
export function listRecentBounces(db: Database, opts: { limit?: number } = {}): BounceRecord[] {
  return db
    .query(`SELECT * FROM bounces ORDER BY bounced_at DESC LIMIT ?`)
    .all(opts.limit ?? 20) as BounceRecord[];
}

/**
 * Count DSN events by the bounces (message_id, recipient) primary key for the
 * Slack daily summary. sequence_events can duplicate a bounce across cadences
 * and omit soft bounces or unmatched prospects. bounced_at is always non-null.
 * Dead-mailbox autoresponders are counted separately by countAutoPermanentBounces.
 */
export function countBounces(
  db: Database,
  opts: { sinceIso?: string; untilIso?: string } = {},
): number {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sinceIso) {
    where.push("bounced_at >= ?");
    args.push(opts.sinceIso);
  }
  if (opts.untilIso) {
    where.push("bounced_at < ?");
    args.push(opts.untilIso);
  }
  const sql = `SELECT COUNT(*) AS n FROM bounces${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return (db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
}

/**
 * Count auto_permanent replies alongside DSN bounces in the Slack daily summary.
 * inbox_replies records these even when a prospect has no active cadence;
 * sequence_events does not. The provider message ID is the primary key and
 * INSERT OR IGNORE ensures each event counts once.
 */
export function countAutoPermanentBounces(
  db: Database,
  opts: { sinceIso?: string; untilIso?: string } = {},
): number {
  const where: string[] = ["kind = 'auto_permanent'"];
  const args: unknown[] = [];
  if (opts.sinceIso) {
    where.push("received_at >= ?");
    args.push(opts.sinceIso);
  }
  if (opts.untilIso) {
    where.push("received_at < ?");
    args.push(opts.untilIso);
  }
  const sql = `SELECT COUNT(*) AS n FROM inbox_replies WHERE ${where.join(" AND ")}`;
  return (db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
}

export function recordCanaryResult(
  db: Database,
  input: {
    fromIdentity: string;
    toIdentity: string;
    placement: GmailPlacement;
    labelIds: string[];
    auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
    subject: string | null;
    sourcePlay: string | null;
    sameDomain: boolean;
    latencyMs: number | null;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO canary_results
         (from_identity, to_identity, placement, labels_json, spf, dkim, dmarc,
          subject, source_play, same_domain, latency_ms)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.fromIdentity,
      input.toIdentity,
      input.placement,
      JSON.stringify(input.labelIds),
      input.auth.spf,
      input.auth.dkim,
      input.auth.dmarc,
      input.subject,
      input.sourcePlay,
      input.sameDomain ? 1 : 0,
      input.latencyMs,
    );
  return Number(result.lastInsertRowid);
}

/** Newest placement test, or null if one has never been run. */
export function latestCanaryResult(db: Database): CanaryResultRecord | null {
  return (
    (db
      .query(`SELECT * FROM canary_results ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get() as CanaryResultRecord) ?? null
  );
}

/**
 * Subject + body of the most recent email this tool actually SENT, for the
 * placement canary to replay. Spam filters judge content, so testing with
 * invented copy would measure nothing that transfers to real outreach.
 * Reads the persisted draft off the sequence_events row (metadata_json
 * carries {subject, body} for sent email steps).
 */
export function latestSentEmailCopy(
  db: Database,
  opts: { playName?: string } = {},
): { subject: string; body: string; playName: string } | null {
  const rows = db
    .query(
      // 'sent' rows are UPDATEd in place to 'replied', so all three statuses
      // mean "sent": matching only 'sent' would skip every prospect who
      // answered. Usability is filtered in SQL (not a JS slice) so the small
      // bound below only ever trims genuinely valid candidates.
      `SELECT play_name, metadata_json FROM sequence_events
       WHERE status IN ('sent', 'delivered', 'replied')
         AND channel = 'email' AND metadata_json IS NOT NULL
         AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.subject') IS NOT NULL
         AND trim(coalesce(json_extract(metadata_json, '$.body'), '')) != ''
         ${opts.playName ? "AND play_name = ?" : ""}
       -- id DESC breaks ties: created_at is second-precision, and a cadence
       -- batch writes several rows within one second, leaving their relative
       -- order otherwise unspecified.
       ORDER BY created_at DESC, id DESC LIMIT 25`,
    )
    .all(...(opts.playName ? [opts.playName] : [])) as Array<{
    play_name: string;
    metadata_json: string;
  }>;
  // Backstop for shapes SQL can't reject. A numeric subject, say, which
  // json_extract happily returns but which isn't usable copy.
  for (const row of rows) {
    let meta: { subject?: unknown; body?: unknown };
    try {
      meta = JSON.parse(row.metadata_json) as { subject?: unknown; body?: unknown };
    } catch {
      continue;
    }
    if (typeof meta.subject === "string" && typeof meta.body === "string" && meta.body.trim()) {
      return { subject: meta.subject, body: meta.body, playName: row.play_name };
    }
  }
  return null;
}
