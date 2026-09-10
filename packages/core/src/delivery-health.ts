import type { Database } from "bun:sqlite";
import type {
  AuthVerdict,
  BounceKind,
  BounceRecord,
  CanaryResultRecord,
  GmailPlacement,
} from "./types.ts";

/**
 * Bounce harvesting, suppression, and inbox-placement canary persistence —
 * the delivery-health slice of the ledger split tracked in ROADMAP.md
 * (issue #617, follow-up to the schema-migration extraction in #452).
 *
 * Pure functions of a raw `Database` handle, mirroring `ledger-schema.ts`'s
 * pattern: no dependency on the `Ledger` class, so this domain can be read
 * and tested in isolation. `Ledger`'s own `recordBounce` / `suppressionFor` /
 * `contactSuppressionFor` / `bounceStatsByIdentity` / `listRecentBounces` /
 * `countBounces` / `countAutoPermanentBounces` / `recordCanaryResult` /
 * `latestCanaryResult` / `latestSentEmailCopy` methods (ledger.ts) are now
 * thin delegates to the functions below — same names, same signatures, same
 * SQL — so every call site and the exported `Ledger` surface are unchanged.
 */

/**
 * Canonical form for matching prospect/bounce emails — trim + lowercase.
 * Mirrors `Ledger`'s own `canonEmail` (ledger.ts) so bounces and suppression
 * stay keyed identically to the rest of the ledger (prospects, replies,
 * sender assignments). Duplicated rather than imported/exported across the
 * module boundary: it's a 3-line pure helper, and re-exporting it from
 * ledger.ts would widen that file's public surface for no benefit.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Record one delivery failure. INSERT OR IGNORE on (message_id, recipient):
 * the sweep re-sees the same DSN every tick and it must count once. Returns
 * true only for a NEW bounce — callers gate receipt-tagging/logging on that.
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
 * sendable. HARD ONLY — a `block` is the receiving server refusing a message
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
 * A do-not-send verdict from the reply stream: the newest 'unsubscribe'
 * (they asked to stop) or 'auto_permanent' (their responder says the
 * mailbox is dead) captured from this address. Durable on purpose — it
 * outlives any one cadence, so a later play can never re-enroll and email
 * an unsubscribed or gone prospect. Sibling of suppressionFor (bounces).
 */
export function contactSuppressionFor(
  db: Database,
  email: string,
): { kind: string; received_at: string } | null {
  return (
    (db
      .query(
        `SELECT kind, received_at FROM inbox_replies
         WHERE from_email = ? AND kind IN ('unsubscribe', 'auto_permanent')
         ORDER BY received_at DESC LIMIT 1`,
      )
      .get(canonEmail(email)) as { kind: string; received_at: string }) ?? null
  );
}

/** Bounce counts per sending identity since `sinceIso` — the doctor check's numerator. */
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
 * Count of distinct recorded delivery-failure events in the window, keyed
 * by `bounces`' own (message_id, recipient) PK — the Slack daily summary's
 * `bounced` total (issue #71 round-3 review finding). Deliberately NOT
 * derived from `sequence_events`: `pollInboxBounces` inserts one
 * sequence_events row PER CADENCE a bounced prospect is enrolled in, so a
 * single DSN for a prospect in 2+ concurrent cadences would be counted
 * multiple times there, and it skips sequence_events entirely for soft
 * bounces and for bounces on prospects with no ledger match — both of
 * which still land here and still fire `notifySlackBounceRecorded`. This
 * table is the one row per real bounce event; `bounced_at` is NOT NULL on
 * every row (unlike sequence_events', which predates the column on old
 * rows), so no COALESCE fallback is needed. Sibling of
 * countAutoPermanentBounces (the reply-stream bounce path, which never
 * writes to this table).
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
 * Count of distinct dead-mailbox autoresponder events ("auto_permanent"
 * reply kind, see reply-classify.ts) in the window — the OTHER bounce
 * source the Slack daily summary's `bounced` total must include alongside
 * countBounces (DSN bounces never touch `sequence_events`; this reply-
 * stream path never touches `bounces`). Counted from `inbox_replies`, NOT
 * `sequence_events` (issue #71 round-1 correction): `pollInboxReplies`
 * (and the /inbox route's opportunistic capture) call `recordInboxReply`
 * for EVERY matched auto_permanent email unconditionally, but only write a
 * `sequence_events` row inside the `listCadencesForProspect(...).filter
 * (status active|paused)` loop right after — a dead-mailbox reply for a
 * prospect whose only cadence is already terminal (or who has none) still
 * fires `notifySlackBounceRecorded` and is persisted here, but would never
 * produce a `sequence_events` row to count. `inbox_replies.id` is the
 * provider's own message id and PRIMARY KEY (INSERT OR IGNORE), so each
 * real event is already exactly one row — no de-dup math needed, unlike
 * countBounces' sibling problem on the multi-cadence `sequence_events`
 * path.
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
      // mean "sent" — matching only 'sent' would skip every prospect who
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
  // Backstop for shapes SQL can't reject — a numeric subject, say, which
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
