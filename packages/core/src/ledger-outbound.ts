import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/**
 * Outbound send ledger (ledger v10, `outbound_sends`): one row per INTENDED
 * email, keyed by a semantic idempotency key (workspace, play, recipient or
 * prospect, step). The key is the claim that stops a second send of the same
 * email, whatever transport carries it and however often the draft is
 * rewritten. Shares the Ledger's database handle, like `SendDeliveryStore`.
 * Since v11 mailbox replies live here too (`kind = 'reply'`, see `claimReply`).
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

/**
 * Deterministic Message-ID for one intended email: the same key always yields
 * the same id, so a retry after a definite failure, or a second attempt that
 * slipped past every other guard, is one message to the recipient, and the
 * confirm sweep can find it in Sent by header.
 */
export function outboundMessageId(key: string, fromAddress: string): string {
  const domain = fromAddress.split("@")[1]?.trim().toLowerCase() || "localhost";
  return `<${createHash("sha256").update(key).digest("hex").slice(0, 32)}@${domain}>`;
}

/** `initial` = a new email; `reply` = a threaded mailbox reply to a stored inbound message. */
export type OutboundKind = "initial" | "reply";

/** Threading a reply carries, stored at claim time so a resend is byte-identical. */
export interface ReplyThreading {
  inboundId: string;
  threadKey: string;
  inReplyTo: string;
  references: string[];
  /** The MIME Date header (ISO). */
  dateHeader: string;
}

export interface OutboundSend {
  key: string;
  identityId: string;
  transport: string;
  recipient: string;
  subject: string;
  /** The body of the attempt on record (see `exactResend`). */
  body: string;
  messageId: string | null;
  status: OutboundStatus;
  /**
   * Missing from the mailbox's Sent folder proves "not sent": true for Gmail
   * and for SMTP servers that file their own Sent copy. Where it is false, an
   * unknown outcome is never retried automatically.
   */
  sentEvidence: boolean;
  /**
   * Set once an attempt's outcome was unknown: any retry resends the stored
   * subject and body, never a re-draft, so a transport that dedupes on content
   * (the OneShot SDK key) replays the first send instead of sending another.
   */
  exactResend: boolean;
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
  kind: OutboundKind;
  /** Replies only (null on initial sends). */
  inboundId: string | null;
  threadKey: string | null;
  inReplyTo: string | null;
  references: string[];
  dateHeader: string | null;
}

interface Row {
  key: string;
  identity_id: string;
  transport: string;
  recipient: string;
  subject: string;
  body: string;
  message_id: string | null;
  status: string;
  sent_evidence: number;
  exact_resend: number;
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
  kind: string | null;
  inbound_id: string | null;
  thread_key: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  date_header: string | null;
}

function parseReferences(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function toSend(row: Row): OutboundSend {
  return {
    key: row.key,
    identityId: row.identity_id,
    transport: row.transport,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    messageId: row.message_id,
    status: row.status as OutboundStatus,
    sentEvidence: row.sent_evidence === 1,
    exactResend: row.exact_resend === 1,
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
    kind: row.kind === "reply" ? "reply" : "initial",
    inboundId: row.inbound_id,
    threadKey: row.thread_key,
    inReplyTo: row.in_reply_to,
    references: parseReferences(row.references_json),
    dateHeader: row.date_header,
  };
}

/**
 * What `claimReply` decided. `claimed`: this caller owns the send. `exists`:
 * a row under this key already (`send` is it). `busy`: another reply to the
 * same inbound message is still pending or uncertain (`send` is that one).
 */
export interface ReplyClaim {
  verdict: "claimed" | "exists" | "busy";
  send: OutboundSend;
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
  body: string;
  /** Message-ID to send under. Kept from the first attempt on a retry. */
  messageId: string | null;
  /** See `OutboundSend.sentEvidence`. */
  sentEvidence: boolean;
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
   * Claim a mailbox reply, in one IMMEDIATE transaction. A row under `key`
   * already → `exists` (the caller replays or refuses). Another reply to the
   * same inbound message still pending or uncertain → `busy`; a pending one
   * older than STALE_PENDING_MS is settled to uncertain on the way (its
   * process died mid-send). Neither writes a new row. The partial unique
   * index `outbound_reply_inflight` holds the same rule in the database.
   */
  claimReply(
    input: Omit<ClaimInput, "queueId" | "prospectId"> & ReplyThreading & { messageId: string },
  ): ReplyClaim {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const run = this.db.transaction((): ReplyClaim => {
      const existing = this.get(input.key);
      if (existing) return { verdict: "exists", send: existing };
      const busy = this.db
        .query<Row, [string]>(
          `SELECT * FROM outbound_sends
            WHERE kind = 'reply' AND inbound_id = ? AND status IN ('pending', 'uncertain')
            LIMIT 1`,
        )
        .get(input.inboundId);
      if (busy) {
        if (
          busy.status === "pending" &&
          now.getTime() - Date.parse(busy.last_attempt_at) >= STALE_PENDING_MS
        ) {
          this.mark(busy.key, "uncertain", {
            error: "send interrupted mid-flight; checking Sent before any retry",
            now,
          });
        }
        return { verdict: "busy", send: this.get(busy.key)! };
      }
      this.db
        .query(
          `INSERT INTO outbound_sends
             (key, identity_id, transport, recipient, subject, body, message_id, status,
              sent_evidence, attempts, first_attempt_at, last_attempt_at, kind, inbound_id,
              thread_key, in_reply_to, references_json, date_header)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, 'reply', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.key,
          input.identityId,
          input.transport,
          input.recipient,
          input.subject,
          input.body,
          input.messageId,
          input.sentEvidence ? 1 : 0,
          nowIso,
          nowIso,
          input.inboundId,
          input.threadKey,
          input.inReplyTo,
          JSON.stringify(input.references),
          input.dateHeader,
        );
      return { verdict: "claimed", send: this.get(input.key)! };
    });
    return run.immediate();
  }

  /** Link a receipt to a send without touching its status (a replay never downgrades it). */
  attachReceipt(key: string, receiptId: number): void {
    this.db
      .query("UPDATE outbound_sends SET receipt_id = COALESCE(receipt_id, ?) WHERE key = ?")
      .run(receiptId, key);
  }

  /**
   * One mailbox's replies whose Sent copy has not been seen yet: submitted,
   * uncertain, or pending past STALE_PENDING_MS (a fresh pending one is still
   * being sent by a live process).
   */
  unconfirmedReplies(identityId: string, now: Date = new Date()): OutboundSend[] {
    const stale = new Date(now.getTime() - STALE_PENDING_MS).toISOString();
    return this.db
      .query<Row, [string, string]>(
        `SELECT * FROM outbound_sends
          WHERE kind = 'reply' AND identity_id = ? AND message_id IS NOT NULL
            AND (status IN ('submitted', 'uncertain')
                 OR (status = 'pending' AND last_attempt_at <= ?))`,
      )
      .all(identityId, stale)
      .map(toSend);
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
               (key, identity_id, transport, recipient, subject, body, message_id, status,
                sent_evidence, attempts, first_attempt_at, last_attempt_at, queue_id, prospect_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?)`,
          )
          .run(
            input.key,
            input.identityId,
            input.transport,
            input.recipient,
            input.subject,
            input.body,
            input.messageId,
            input.sentEvidence ? 1 : 0,
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
          // After an unknown outcome the stored content is resent as is.
          this.db
            .query(
              `UPDATE outbound_sends
                  SET status = 'pending', attempts = attempts + 1, last_attempt_at = ?,
                      identity_id = ?, transport = ?, error = NULL, sent_evidence = ?,
                      subject = CASE WHEN exact_resend = 1 THEN subject ELSE ? END,
                      body = CASE WHEN exact_resend = 1 THEN body ELSE ? END,
                      message_id = COALESCE(message_id, ?)
                WHERE key = ?`,
            )
            .run(
              nowIso,
              input.identityId,
              input.transport,
              input.sentEvidence ? 1 : 0,
              input.subject,
              input.body,
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
                exact_resend = CASE WHEN ? = 'uncertain' THEN 1 ELSE exact_resend END,
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
        status,
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
