import {
  autoReplyConfigOf,
  autoReplyHoldUntil,
  emailDomainOf,
  getLedger,
  isDeliveryNotice,
  loadConfig,
  logEvent,
  type AutoReplyReason,
  type AutoReplySuccessor,
  type OneShotConfig,
} from "@oneshot-gtm/core";
import { classifyAutoReply } from "@oneshot-gtm/intel";

type Ledger = ReturnType<typeof getLedger>;

/** Queue source of a row created from a "left the company" reply. */
export const SUCCESSOR_QUEUE_SOURCE = "auto-reply:successor";

/** The stored automatic reply being read. */
export interface AutoReplyRow {
  id: string;
  prospectId: number;
  fromEmail: string;
  subject: string | null;
  body: string | null;
  receivedAt: string;
  kind: string;
  /** The play the reply answers; the successor is queued on it. */
  playName: string | null;
}

/** What reading one automatic reply decided, and did (or would do, on a dry run). */
export interface AutoReplyOutcome {
  reason: AutoReplyReason;
  returnDate: string | null;
  successor: AutoReplySuccessor | null;
  classifier: string;
  /** Read before (the stored reading); nothing was done again. */
  stored: boolean;
  /** The time an out-of-office holds the next step until; null when no hold applies. */
  holdUntil: string | null;
  /** Active cadences held (or that would be). */
  held: number;
  /** Live cadences stopped (or that would be), when the caller asked for stops. */
  stopped: number;
  /** Why the named successor was not queued; null when queued or nobody was named. */
  successorSkip: string | null;
}

// Person-level fields of a queue payload: the successor is someone else, so
// none of the referrer's research, offer or contact details carry over.
const PERSON_KEYS = [
  "name",
  "firstName",
  "lastName",
  "email",
  "founderEmail",
  "emailOverride",
  "emailSource",
  "title",
  "role",
  "linkedinUrl",
  "linkedin_url",
  "twitterUrl",
  "xHandle",
  "githubUrl",
  "githubLogin",
  "sourceProfileUrl",
  "phone",
  "dossier",
  "research",
  "offer",
  "offerCandidates",
  "offerSkip",
  "angle",
  "angles",
  "fitReason",
  "personIcp",
  "icpVerdict",
];

/** Whether a mailbox message is a bounce notice the bounce poll reads instead. */
function isStoredBounce(ledger: Ledger, id: string): boolean {
  if (!id.startsWith("mailbox:")) return false;
  try {
    return (ledger.mailboxes.get(id)?.bounces?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** True for a DSN stored alongside replies: it has no reason, date or successor to read. */
export function isBounceNotice(
  ledger: Ledger,
  row: Pick<AutoReplyRow, "id" | "fromEmail" | "subject">,
) {
  return (
    isDeliveryNotice({ from: row.fromEmail, subject: row.subject }) ||
    isStoredBounce(ledger, row.id)
  );
}

/**
 * Stop every live cadence of a prospect with an honest terminal status
 * (`bounced` for a dead mailbox, `unsubscribed` for an opt-out), a sequence
 * event saying why, and (`holdReason`) the reason the /cadences badge shows.
 * Returns how many stopped.
 */
export function stopLiveCadences(
  ledger: Ledger,
  prospectId: number,
  input: {
    status: "bounced" | "unsubscribed";
    reason: string;
    bouncedAt?: string;
    holdReason?: string | null;
  },
): number {
  let stopped = 0;
  for (const cad of ledger.listCadencesForProspect(prospectId)) {
    if (cad.status !== "active" && cad.status !== "paused") continue;
    ledger.recordSequenceEvent({
      prospectId,
      playName: cad.play_name,
      stepIndex: cad.current_step,
      channel: "email",
      status: input.status,
      metadata: { reason: input.reason },
      // Occurrence time = when the notice landed, not poll time (same as the
      // DSN-bounce path), so the daily summary credits the right UTC day.
      ...(input.status === "bounced" && input.bouncedAt ? { bouncedAt: input.bouncedAt } : {}),
    });
    ledger.setCadenceStatus({ prospectId, playName: cad.play_name, status: input.status });
    if (input.holdReason) {
      ledger.setCadenceHoldReason({
        prospectId,
        playName: cad.play_name,
        reason: input.holdReason,
      });
    }
    stopped++;
  }
  return stopped;
}

/**
 * Queue the person a "left the company" reply names, as a pending row on the
 * same play, for the founder to review. Never approved here. Only someone at
 * the referrer's own company domain who is not already a prospect, queued,
 * or suppressed. The dedupe key (`email:<address>`) is the one finders use,
 * so a re-read or a later find never adds them twice.
 */
function queueSuccessor(
  ledger: Ledger,
  row: AutoReplyRow,
  successor: AutoReplySuccessor,
  write: boolean,
): { queueId: number | null; skip: string | null } {
  const email = successor.email?.trim().toLowerCase();
  if (!email) return { queueId: null, skip: "no address given" };
  const prospect = ledger.getProspectById(row.prospectId);
  const domain = emailDomainOf(prospect?.email ?? row.fromEmail);
  if (!domain || emailDomainOf(email) !== domain) {
    return { queueId: null, skip: "not at the same company domain" };
  }
  if (ledger.findProspectByEmail(email)) return { queueId: null, skip: "already a prospect" };
  if (ledger.isEmailPendingInQueue(email)) return { queueId: null, skip: "already queued" };
  if (ledger.suppressionFor(email) || ledger.contactSuppressionFor(email)) {
    return { queueId: null, skip: "address suppressed" };
  }
  const cadences = ledger.listCadencesForProspect(row.prospectId);
  const playName = row.playName ?? cadences[0]?.play_name ?? null;
  if (!playName) return { queueId: null, skip: "no play to queue on" };
  const dedupeKey = `email:${email}`;
  if (ledger.isQueueDuplicate(playName, dedupeKey))
    return { queueId: null, skip: "already queued" };
  if (!write) return { queueId: null, skip: null };

  // The company context of the referrer's own row (signal, site, play
  // fields) carries over; the person does not.
  const queueId = cadences.find((c) => c.play_name === playName)?.queue_id ?? null;
  let base: Record<string, unknown> = {};
  if (queueId != null) {
    try {
      const parsed: unknown = JSON.parse(ledger.getQueueRow(queueId)?.payload_json ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      base = {};
    }
  }
  for (const k of PERSON_KEYS) delete base[k];
  const referrer = prospect?.name?.trim() || prospect?.email || row.fromEmail;
  const company = prospect?.company ?? (base["company"] as string | undefined) ?? null;
  const payload = {
    ...base,
    email,
    ...(successor.name ? { name: successor.name } : {}),
    ...(company ? { company } : {}),
    referredBy: {
      prospectId: row.prospectId,
      name: prospect?.name ?? null,
      email: prospect?.email ?? row.fromEmail,
    },
  };
  const id = ledger.enqueueTarget({
    playName,
    payload,
    dedupeKey,
    source: SUCCESSOR_QUEUE_SOURCE,
    notes: `Named as the contact in ${referrer}'s "no longer here" auto-reply`,
  });
  return id == null ? { queueId: null, skip: "already queued" } : { queueId: id, skip: null };
}

/**
 * Read one stored automatic reply and act on it:
 * - `out_of_office`: every active cadence of the prospect waits until the
 *   return date plus `autoReply.oooBufferDays` (or `undatedDelayDays` from
 *   now), the due time only ever moving later.
 * - `left_company`: the named successor, at the same company domain, is
 *   queued for review (`autoReply.queueSuccessor`), and with `stop` every live
 *   cadence stops as bounced (`left-company`). The reply poll stops them
 *   itself, with its Slack notice.
 * - `other`: nothing.
 *
 * A reply already read is not read again unless `force` (the backfill). A
 * bounce notice is skipped (null). `write: false` decides without writing.
 */
export async function readAutoReply(
  row: AutoReplyRow,
  opts: { write: boolean; force?: boolean; stop?: boolean; now?: Date; cfg?: OneShotConfig },
): Promise<AutoReplyOutcome | null> {
  const ledger = getLedger();
  if (row.kind !== "auto" && row.kind !== "auto_permanent") return null;
  if (isBounceNotice(ledger, row)) return null;
  const now = opts.now ?? new Date();
  if (!opts.force) {
    const stored = ledger.getInboxReplyAutoClassification(row.id);
    if (stored) {
      return {
        reason: stored.reason as AutoReplyReason,
        returnDate: stored.returnDate,
        successor: stored.successor,
        classifier: "stored",
        stored: true,
        holdUntil: null,
        held: 0,
        stopped: 0,
        successorSkip: null,
      };
    }
  }
  const cfg = opts.cfg ?? loadConfig();
  const auto = autoReplyConfigOf(cfg);
  const facts = await classifyAutoReply(
    {
      kind: row.kind,
      subject: row.subject,
      body: row.body,
      fromEmail: row.fromEmail,
      receivedAt: row.receivedAt,
    },
    { cfg },
  );
  const out: AutoReplyOutcome = {
    ...facts,
    stored: false,
    holdUntil: null,
    held: 0,
    stopped: 0,
    successorSkip: null,
  };

  if (facts.reason === "out_of_office") {
    const until = autoReplyHoldUntil(facts, auto, now);
    // A return already past holds nothing (an old notice read by the backfill).
    if (until && Date.parse(until) > now.getTime()) {
      out.holdUntil = until;
      for (const cad of ledger.listCadencesForProspect(row.prospectId)) {
        if (cad.status !== "active") continue;
        if (
          !opts.write ||
          ledger.holdCadence({
            prospectId: row.prospectId,
            playName: cad.play_name,
            until,
            reason: "out-of-office",
            returnDate: facts.returnDate,
          })
        ) {
          out.held++;
        }
      }
    }
  }

  if (facts.reason === "left_company") {
    // A re-read (the backfill) keeps the row an earlier read queued.
    const prior = opts.force ? ledger.getInboxReplyAutoClassification(row.id)?.successor : null;
    if (
      facts.successor?.email &&
      prior?.queueId != null &&
      prior.email?.toLowerCase() === facts.successor.email.toLowerCase()
    ) {
      out.successor = { ...facts.successor, queueId: prior.queueId };
    } else if (facts.successor?.email && auto.queueSuccessor) {
      const queued = queueSuccessor(ledger, row, facts.successor, opts.write);
      out.successorSkip = queued.skip;
      if (queued.queueId != null) out.successor = { ...facts.successor, queueId: queued.queueId };
    } else if (facts.successor?.email) {
      out.successorSkip = "queueing successors is off";
    }
    if (opts.stop) {
      out.stopped = opts.write
        ? stopLiveCadences(ledger, row.prospectId, {
            status: "bounced",
            reason: "left-company",
            bouncedAt: row.receivedAt,
            holdReason: "left-company",
          })
        : ledger
            .listCadencesForProspect(row.prospectId)
            .filter((c) => c.status === "active" || c.status === "paused").length;
    }
  }

  if (opts.write) {
    ledger.setInboxReplyAutoClassification(row.id, {
      reason: out.reason,
      returnDate: out.returnDate,
      successor: out.successor,
      escalate: out.reason === "left_company",
    });
  }
  logEvent("reply.auto.classified", {
    reason: out.reason,
    classifier: out.classifier,
    dated: out.returnDate != null,
    held: out.held,
    successor_queued: out.successor?.queueId != null,
    write: opts.write,
  });
  return out;
}

/** One row of the backfill report. */
export interface ReclassifyAutoRow {
  kind: "reply" | "block";
  receivedAt: string;
  prospectId: number | null;
  email: string;
  company: string | null;
  reason: AutoReplyReason | "blocked";
  returnDate: string | null;
  successor: AutoReplySuccessor | null;
  successorSkip: string | null;
  /** What was done (or would be): "stop 1", "hold 2 until 2026-11-11", "none". */
  action: string;
}

/**
 * Read every automatic reply received since `sinceIso` again, with today's
 * rules and model, and act on each (hold, stop, queue a successor), plus
 * every policy-block bounce since then (stop, under `autoReply.stopOnBlock`).
 * With `write: false` nothing is written and the report says what would be
 * done. Bounce notices are skipped. Never sends anything.
 */
export async function reclassifyAutoReplies(opts: {
  sinceIso: string;
  write: boolean;
  now?: Date;
}): Promise<ReclassifyAutoRow[]> {
  const ledger = getLedger();
  const cfg = loadConfig();
  const now = opts.now ?? new Date();
  const rows: ReclassifyAutoRow[] = [];
  for (const r of ledger.listAutoRepliesSince(opts.sinceIso)) {
    const row: AutoReplyRow = {
      id: r.id,
      prospectId: r.prospect_id,
      fromEmail: r.from_email,
      subject: r.subject,
      body: r.body,
      receivedAt: r.received_at,
      kind: r.kind ?? "auto",
      playName: r.play_name,
    };
    const read = await readAutoReply(row, {
      write: opts.write,
      force: true,
      stop: true,
      now,
      cfg,
    });
    if (!read) continue;
    const prospect = ledger.getProspectById(r.prospect_id);
    const verb = opts.write ? "" : "would ";
    const action =
      read.reason === "left_company"
        ? read.stopped > 0
          ? `${verb}stop ${read.stopped}`
          : "none (no live cadence)"
        : read.reason === "out_of_office"
          ? read.holdUntil && read.held > 0
            ? `${verb}hold ${read.held} until ${read.holdUntil.slice(0, 10)}`
            : read.holdUntil
              ? "none (no active cadence)"
              : "none (already back)"
          : "none";
    rows.push({
      kind: "reply",
      receivedAt: r.received_at,
      prospectId: r.prospect_id,
      email: prospect?.email ?? r.from_email,
      company: prospect?.company ?? null,
      reason: read.reason,
      returnDate: read.returnDate,
      successor: read.successor,
      successorSkip: read.successorSkip,
      action:
        read.successor?.email && read.reason === "left_company" && read.successorSkip == null
          ? `${action} · ${
              read.successor.queueId != null
                ? `successor queued #${read.successor.queueId}`
                : `${verb}queue successor`
            }`
          : action,
    });
  }

  const auto = autoReplyConfigOf(cfg);
  for (const b of ledger.listBouncesSince({ kind: "block", sinceIso: opts.sinceIso })) {
    const prospectId = b.prospect_id ?? ledger.findProspectByEmail(b.recipient)?.id ?? null;
    const prospect = prospectId != null ? ledger.getProspectById(prospectId) : null;
    let stopped = 0;
    if (prospect && auto.stopOnBlock) {
      for (const cad of ledger.listCadencesForProspect(prospect.id)) {
        if (cad.status !== "active") continue;
        stopped++;
        if (!opts.write) continue;
        ledger.recordSequenceEvent({
          prospectId: prospect.id,
          playName: cad.play_name,
          stepIndex: cad.current_step,
          channel: "email",
          status: "bounced",
          metadata: { kind: "block", statusCode: b.status_code, reason: "blocked" },
          bouncedAt: b.bounced_at,
        });
        ledger.setCadenceStatus({
          prospectId: prospect.id,
          playName: cad.play_name,
          status: "bounced",
        });
        ledger.setCadenceHoldReason({
          prospectId: prospect.id,
          playName: cad.play_name,
          reason: "blocked",
        });
      }
    }
    rows.push({
      kind: "block",
      receivedAt: b.bounced_at,
      prospectId: prospect?.id ?? null,
      email: b.recipient,
      company: prospect?.company ?? null,
      reason: "blocked",
      returnDate: null,
      successor: null,
      successorSkip: null,
      action: !auto.stopOnBlock
        ? "none (stopOnBlock is off)"
        : stopped > 0
          ? `${opts.write ? "" : "would "}stop ${stopped}`
          : "none (no active cadence)",
    });
  }
  return rows;
}
