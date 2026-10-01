import type { Database } from "bun:sqlite";

/**
 * Outbound send ledger (ledger v10, `outbound_sends`): one row per INTENDED
 * email, keyed by a semantic idempotency key (workspace, play, recipient or
 * prospect, step). The key is the claim that stops a second send of the same
 * email, whatever transport carries it and however often the draft is
 * rewritten. Shares the Ledger's database handle, like `SendDeliveryStore`.
 *
 * Status lifecycle:
 *   pending   → claimed, the send is in flight
 *   submitted → the transport accepted it (SMTP 250, API 2xx)
 *   uncertain → it may have gone out (dropped after DATA, timeout, crash)
 *   failed    → definitely not sent; a retry may reuse the same Message-ID
 *   confirmed → found in the mailbox's Sent folder
 *   not_found → accepted but never seen in Sent inside the window
 */
export type OutboundStatus =
  | "pending"
  | "submitted"
  | "uncertain"
  | "failed"
  | "confirmed"
  | "not_found";

/** A pending claim older than this belonged to a process that died mid-send. */
export const STALE_PENDING_MS = 5 * 60_000;

export interface OutboundSend {
  key: string;
  identityId: string;
  transport: string;
  recipient: string;
  subject: string;
  messageId: string | null;
  status: OutboundStatus;
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  checkedAt: string | null;
  observed: number | null;
  receiptId: number | null;
  queueId: number | null;
  prospectId: number | null;
  error: string | null;
}

interface Row {
  key: string;
  identity_id: string;
  transport: string;
  recipient: string;
  subject: string;
  message_id: string | null;
  status: string;
  attempts: number;
  first_attempt_at: string;
  last_attempt_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
  checked_at: string | null;
  observed: number | null;
  receipt_id: number | null;
  queue_id: number | null;
  prospect_id: number | null;
  error: string | null;
}

function toSend(row: Row): OutboundSend {
  return {
    key: row.key,
    identityId: row.identity_id,
    transport: row.transport,
    recipient: row.recipient,
    subject: row.subject,
    messageId: row.message_id,
    status: row.status as OutboundStatus,
    attempts: row.attempts,
    firstAttemptAt: row.first_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
    checkedAt: row.checked_at,
    observed: row.observed,
    receiptId: row.receipt_id,
    queueId: row.queue_id,
    prospectId: row.prospect_id,
    error: row.error,
  };
}

/**
 * What a claim decided. `send` means this caller owns the attempt (fresh, or a
 * retry after a definite failure, which reuses the stored Message-ID). Every
 * other verdict means "do not send": the existing row says why.
 */
export type OutboundClaim =
  | { verdict: "send"; send: OutboundSend; retry: boolean }
  | { verdict: "in_flight"; send: OutboundSend }
  | { verdict: "uncertain"; send: OutboundSend }
  | { verdict: "already_sent"; send: OutboundSend };

export interface ClaimInput {
  key: string;
  identityId: string;
  transport: string;
  recipient: string;
  subject: string;
  /** Message-ID to send under. Kept from the first attempt on a retry. */
  messageId: string | null;
  queueId?: number | null;
  prospectId?: number | null;
  /** Injected clock for tests. */
  now?: Date;
}

export class OutboundSendStore {
  constructor(private readonly db: Database) {}

  get(key: string): OutboundSend | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM outbound_sends WHERE key = ?").get(key);
    return row ? toSend(row) : null;
  }

  forReceipt(receiptId: number): OutboundSend | null {
    const row = this.db
      .query<Row, [number]>("SELECT * FROM outbound_sends WHERE receipt_id = ? LIMIT 1")
      .get(receiptId);
    return row ? toSend(row) : null;
  }

  /**
   * Atomically claim `key` for one send attempt. Inside one IMMEDIATE
   * transaction so two processes can't both see "free":
   * - no row → insert `pending`, verdict `send`;
   * - `failed` → back to `pending` with the SAME Message-ID, verdict `send` (retry);
   * - `pending` younger than STALE_PENDING_MS → `in_flight`;
   * - `pending` older → its process died mid-send: becomes `uncertain`;
   * - `uncertain` → `uncertain` (reconcile against Sent before any resend);
   * - `submitted` / `confirmed` / `not_found` → `already_sent`.
   */
  claim(input: ClaimInput): OutboundClaim {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const run = this.db.transaction((): OutboundClaim => {
      const existing = this.get(input.key);
      if (!existing) {
        this.db
          .query(
            `INSERT INTO outbound_sends
               (key, identity_id, transport, recipient, subject, message_id, status, attempts,
                first_attempt_at, last_attempt_at, queue_id, prospect_id)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
          )
          .run(
            input.key,
            input.identityId,
            input.transport,
            input.recipient,
            input.subject,
            input.messageId,
            nowIso,
            nowIso,
            input.queueId ?? null,
            input.prospectId ?? null,
          );
        return { verdict: "send", send: this.get(input.key)!, retry: false };
      }
      switch (existing.status) {
        case "failed": {
          // A definite failure never reached the server: retry under the same
          // Message-ID, so even a misjudged "definite" is still one message.
          this.db
            .query(
              `UPDATE outbound_sends
                  SET status = 'pending', attempts = attempts + 1, last_attempt_at = ?,
                      identity_id = ?, transport = ?, subject = ?, error = NULL,
                      message_id = COALESCE(message_id, ?)
                WHERE key = ?`,
            )
            .run(
              nowIso,
              input.identityId,
              input.transport,
              input.subject,
              input.messageId,
              input.key,
            );
          return { verdict: "send", send: this.get(input.key)!, retry: true };
        }
        case "pending": {
          const age = now.getTime() - Date.parse(existing.lastAttemptAt);
          if (age < STALE_PENDING_MS) return { verdict: "in_flight", send: existing };
          this.mark(input.key, "uncertain", {
            error: "send interrupted mid-flight; checking Sent before any retry",
            now,
          });
          return { verdict: "uncertain", send: this.get(input.key)! };
        }
        case "uncertain":
          return { verdict: "uncertain", send: existing };
        default:
          return { verdict: "already_sent", send: existing };
      }
    });
    return run.immediate();
  }

  /** Record a transport outcome or a confirm-sweep verdict. */
  mark(
    key: string,
    status: OutboundStatus,
    extra: {
      messageId?: string | null;
      receiptId?: number | null;
      error?: string | null;
      observed?: number | null;
      now?: Date;
    } = {},
  ): void {
    const nowIso = (extra.now ?? new Date()).toISOString();
    this.db
      .query(
        `UPDATE outbound_sends
            SET status = ?,
                message_id = COALESCE(?, message_id),
                receipt_id = COALESCE(?, receipt_id),
                error = ?,
                observed = COALESCE(?, observed),
                submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at END,
                confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
                checked_at = CASE WHEN ? = 1 THEN ? ELSE checked_at END
          WHERE key = ?`,
      )
      .run(
        status,
        extra.messageId ?? null,
        extra.receiptId ?? null,
        extra.error ?? null,
        extra.observed ?? null,
        status,
        nowIso,
        status,
        nowIso,
        // The confirm sweep passes `observed`; that is what "checked" means.
        extra.observed === undefined ? 0 : 1,
        nowIso,
        key,
      );
  }

  /**
   * Rows the confirm sweep should look at: submitted or uncertain, last touched
   * at least `minAgeMs` ago, oldest first.
   */
  listUnconfirmed(opts: { minAgeMs: number; limit: number; now?: Date }): OutboundSend[] {
    const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.minAgeMs).toISOString();
    return this.db
      .query<Row, [string, number]>(
        `SELECT * FROM outbound_sends
          WHERE status IN ('submitted', 'uncertain') AND last_attempt_at <= ?
          ORDER BY last_attempt_at
          LIMIT ?`,
      )
      .all(cutoff, opts.limit)
      .map(toSend);
  }

  /** Keyed sends first attempted since `sinceIso`, newest first (the `sends check` report). */
  listSince(sinceIso: string, limit: number): OutboundSend[] {
    return this.db
      .query<Row, [string, number]>(
        `SELECT * FROM outbound_sends
          WHERE first_attempt_at >= ?
          ORDER BY first_attempt_at DESC
          LIMIT ?`,
      )
      .all(sinceIso, limit)
      .map(toSend);
  }
}
