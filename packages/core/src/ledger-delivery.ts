import type { Database } from "bun:sqlite";
import type { SendDeliveryView } from "@oneshot-gtm/shared-types";
import { sqliteToIso } from "./time.ts";

/**
 * Delivery checks (ledger v8, `send_delivery_checks`): for each recorded email
 * send on a transport with no idempotency key, how many copies the sending
 * mailbox's Sent folder actually holds. The checker lives in
 * `send-delivery.ts`; this store only reads candidate sends and records
 * results. Shares the Ledger's database handle, like `IcpProposalStore`.
 */

/** Transports a delivery check covers. OneShot sends carry an idempotency key. */
export const DELIVERY_CHECKED_TRANSPORTS = ["smartlead", "gmail"] as const;
export type DeliveryTransport = (typeof DELIVERY_CHECKED_TRANSPORTS)[number];
export type DeliveryStatus = SendDeliveryView["status"];

/** One recorded email send a delivery check can run against. */
export interface DeliveryCandidate {
  receiptId: number;
  sequenceEventId: number | null;
  queueId: number | null;
  prospectId: number | null;
  transport: DeliveryTransport;
  /** `receipts.sender_identity`, e.g. `smartlead:jn@example.com`. */
  identity: string;
  recipient: string;
  subject: string;
  /** ISO time the send was recorded. */
  sentAt: string;
}

export interface DeliveryRecord {
  candidate: DeliveryCandidate;
  status: DeliveryStatus;
  expected: number;
  observed: number | null;
  messageIds: string[];
  deliveredAt: string[];
  checkedAt: string;
  error: string | null;
}

interface CandidateRow {
  receipt_id: number;
  sequence_event_id: number | null;
  queue_id: number | null;
  prospect_id: number | null;
  transport: string;
  identity: string;
  recipient: string | null;
  subject: string | null;
  created_at: string;
}

interface CheckRow {
  receipt_id: number;
  sequence_event_id: number | null;
  queue_id: number | null;
  prospect_id: number | null;
  transport: string;
  identity: string;
  recipient: string;
  subject: string;
  sent_at: string;
  status: string;
  expected: number;
  observed: number | null;
  message_ids: string;
  delivered_at: string;
  checked_at: string;
  error: string | null;
  /** 1 when the receipt belongs to a keyed send (`outbound_sends`). */
  keyed: number;
}

/** Check columns plus whether the send was keyed (one Message-ID, confirmed by the outbound sweep). */
const CHECK_COLS =
  "c.*, EXISTS (SELECT 1 FROM outbound_sends o WHERE o.receipt_id = c.receipt_id) AS keyed";

const CANDIDATE_SELECT = `SELECT r.id AS receipt_id,
                (SELECT se.id FROM sequence_events se WHERE se.receipt_id = r.id ORDER BY se.id LIMIT 1) AS sequence_event_id,
                (SELECT se.prospect_id FROM sequence_events se WHERE se.receipt_id = r.id ORDER BY se.id LIMIT 1) AS prospect_id,
                (SELECT q.id FROM target_queue q, json_each(q.last_draft_json, '$.receiptIds') j
                   WHERE q.last_draft_json IS NOT NULL AND json_valid(q.last_draft_json) AND j.value = r.id LIMIT 1) AS queue_id,
                json_extract(r.signed_receipt, '$.provider') AS transport,
                r.sender_identity AS identity,
                json_extract(r.signed_receipt, '$.to') AS recipient,
                json_extract(r.signed_receipt, '$.subject') AS subject,
                r.created_at
           FROM receipts r`;

function toCandidate(row: CandidateRow): DeliveryCandidate | null {
  if (!row.recipient || typeof row.recipient !== "string") return null;
  return {
    receiptId: row.receipt_id,
    sequenceEventId: row.sequence_event_id,
    queueId: row.queue_id,
    prospectId: row.prospect_id,
    transport: row.transport as DeliveryTransport,
    identity: row.identity,
    recipient: row.recipient.trim().toLowerCase(),
    subject: (row.subject ?? "").trim(),
    sentAt: sqliteToIso(row.created_at),
  };
}

function parseList(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toView(row: CheckRow): SendDeliveryView {
  return {
    status: row.status as DeliveryStatus,
    expected: row.expected,
    observed: row.observed,
    deliveredAt: parseList(row.delivered_at),
    sentAt: row.sent_at,
    checkedAt: row.checked_at,
    transport: row.transport as DeliveryTransport,
    identity: row.identity,
    error: row.error,
    keyed: row.keyed === 1,
  };
}

/** A recorded mismatch, for the doctor check and the CLI. */
export interface DeliveryMismatch extends SendDeliveryView {
  receiptId: number;
  queueId: number | null;
  sequenceEventId: number | null;
  prospectId: number | null;
  recipient: string;
}

export class SendDeliveryStore {
  constructor(private readonly db: Database) {}

  /**
   * Email sends recorded in [sinceIso, untilIso] on a checked transport, oldest
   * first. `includeChecked` re-reads sends that already have a result (CLI
   * re-check); the sweep leaves it off. Recipient and subject come from the
   * receipt we wrote at send time (`signed_receipt.to` / `.subject`).
   */
  listCandidates(opts: {
    sinceIso: string;
    untilIso: string;
    limit: number;
    includeChecked?: boolean;
  }): DeliveryCandidate[] {
    const rows = this.db
      .query<CandidateRow, [string, string, string, string, number]>(
        `${CANDIDATE_SELECT}
          WHERE r.call_type = 'email.send'
            AND json_valid(r.signed_receipt)
            AND json_extract(r.signed_receipt, '$.provider') IN (?, ?)
            AND r.sender_identity IS NOT NULL
            AND julianday(r.created_at) BETWEEN julianday(?) AND julianday(?)
            ${opts.includeChecked ? "" : "AND NOT EXISTS (SELECT 1 FROM send_delivery_checks c WHERE c.receipt_id = r.id)"}
            -- Keyed sends are confirmed by the outbound_sends sweep instead.
            AND NOT EXISTS (SELECT 1 FROM outbound_sends o WHERE o.receipt_id = r.id)
          ORDER BY r.id
          LIMIT ?`,
      )
      .all(...DELIVERY_CHECKED_TRANSPORTS, opts.sinceIso, opts.untilIso, opts.limit);
    const out: DeliveryCandidate[] = [];
    for (const row of rows) {
      const c = toCandidate(row);
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * The candidate for one receipt whatever its check state, for the keyed-send
   * sweep to record its verdict against. Replies count too. Null when the
   * receipt is not an email on a checked transport.
   */
  candidateFor(receiptId: number): DeliveryCandidate | null {
    const row = this.db
      .query<CandidateRow, [number, string, string]>(
        `${CANDIDATE_SELECT}
          WHERE r.id = ?
            AND r.call_type IN ('email.send', 'email.reply')
            AND json_valid(r.signed_receipt)
            AND json_extract(r.signed_receipt, '$.provider') IN (?, ?)
            AND r.sender_identity IS NOT NULL`,
      )
      .get(receiptId, ...DELIVERY_CHECKED_TRANSPORTS);
    return row ? toCandidate(row) : null;
  }

  /** Insert or replace the result for one receipt. */
  record(rec: DeliveryRecord): void {
    const c = rec.candidate;
    this.db
      .query(
        `INSERT INTO send_delivery_checks
           (receipt_id, sequence_event_id, queue_id, prospect_id, transport, identity, recipient,
            subject, sent_at, status, expected, observed, message_ids, delivered_at, checked_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(receipt_id) DO UPDATE SET
           status = excluded.status, expected = excluded.expected, observed = excluded.observed,
           message_ids = excluded.message_ids, delivered_at = excluded.delivered_at,
           checked_at = excluded.checked_at, error = excluded.error,
           sequence_event_id = excluded.sequence_event_id, queue_id = excluded.queue_id,
           prospect_id = excluded.prospect_id`,
      )
      .run(
        c.receiptId,
        c.sequenceEventId,
        c.queueId,
        c.prospectId,
        c.transport,
        c.identity,
        c.recipient,
        c.subject,
        c.sentAt,
        rec.status,
        rec.expected,
        rec.observed,
        JSON.stringify(rec.messageIds),
        JSON.stringify(rec.deliveredAt),
        rec.checkedAt,
        rec.error,
      );
  }

  /** The check for one receipt, if any. */
  forReceipt(receiptId: number): SendDeliveryView | null {
    const row = this.db
      .query<CheckRow, [number]>(
        `SELECT ${CHECK_COLS} FROM send_delivery_checks c WHERE receipt_id = ?`,
      )
      .get(receiptId);
    return row ? toView(row) : null;
  }

  /**
   * The most telling check among several receipts (a queue row can hold more
   * than one): a mismatch wins over `ok`, the newest wins a tie.
   */
  forReceipts(receiptIds: ReadonlyArray<number>): SendDeliveryView | null {
    const ids = receiptIds.filter((n) => Number.isInteger(n));
    if (ids.length === 0) return null;
    const rows = this.db
      .query<CheckRow, number[]>(
        `SELECT ${CHECK_COLS} FROM send_delivery_checks c WHERE receipt_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);
    const best = rows.toSorted(
      (a, b) =>
        statusRank(b.status) - statusRank(a.status) || b.checked_at.localeCompare(a.checked_at),
    )[0];
    return best ? toView(best) : null;
  }

  /** The check for a sequence event (cadence step), if any. */
  forSequenceEvent(sequenceEventId: number): SendDeliveryView | null {
    const row = this.db
      .query<CheckRow, [number]>(
        `SELECT ${CHECK_COLS} FROM send_delivery_checks c WHERE sequence_event_id = ? ORDER BY checked_at DESC LIMIT 1`,
      )
      .get(sequenceEventId);
    return row ? toView(row) : null;
  }

  /** Every check against one prospect's sequence events, keyed `${playName}|${stepIndex}`. */
  forProspectSteps(prospectId: number): Map<string, SendDeliveryView> {
    const rows = this.db
      .query<CheckRow & { play_name: string; step_index: number }, [number]>(
        `SELECT ${CHECK_COLS}, se.play_name, se.step_index
           FROM send_delivery_checks c
           JOIN sequence_events se ON se.id = c.sequence_event_id
          WHERE se.prospect_id = ?
          ORDER BY c.checked_at`,
      )
      .all(prospectId);
    const out = new Map<string, SendDeliveryView>();
    for (const row of rows) out.set(`${row.play_name}|${row.step_index}`, toView(row));
    return out;
  }

  /** Duplicate and not-found results for sends recorded since `sinceIso`, newest first. */
  recentMismatches(sinceIso: string): DeliveryMismatch[] {
    const rows = this.db
      .query<CheckRow, [string]>(
        `SELECT ${CHECK_COLS} FROM send_delivery_checks c
          WHERE status IN ('duplicate', 'not_found') AND julianday(sent_at) >= julianday(?)
          ORDER BY sent_at DESC`,
      )
      .all(sinceIso);
    return rows.map((row) =>
      Object.assign(toView(row), {
        receiptId: row.receipt_id,
        queueId: row.queue_id,
        sequenceEventId: row.sequence_event_id,
        prospectId: row.prospect_id,
        recipient: row.recipient,
      }),
    );
  }
}

/** Which check speaks loudest when a row holds several: a mismatch beats a clean one. */
function statusRank(s: string): number {
  return s === "duplicate" ? 3 : s === "not_found" ? 2 : s === "ok" ? 1 : 0;
}
