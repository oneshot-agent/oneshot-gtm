import type { EmailIdentity } from "./types.ts";
import { loadConfig } from "./config.ts";
import { gmailAccountFor, resolveIdentities } from "./identities.ts";
import { listGmailSentTo, type SentCopy } from "./gmail.ts";
import { mailboxConnection } from "./mailbox-config.ts";
import { mailboxClient } from "./mailbox.ts";
import { logEvent } from "./events.ts";
import type {
  DeliveryCandidate,
  DeliveryRecord,
  DeliveryStatus,
  SendDeliveryStore,
} from "./ledger-delivery.ts";

/**
 * Delivery check: for email sends on transports with no idempotency key
 * (Smartlead mailboxes, Gmail), count the copies the sending mailbox's Sent
 * folder actually holds. One recorded send can still reach the recipient
 * several times when the provider retries underneath us (a Smartlead
 * mailbox delivered one hand-off three times, 24-40 s apart), and nothing
 * else in the pipeline can see that. Read-only: it searches Sent, never sends.
 * OneShot sends are not checked; the platform dedupes them by idempotency key.
 */

/** A send younger than this is not checked yet: the provider queues before delivering. */
export const DELIVERY_MIN_AGE_MS = 4 * 60_000;
/** The sweep stops looking at sends older than this; the CLI can go further back. */
export const DELIVERY_MAX_AGE_MS = 48 * 60 * 60_000;
/** Copies are counted from this long before the recorded send... */
export const DELIVERY_WINDOW_BEFORE_MS = 2 * 60_000;
/** ...to this long after it. */
export const DELIVERY_WINDOW_AFTER_MS = 30 * 60_000;
/** Until the window has closed (plus a margin), only a duplicate is final. */
export const DELIVERY_FINAL_AFTER_MS = DELIVERY_WINDOW_AFTER_MS + 2 * 60_000;
/** Checks per sweep. */
export const DELIVERY_SWEEP_LIMIT = 25;

/** A mailbox read that may succeed later (network, auth hiccup): retried next sweep, not recorded. */
export class TransientDeliveryError extends Error {}
/** The mailbox can never be read for this send (identity removed, no credentials): recorded as skipped. */
export class PermanentDeliveryError extends Error {}

/** Reads the Sent copies to one recipient in a time window, for one identity. */
export type SentFolderReader = (input: {
  identity: EmailIdentity;
  recipient: string;
  afterIso: string;
  beforeIso: string;
}) => Promise<SentCopy[]>;

export interface DeliveryReaders {
  smartlead: SentFolderReader;
  gmail: SentFolderReader;
}

function normSubject(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface DeliveryVerdict {
  /** null = not final yet: leave unrecorded and look again later. */
  status: DeliveryStatus | null;
  observed: number;
  messageIds: string[];
  deliveredAt: string[];
}

/**
 * Count the copies of one send among Sent messages: same subject, inside
 * [sentAt − 2 min, sentAt + 30 min], one per Message-ID. More than one is a
 * duplicate at once; one or none is final only after the window has closed.
 */
export function evaluateDelivery(
  candidate: Pick<DeliveryCandidate, "subject" | "sentAt">,
  copies: ReadonlyArray<SentCopy>,
  nowMs: number,
): DeliveryVerdict {
  const sentMs = Date.parse(candidate.sentAt);
  const from = sentMs - DELIVERY_WINDOW_BEFORE_MS;
  const to = sentMs + DELIVERY_WINDOW_AFTER_MS;
  const subject = normSubject(candidate.subject);
  const seen = new Map<string, string>();
  for (const c of copies) {
    const at = Date.parse(c.date);
    if (!Number.isFinite(at) || at < from || at > to) continue;
    if (subject && normSubject(c.subject) !== subject) continue;
    const key = c.messageId.trim().toLowerCase() || `${c.date}|${c.subject}`;
    if (!seen.has(key)) seen.set(key, new Date(at).toISOString());
  }
  const entries = [...seen.entries()].toSorted((a, b) => a[1].localeCompare(b[1]));
  const observed = entries.length;
  const final = nowMs - sentMs >= DELIVERY_FINAL_AFTER_MS;
  const status: DeliveryStatus | null =
    observed > 1 ? "duplicate" : !final ? null : observed === 1 ? "ok" : "not_found";
  return {
    status,
    observed,
    messageIds: entries.map((e) => e[0]),
    deliveredAt: entries.map((e) => e[1]),
  };
}

/** Smartlead mailbox: IMAP Sent folder, opened read-only. */
export const imapSentReader: SentFolderReader = async ({
  identity,
  recipient,
  afterIso,
  beforeIso,
}) => {
  let connection;
  try {
    connection = await mailboxConnection(identity.id);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/no longer connected|missing from this workspace|unavailable/i.test(msg)) {
      throw new PermanentDeliveryError(msg);
    }
    throw new TransientDeliveryError(msg || "mailbox lookup failed");
  }
  const client = mailboxClient(connection);
  try {
    await client.connect();
    const boxes = await client.list();
    const sent =
      boxes.find((b) => b.specialUse === "\\Sent" && !b.flags.has("\\Noselect")) ??
      boxes.find((b) => /(^|\/)sent/i.test(b.path) && !b.flags.has("\\Noselect"));
    if (!sent) throw new PermanentDeliveryError("no Sent folder in this mailbox");
    await client.mailboxOpen(sent.path, { readOnly: true });
    const since = new Date(Date.parse(afterIso) - 24 * 60 * 60_000);
    const uids = await client.search({ to: recipient, since }, { uid: true });
    const copies: SentCopy[] = [];
    if (uids && uids.length > 0) {
      for await (const m of client.fetch(
        uids,
        { envelope: true, internalDate: true },
        { uid: true },
      )) {
        const date = m.internalDate instanceof Date ? m.internalDate : m.envelope?.date;
        if (!date) continue;
        const iso = new Date(date).toISOString();
        if (iso < afterIso || iso > beforeIso) continue;
        copies.push({
          messageId: m.envelope?.messageId ?? String(m.uid),
          date: iso,
          subject: m.envelope?.subject ?? "",
        });
      }
    }
    return copies;
  } catch (err) {
    if (err instanceof PermanentDeliveryError) throw err;
    throw new TransientDeliveryError((err as Error).message || "IMAP read failed");
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
};

/** Gmail identity: the API's Sent search, metadata only. */
export const gmailSentReader: SentFolderReader = async ({
  identity,
  recipient,
  afterIso,
  beforeIso,
}) => {
  const account = gmailAccountFor(identity);
  if (!account) throw new PermanentDeliveryError("no Gmail authorization for this identity");
  try {
    return await listGmailSentTo({ to: recipient, afterIso, beforeIso }, account);
  } catch (err) {
    throw new TransientDeliveryError((err as Error).message || "Gmail read failed");
  }
};

export const DEFAULT_DELIVERY_READERS: DeliveryReaders = {
  smartlead: imapSentReader,
  gmail: gmailSentReader,
};

export interface DeliveryCheckResult {
  candidate: DeliveryCandidate;
  /** `pending` = not final yet; `transient` = mailbox unreadable this time. Neither is recorded. */
  outcome: DeliveryStatus | "pending" | "transient";
  observed: number | null;
  deliveredAt: string[];
  error: string | null;
}

export interface DeliveryRunSummary {
  checked: number;
  ok: number;
  duplicate: number;
  notFound: number;
  skipped: number;
  pending: number;
  transient: number;
  results: DeliveryCheckResult[];
}

/**
 * Check a batch of sends. Each mailbox read is independent: one failure never
 * stops the rest. Final verdicts are recorded (unless `dryRun`); pending and
 * transient ones are left for the next run. A mismatch logs
 * `send.delivery_mismatch` with ids only, never message content.
 */
export async function runDeliveryChecks(opts: {
  store: Pick<SendDeliveryStore, "listCandidates" | "record">;
  nowMs?: number;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
  includeChecked?: boolean;
  dryRun?: boolean;
  deadlineAt?: number;
  readers?: DeliveryReaders;
  identities?: EmailIdentity[];
}): Promise<DeliveryRunSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const readers = opts.readers ?? DEFAULT_DELIVERY_READERS;
  const identities = opts.identities ?? resolveIdentities(loadConfig());
  const candidates = opts.store.listCandidates({
    sinceIso: opts.sinceIso ?? new Date(nowMs - DELIVERY_MAX_AGE_MS).toISOString(),
    untilIso: opts.untilIso ?? new Date(nowMs - DELIVERY_MIN_AGE_MS).toISOString(),
    limit: opts.limit ?? DELIVERY_SWEEP_LIMIT,
    ...(opts.includeChecked ? { includeChecked: true } : {}),
  });
  const summary: DeliveryRunSummary = {
    checked: 0,
    ok: 0,
    duplicate: 0,
    notFound: 0,
    skipped: 0,
    pending: 0,
    transient: 0,
    results: [],
  };
  for (const candidate of candidates) {
    if (opts.deadlineAt != null && Date.now() > opts.deadlineAt) break;
    summary.checked++;
    const sentMs = Date.parse(candidate.sentAt);
    const afterIso = new Date(sentMs - DELIVERY_WINDOW_BEFORE_MS).toISOString();
    const beforeIso = new Date(sentMs + DELIVERY_WINDOW_AFTER_MS).toISOString();
    const identity = identities.find((i) => i.id === candidate.identity);
    let record: DeliveryRecord | null = null;
    let result: DeliveryCheckResult;
    try {
      if (!identity) throw new PermanentDeliveryError("sender identity no longer configured");
      const copies = await readers[candidate.transport]({
        identity,
        recipient: candidate.recipient,
        afterIso,
        beforeIso,
      });
      const v = evaluateDelivery(candidate, copies, nowMs);
      result = {
        candidate,
        outcome: v.status ?? "pending",
        observed: v.observed,
        deliveredAt: v.deliveredAt,
        error: null,
      };
      if (v.status) {
        record = {
          candidate,
          status: v.status,
          expected: 1,
          observed: v.observed,
          messageIds: v.messageIds,
          deliveredAt: v.deliveredAt,
          checkedAt: new Date(nowMs).toISOString(),
          error: null,
        };
      }
    } catch (err) {
      const message = ((err as Error).message ?? "").slice(0, 200);
      if (err instanceof PermanentDeliveryError) {
        result = { candidate, outcome: "skipped", observed: null, deliveredAt: [], error: message };
        record = {
          candidate,
          status: "skipped",
          expected: 1,
          observed: null,
          messageIds: [],
          deliveredAt: [],
          checkedAt: new Date(nowMs).toISOString(),
          error: message,
        };
      } else {
        result = {
          candidate,
          outcome: "transient",
          observed: null,
          deliveredAt: [],
          error: message,
        };
      }
    }
    summary.results.push(result);
    if (result.outcome === "ok") summary.ok++;
    else if (result.outcome === "duplicate") summary.duplicate++;
    else if (result.outcome === "not_found") summary.notFound++;
    else if (result.outcome === "skipped") summary.skipped++;
    else if (result.outcome === "pending") summary.pending++;
    else summary.transient++;
    if (record && !opts.dryRun) {
      opts.store.record(record);
      if (record.status === "duplicate" || record.status === "not_found") {
        logEvent(
          "send.delivery_mismatch",
          {
            receipt_id: candidate.receiptId,
            queue_id: candidate.queueId,
            sequence_event_id: candidate.sequenceEventId,
            prospect_id: candidate.prospectId,
            transport: candidate.transport,
            identity: candidate.identity,
            status: record.status,
            expected: 1,
            observed: record.observed,
          },
          "warn",
        );
      }
    }
  }
  return summary;
}
