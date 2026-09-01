import {
  classifyReply,
  getLedger,
  hasAnySendCapacity,
  isSendDeferred,
  listBounces,
  listInbox,
  loadConfig,
  logEvent,
  parallelMap,
  cadenceGoalId,
  receiptUrlForId,
  sendEmail,
  sendSms,
  tagOutcomeValue,
  trackSend,
  voiceCall,
  type BounceKind,
  type ProspectRecord,
  describeTouch,
  recentTouchElsewhere,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import {
  firstNameFrom,
  humanizeDraft,
  lintEmail,
  signatureDirective,
  socialProofBlock,
} from "./_lib.ts";

export interface CadenceContext {
  prospect: ProspectRecord;
  cfg: ReturnType<typeof loadConfig>;
  metadata: Record<string, unknown>;
}

export type StepPayload =
  | { kind: "email"; subject: string; body: string }
  | { kind: "sms"; message: string; toPhone?: string }
  | {
      kind: "voice";
      objective: string;
      toPhone?: string;
      context?: string;
      maxDurationMinutes?: number;
    };

interface SequenceStep {
  /** Days after enrollment (step 0 was the original send). step 1 is the first follow-up. */
  dayOffset: number;
  channel: "email" | "sms" | "voice";
  /** When true, an inbound reply at any time stops the cadence. */
  breakOnReply: boolean;
  /** Builder returns null to skip this step gracefully. */
  builder: (ctx: CadenceContext) => Promise<StepPayload | null>;
  /** Optional label for logs. */
  label?: string;
}

export interface Sequence {
  playName: string;
  steps: SequenceStep[];
}

const playSequences = new Map<string, Sequence>();

export function registerSequence(seq: Sequence): void {
  playSequences.set(seq.playName, seq);
}

/** Single source of truth for the breakup-label substring check (isBreakupStepAt + /plays). */
export function isBreakupLabel(label: string | null | undefined): boolean {
  return Boolean(label && label.toLowerCase().includes("breakup"));
}

/**
 * A step is "the breakup" iff it sits at the END of the sequence AND has a
 * breakup label. Both clauses matter: the breakup-email prompt is reused as
 * accelerator-batch's only follow-up at index 0, which isn't semantically a
 * breakup.
 */
export function isBreakupStepAt(seq: Sequence, stepEntryIndex: number): boolean {
  if (stepEntryIndex !== seq.steps.length - 1) return false;
  return isBreakupLabel(seq.steps[stepEntryIndex]?.label);
}

export interface NextStepInfo {
  /** Label of the next step (e.g. "value follow-up", "breakup"). */
  label: string | null;
  /** True when the next step is the final breakup. */
  isBreakup: boolean;
  /** 1-based index of the next step within the follow-up steps array. */
  nextStepNumber: number;
}

/**
 * Number of follow-up steps registered for this play (excludes day-0).
 * Always the registered total regardless of current_step, so the UI's dot
 * count stays stable for completed cadences.
 */
export function playFollowupCount(playName: string): number {
  return effectiveSequence(playName)?.steps.length ?? 0;
}

/**
 * Describe the NEXT step scheduled to fire, or null at/past the last step.
 * Source of truth for both the server's CadenceView and the /cadences UI.
 */
export function nextStepInfo(playName: string, currentStep: number): NextStepInfo | null {
  const seq = effectiveSequence(playName);
  if (!seq) return null;
  const nextIndex = currentStep + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) return null;
  const step = seq.steps[stepEntryIndex];
  return {
    label: step?.label ?? null,
    isBreakup: isBreakupStepAt(seq, stepEntryIndex),
    nextStepNumber: nextIndex,
  };
}

export function getSequence(playName: string): Sequence | undefined {
  return effectiveSequence(playName);
}

/** The registered (code) sequence, ignoring any founder override. For "reset". */
export function defaultSequence(playName: string): Sequence | undefined {
  return playSequences.get(playName);
}

/**
 * The registered sequence with the founder's per-play timing overrides. Code
 * defines the structure; a matching-length `cadenceOverrides[playName]`
 * replaces each RELATIVE dayOffset. A length mismatch is ignored — code wins,
 * never throws. Read fresh each call so a /plays edit applies without restart.
 */
export function effectiveSequence(playName: string): Sequence | undefined {
  const base = playSequences.get(playName);
  if (!base) return undefined;
  const override = loadConfig().cadenceOverrides?.[playName];
  if (!Array.isArray(override) || override.length !== base.steps.length) return base;
  return {
    playName: base.playName,
    steps: base.steps.map((step, i) => ({
      dayOffset: override[i] as number,
      channel: step.channel,
      breakOnReply: step.breakOnReply,
      label: step.label,
      builder: step.builder,
    })),
  };
}

export function enrollInCadence(input: { prospectId: number; playName: string }): void {
  const seq = effectiveSequence(input.playName);
  if (!seq || seq.steps.length === 0) return;
  const next = seq.steps[0];
  if (!next) return;
  const dueAt = new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString();
  getLedger().enrollCadence({
    prospectId: input.prospectId,
    playName: input.playName,
    nextDueAt: dueAt,
  });
}

export interface AdvanceResult {
  polled: number;
  repliesDetected: number;
  stepsExecuted: number;
  breakups: number;
  completed: number;
  details: Array<{
    prospectEmail: string | null;
    playName: string;
    action: "step-sent" | "marked-replied" | "breakup" | "completed" | "waiting" | "skipped";
    note?: string;
    receiptIds: number[];
  }>;
}

export interface ReplyPollResult {
  /** Inbox emails examined. */
  polled: number;
  /**
   * Replies learned for the FIRST time this poll — the number the reply-rate
   * metrics move by, whatever state the cadence was in.
   */
  repliesDetected: number;
  /** Subset of the above that also stopped a still-active cadence. */
  cadencesStopped: number;
  /** Matched inbound mail classified as non-human (OOO / dead mailbox / unsubscribe) — stored, never counted as a reply. */
  autoRepliesSkipped: number;
  details: Array<{ prospectEmail: string; playName: string; subject: string }>;
}

/** poll_state key for the reply poll's high-water mark (newest received_at seen on a clean poll). */
const REPLY_WATERMARK_KEY = "inbox_replies";
/**
 * poll_state key for an unfinished catch-up slice (JSON `{ since, until }`),
 * drained by later polls — a backlog is delayed, never skipped.
 */
const REPLY_BACKLOG_KEY = "inbox_replies_backlog";
/**
 * Re-examine this much before the watermark every poll: Gmail's `after:` is
 * second-granular and delivery isn't strictly ordered. Recording is
 * idempotent, so overlap costs fetches, not correctness.
 */
const REPLY_WATERMARK_OVERLAP_MS = 60 * 60_000;
/** What the sources fall back to when no `since` is given (Gmail: `newer_than:30d`). */
const REPLY_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Page size per fetch — the same window the /inbox route uses. */
const REPLY_POLL_LIMIT = 200;
/**
 * Pages walked per poll before the rest is parked as backlog — bounds a single
 * poll after an install or outage; steady-state polls never fill one page.
 */
const REPLY_POLL_MAX_PAGES = 10;
/**
 * Background poll isn't latency-sensitive like the /inbox route, so it affords
 * a longer per-source deadline than the 15s default.
 */
const REPLY_POLL_DEADLINE_MS = 60_000;

interface WalkResult {
  newest: string | null;
  oldest: string | null;
  /** The whole (since, until) slice was examined — nothing older remains. */
  exhausted: boolean;
  /** No source failed on any page. A partial walk must not move any cursor. */
  clean: boolean;
  pagesUsed: number;
}

/**
 * Examine one (since, until) inbox slice newest-first, page by page, recording
 * replies. Each next-page bound is pushed one second LATER than the page's
 * oldest message so the boundary second is refetched, not skipped
 * (`before:`/`until` are exclusive at second granularity); `seen` de-dupes by
 * id across pages.
 */
async function walkInboxWindow(
  ledger: ReturnType<typeof getLedger>,
  out: ReplyPollResult,
  seen: Set<string>,
  opts: { since?: string; until?: string; pages: number; pageSize: number },
): Promise<WalkResult> {
  const res: WalkResult = {
    newest: null,
    oldest: null,
    exhausted: false,
    clean: true,
    pagesUsed: 0,
  };
  let until = opts.until;
  while (res.pagesUsed < opts.pages) {
    const inbox = await listInbox({
      limit: opts.pageSize,
      deadlineMs: REPLY_POLL_DEADLINE_MS,
      ...(opts.since ? { since: opts.since } : {}),
      ...(until ? { until } : {}),
    });
    res.pagesUsed++;
    if ((inbox.failed_sources ?? []).length > 0) res.clean = false;

    let fresh = 0;
    let pageOldest: string | null = null;
    for (const e of inbox.emails) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      fresh++;
      out.polled++;
      if (e.received_at) {
        if (res.newest == null || e.received_at > res.newest) res.newest = e.received_at;
        if (pageOldest == null || e.received_at < pageOldest) pageOldest = e.received_at;
      }
      const from = normalizeEmail(e.from);
      const prospect = ledger.findProspectByEmail(from);
      if (!prospect) continue;
      // Autoresponders (OOO, "no longer here") and unsubscribe requests are
      // NOT replies: they must not stop cadences as engagement, move the reply
      // metric, or tag RoCS. Classified here — the one choke point every
      // detection path funnels through.
      const kind = classifyReply({
        subject: e.subject,
        body: e.body,
        autoSubmitted: e.auto_submitted,
      });
      // Persist the full inbound (body included) — the ledger, not the mailbox,
      // is the reply store. Every matched email, not just the first reply per
      // (prospect, play): later replies on a live thread must be kept too.
      // Same thread key convention as inboxThreadKey (thread_id, else id).
      ledger.recordInboxReply({
        id: e.id,
        threadKey: e.thread_id ?? e.id,
        prospectId: prospect.id,
        playName: ledger.latestSentPlayForProspect(prospect.id, e.subject),
        fromEmail: from,
        subject: e.subject,
        body: e.body ?? "",
        receivedAt: e.received_at,
        sourceIdentityId: e.source_identity_id ?? null,
        threadId: e.thread_id ?? null,
        messageId: e.message_id ?? null,
        kind,
      });
      if (kind !== "human") {
        out.autoRepliesSkipped++;
        // A dead mailbox ("retired", "no longer at company") is a human-layer
        // hard bounce; an unsubscribe is a do-not-contact. Either way active
        // cadences stop — but with an honest status, no replied event, and no
        // bounces-table row (that would poison identity reputation stats).
        if (kind === "auto_permanent" || kind === "unsubscribe") {
          const status = kind === "unsubscribe" ? "unsubscribed" : "bounced";
          for (const cad of ledger.listCadencesForProspect(prospect.id)) {
            if (cad.status !== "active" && cad.status !== "paused") continue;
            ledger.recordSequenceEvent({
              prospectId: prospect.id,
              playName: cad.play_name,
              stepIndex: cad.current_step,
              channel: "email",
              status,
              metadata: { reason: kind === "unsubscribe" ? "unsubscribe" : "auto-reply-permanent" },
            });
            ledger.setCadenceStatus({ prospectId: prospect.id, playName: cad.play_name, status });
            out.cadencesStopped++;
          }
        }
        continue;
      }
      for (const r of ledger.recordProspectReply(prospect.id, { subject: e.subject })) {
        if (r.newlyReplied) out.cadencesStopped++;
        if (!r.eventRecorded) continue;
        out.repliesDetected++;
        out.details.push({ prospectEmail: from, playName: r.playName, subject: e.subject });
        // A reply is the first value signal — tag the play's send receipts so
        // RoCS reflects engagement. Best-effort (tagOutcomeValue swallows errors).
        await tagOutcomeValue({
          prospectId: prospect.id,
          playName: r.playName,
          valueTag: { type: "engagement", label: "reply" },
        });
      }
    }
    if (pageOldest && (res.oldest == null || pageOldest < res.oldest)) res.oldest = pageOldest;

    // Done when the sources say so, or when a page brought nothing new (a
    // page of already-seen boundary mail would otherwise loop forever).
    if (!inbox.has_more || fresh === 0 || !pageOldest) {
      res.exhausted = true;
      break;
    }
    until = new Date(new Date(pageOldest).getTime() + 1000).toISOString();
  }
  return res;
}

/**
 * Poll the inbox and record a reply wherever an inbound from-address matches a
 * prospect we emailed. Never drafts or sends, so it's safe on a background
 * timer as well as inside `advanceCadence`. Coverage guarantees: the window is
 * "since the last clean poll" (watermark + overlap), overflow is parked as
 * backlog (delayed, never dropped), and replies are recorded regardless of
 * cadence state so post-completion replies still count. `opts` exist for tests
 * and backfills; production callers pass none.
 */
export async function pollInboxReplies(opts?: {
  pageSize?: number;
  maxPages?: number;
}): Promise<ReplyPollResult> {
  const ledger = getLedger();
  const out: ReplyPollResult = {
    polled: 0,
    repliesDetected: 0,
    cadencesStopped: 0,
    autoRepliesSkipped: 0,
    details: [],
  };
  const pageSize = opts?.pageSize ?? REPLY_POLL_LIMIT;
  const maxPages = opts?.maxPages ?? REPLY_POLL_MAX_PAGES;
  const seen = new Set<string>();

  const mark = ledger.getPollWatermark(REPLY_WATERMARK_KEY);
  const since = mark
    ? new Date(new Date(mark).getTime() - REPLY_WATERMARK_OVERLAP_MS).toISOString()
    : undefined;

  // 1. The live window: everything since the last clean poll.
  const fwd = await walkInboxWindow(ledger, out, seen, {
    ...(since ? { since } : {}),
    pages: maxPages,
    pageSize,
  });

  // Advance the watermark only on a CLEAN walk. A partial result (one mailbox
  // timed out) leaves the mark where it was, so the next good poll re-covers
  // the gap instead of skipping past whatever the failed source would have had.
  if (fwd.newest && fwd.clean && (!mark || fwd.newest > mark)) {
    ledger.setPollWatermark(REPLY_WATERMARK_KEY, fwd.newest);
  }

  // 2. Backlog: whatever a walk couldn't reach within its page budget is
  //    parked as a (since, until) slice and drained by later polls.
  let backlog = readBacklog(ledger);
  if (!fwd.exhausted && fwd.clean && fwd.oldest) {
    const floor = since ?? new Date(Date.now() - REPLY_DEFAULT_WINDOW_MS).toISOString();
    // Widen rather than replace: re-examining an overlap is free, skipping is not.
    backlog = backlog
      ? {
          since: backlog.since < floor ? backlog.since : floor,
          until: backlog.until > fwd.oldest ? backlog.until : fwd.oldest,
        }
      : { since: floor, until: fwd.oldest };
    ledger.setPollWatermark(REPLY_BACKLOG_KEY, JSON.stringify(backlog));
    logEvent(
      "inbox.reply_poll.backlog_parked",
      { since: backlog.since, until: backlog.until },
      "warn",
    );
  }
  const budget = maxPages - fwd.pagesUsed;
  if (backlog && budget > 0) {
    const back = await walkInboxWindow(ledger, out, seen, { ...backlog, pages: budget, pageSize });
    if (back.clean) {
      if (back.exhausted) {
        ledger.setPollWatermark(REPLY_BACKLOG_KEY, "");
        logEvent("inbox.reply_poll.backlog_drained", {
          since: backlog.since,
          until: backlog.until,
        });
      } else if (back.oldest) {
        ledger.setPollWatermark(
          REPLY_BACKLOG_KEY,
          JSON.stringify({ ...backlog, until: back.oldest }),
        );
      }
    }
  }
  return out;
}

function readBacklog(
  ledger: ReturnType<typeof getLedger>,
): { since: string; until: string } | null {
  const raw = ledger.getPollWatermark(REPLY_BACKLOG_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { since?: unknown; until?: unknown };
    return typeof v.since === "string" && typeof v.until === "string"
      ? { since: v.since, until: v.until }
      : null;
  } catch {
    return null;
  }
}

export interface BouncePollResult {
  /** Delivery failures parsed from the mailbox this poll (including already-known ones). */
  polled: number;
  /** Failures seen for the FIRST time — the ones that were acted on. */
  recorded: number;
  /** Cadences stopped by a hard bounce this poll. */
  cadencesStopped: number;
  details: Array<{
    recipient: string;
    kind: BounceKind;
    statusCode: string | null;
    playName: string | null;
  }>;
}

/**
 * Poll the mailbox for DSNs and act on them. Sibling to pollInboxReplies:
 * read-only except for the bounce row and the resulting cadence stop, so it's
 * safe on a background timer as well as inside advanceCadence.
 */
export async function pollInboxBounces(): Promise<BouncePollResult> {
  const ledger = getLedger();
  const out: BouncePollResult = { polled: 0, recorded: 0, cadencesStopped: 0, details: [] };
  const bounces = await listBounces();
  out.polled = bounces.length;

  for (const b of bounces) {
    const prospect = ledger.findProspectByEmail(b.recipient);
    const isNew = ledger.recordBounce({
      messageId: b.messageId,
      recipient: b.recipient,
      identityId: b.identityId,
      kind: b.kind,
      statusCode: b.statusCode,
      diagnostic: b.diagnostic,
      prospectId: prospect?.id ?? null,
      bouncedAt: b.bouncedAt,
    });
    // The sweep re-reads a 30-day window every tick, so most of what comes back
    // was handled days ago. Acting only on first sight keeps the cadence writes
    // and event log from repeating forever.
    if (!isNew) continue;
    out.recorded++;

    // Soft = transient (mailbox full, greylisted). Stored for context, but it
    // says nothing durable about the address or our reputation.
    if (b.kind === "soft") continue;

    if (!prospect) {
      // A bounce for an address we don't track — still counts toward the
      // identity's rate, which is the number that matters for reputation.
      out.details.push({
        recipient: b.recipient,
        kind: b.kind,
        statusCode: b.statusCode,
        playName: null,
      });
      continue;
    }

    for (const cad of ledger.listCadencesForProspect(prospect.id)) {
      // current_step is the most recently SENT step (intro = 0; each follow-up
      // is recorded at current_step + 1 as it fires) — that's the touch that
      // came back undelivered.
      ledger.recordSequenceEvent({
        prospectId: prospect.id,
        playName: cad.play_name,
        stepIndex: cad.current_step,
        channel: "email",
        status: "bounced",
        metadata: {
          kind: b.kind,
          statusCode: b.statusCode,
          diagnostic: b.diagnostic,
          identityId: b.identityId,
        },
      });
      // Only a HARD bounce stops the sequence — a 5.7.x block judges the
      // message/domain, not the mailbox (blocks surface via the doctor check).
      // Only `active` rows flip: a `replied` cadence proved the human is there.
      if (b.kind === "hard" && cad.status === "active") {
        ledger.setCadenceStatus({
          prospectId: prospect.id,
          playName: cad.play_name,
          status: "bounced",
        });
        out.cadencesStopped++;
      }
      out.details.push({
        recipient: b.recipient,
        kind: b.kind,
        statusCode: b.statusCode,
        playName: cad.play_name,
      });
    }
  }

  if (out.recorded > 0) {
    logEvent("bounce.poll.done", {
      polled: out.polled,
      recorded: out.recorded,
      cadences_stopped: out.cadencesStopped,
    });
  }
  return out;
}

export async function advanceCadence(
  opts: { dryRun: boolean } = { dryRun: false },
): Promise<AdvanceResult> {
  const ledger = getLedger();
  const result: AdvanceResult = {
    polled: 0,
    repliesDetected: 0,
    stepsExecuted: 0,
    breakups: 0,
    completed: 0,
    details: [],
  };

  // 1. Poll inbox for new replies, mark cadences as replied where we recognize the from-address.
  if (!opts.dryRun) {
    try {
      const poll = await pollInboxReplies();
      result.polled = poll.polled;
      result.repliesDetected = poll.repliesDetected;
      for (const d of poll.details) {
        result.details.push({
          prospectEmail: d.prospectEmail,
          playName: d.playName,
          action: "marked-replied",
          note: `inbound: ${d.subject}`,
          receiptIds: [],
        });
      }
    } catch (err) {
      result.details.push({
        prospectEmail: null,
        playName: "(poll)",
        action: "skipped",
        note: `inbox poll failed: ${(err as Error).message}`,
        receiptIds: [],
      });
    }

    // 1b. Poll for delivery failures. Runs BEFORE the due-step loop below so a
    // bounce detected this pass stops today's follow-up rather than next
    // pass's — otherwise we'd send one more email to a known-dead address.
    try {
      const bouncePoll = await pollInboxBounces();
      for (const d of bouncePoll.details) {
        result.details.push({
          prospectEmail: d.recipient,
          playName: d.playName ?? "(bounce)",
          action: "skipped",
          note: `bounced${d.statusCode ? ` ${d.statusCode}` : ""} (${d.kind})`,
          receiptIds: [],
        });
      }
    } catch (err) {
      result.details.push({
        prospectEmail: null,
        playName: "(bounce-poll)",
        action: "skipped",
        note: `bounce poll failed: ${(err as Error).message}`,
        receiptIds: [],
      });
    }
  }

  // 2. For each active cadence with next_due_at <= now, execute the next step.
  // Concurrency 3 is safe: `due` rows are distinct (prospect, play) pairs, so
  // no shared-write contention. Results are collected in input order.
  const nowIso = new Date().toISOString();
  const due = ledger.listActiveCadences({ dueByIso: nowIso });

  // Capacity gate BEFORE drafting: when every sender identity is at its daily
  // cap, a step would burn an LLM draft and then fail the send anyway. Steps
  // stay due; tomorrow's poll picks them up with fresh capacity.
  if (!opts.dryRun && due.length > 0 && !hasAnySendCapacity()) {
    for (const cad of due) {
      result.details.push({
        prospectEmail: cad.prospect_email,
        playName: cad.play_name,
        action: "skipped",
        note: "deferred: daily send caps reached",
        receiptIds: [],
      });
    }
    return result;
  }

  const outs = await parallelMap(due, 3, async (cad): Promise<RunCadenceStepResult> => {
    // The claim is the worker's first synchronous operation, before any await.
    // Rows waiting for a concurrency slot remain stoppable; once a worker
    // starts, Stop and dispatch serialize through this marker. If Stop won,
    // the runner re-reads the terminal status and skips.
    const claimed =
      !opts.dryRun &&
      ledger.claimCadenceSendingMarker({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        startedAtIso: nowIso,
      });
    if (!opts.dryRun && !claimed) {
      return {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: "cadence changed or is already sending",
      };
    }
    try {
      return await runCadenceStepForProspect({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        dryRun: opts.dryRun,
      });
    } catch (err) {
      // Deferral mid-pass (caps filled while this batch ran): the step simply
      // stays due. Anything else propagates — parallelMap rejects the whole
      // pass, matching pre-rotation behavior for unexpected errors.
      if (isSendDeferred(err)) {
        return {
          action: "skipped",
          payload: null,
          receiptIds: [],
          note: "deferred: daily send caps reached",
        };
      }
      throw err;
    } finally {
      if (claimed) {
        // Success usually clears through advanceCadence; skips, deferrals and
        // failures land here. Clearing twice is harmless.
        ledger.clearCadenceSendingMarker({
          prospectId: cad.prospect_id,
          playName: cad.play_name,
        });
      }
    }
  });

  for (let i = 0; i < due.length; i++) {
    const cad = due[i]!;
    const out = outs[i]!;
    result.details.push({
      prospectEmail: cad.prospect_email,
      playName: cad.play_name,
      action: out.action,
      ...(out.note ? { note: out.note } : {}),
      receiptIds: out.receiptIds,
    });
    if (out.action === "step-sent") result.stepsExecuted++;
    else if (out.action === "breakup") result.breakups++;
    else if (out.action === "completed") result.completed++;
  }

  return result;
}

export interface RunCadenceStepOptions {
  prospectId: number;
  playName: string;
  dryRun: boolean;
  /** Skip the step's builder and send this verbatim (mirrors /queue's
      send-this-one — used by the /cadences UI after a Preview round-trip). */
  persistedPayload?: StepPayload;
}

export interface RunCadenceStepResult {
  action: AdvanceResult["details"][number]["action"];
  payload: StepPayload | null;
  receiptIds: number[];
  note?: string;
}

/**
 * Per-prospect cadence step runner — single source of truth for the batch
 * `advanceCadence` and the per-row /cadences UI. On a successful send,
 * advances `current_step`, sets `next_due_at`, and clears any persisted
 * preview draft via ledger.advanceCadence.
 */
export async function runCadenceStepForProspect(
  opts: RunCadenceStepOptions,
): Promise<RunCadenceStepResult> {
  const ledger = getLedger();
  const cfg = loadConfig();
  const cadence = ledger.getCadence(opts.prospectId, opts.playName);
  if (!cadence) {
    return { action: "skipped", payload: null, receiptIds: [], note: "no cadence" };
  }
  if (cadence.status !== "active") {
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: `cadence is ${cadence.status}`,
    };
  }
  // Suppression check ahead of drafting: sendEmail would refuse anyway, but
  // only after paying for a draft, and its throw would misreport a permanent
  // failure as "send failed · retrying".
  if (cadence.prospect_email) {
    const suppression = ledger.suppressionFor(cadence.prospect_email);
    if (suppression) {
      ledger.setCadenceStatus({
        prospectId: opts.prospectId,
        playName: opts.playName,
        status: "bounced",
      });
      return {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: `suppressed: hard-bounced${suppression.status_code ? ` ${suppression.status_code}` : ""}`,
      };
    }
    // Reply-stream do-not-send (unsubscribe / dead-mailbox autoresponder):
    // same shape as the bounce check — stop before paying for a draft, and
    // record an honest terminal status instead of a send failure.
    const contactStop = ledger.contactSuppressionFor(cadence.prospect_email);
    if (contactStop) {
      const status = contactStop.kind === "unsubscribe" ? "unsubscribed" : "bounced";
      ledger.setCadenceStatus({ prospectId: opts.prospectId, playName: opts.playName, status });
      return {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: `suppressed: ${contactStop.kind === "unsubscribe" ? "asked not to be contacted" : "mailbox reported dead"}`,
      };
    }
  }
  // Person-level ICP gate: an off-ICP prospect must not receive follow-ups.
  // Code-level on purpose — a prompt can be talked out of a rule, a status
  // change cannot. Terminal + distinct ("off-icp") so reporting stays honest.
  {
    const prospect = ledger.getProspectById(opts.prospectId);
    if (prospect?.icp_verdict === "reject") {
      ledger.setCadenceStatus({
        prospectId: opts.prospectId,
        playName: opts.playName,
        status: "off-icp",
      });
      return {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: `off-ICP: ${prospect.icp_verdict_reason ?? "role does not fit"}`,
      };
    }
  }
  // Cross-workspace hold, same reasoning as the suppression check above:
  // decide before paying for a draft. Not a status change — the step stays
  // due and fires once the other workspace's touch ages out of the window.
  if (cadence.prospect_email) {
    const elsewhere = recentTouchElsewhere(cadence.prospect_email);
    if (elsewhere) {
      logEvent("cadence.step.held_elsewhere", {
        play: opts.playName,
        other_workspace: elsewhere.workspace,
        other_play: elsewhere.play_name,
      });
      return {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: `held: ${describeTouch(elsewhere)} — retries after the 7-day window`,
      };
    }
  }
  const seq = effectiveSequence(opts.playName);
  if (!seq) {
    return { action: "skipped", payload: null, receiptIds: [], note: "no registered sequence" };
  }
  const nextIndex = cadence.current_step + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) {
    ledger.setCadenceStatus({
      prospectId: opts.prospectId,
      playName: opts.playName,
      status: "completed",
    });
    return { action: "completed", payload: null, receiptIds: [] };
  }
  const step = seq.steps[stepEntryIndex];
  if (!step) return { action: "skipped", payload: null, receiptIds: [] };

  // Re-send guard. `current_step` advances only AFTER a successful send, so a
  // crash between dispatch and `advanceCadence` can leave a sent step behind —
  // and the SDK idempotency key is content-keyed, not step-keyed, so a redraft
  // would send a real duplicate. If the step already has a sent event,
  // reconcile forward WITHOUT re-sending, running the SAME terminal transition
  // a successful send would. Skipped on dryRun so a preview never advances a
  // real cadence.
  if (!opts.dryRun && ledger.hasSentSequenceEvent(opts.prospectId, opts.playName, nextIndex)) {
    logEvent(
      "cadence.step.reconciled_already_sent",
      { prospect_id: opts.prospectId, play_name: opts.playName, step_index: nextIndex },
      "warn",
    );
    if (isBreakupStepAt(seq, stepEntryIndex)) {
      ledger.setCadenceStatus({
        prospectId: opts.prospectId,
        playName: opts.playName,
        status: "breakup",
      });
      return {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: `step ${nextIndex} already sent — reconciled (breakup)`,
      };
    }
    const next = seq.steps[stepEntryIndex + 1];
    ledger.advanceCadence({
      prospectId: opts.prospectId,
      playName: opts.playName,
      newStep: nextIndex,
      nextDueAt: next
        ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString()
        : null,
    });
    if (!next) {
      ledger.setCadenceStatus({
        prospectId: opts.prospectId,
        playName: opts.playName,
        status: "completed",
      });
    }
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: `step ${nextIndex} already sent — reconciled (advanced without re-send)`,
    };
  }

  const prospect = loadProspect(opts.prospectId);
  if (!prospect) {
    return { action: "skipped", payload: null, receiptIds: [], note: "prospect not found" };
  }

  const built: StepPayload | null = opts.persistedPayload
    ? opts.persistedPayload
    : await step.builder({ prospect, cfg, metadata: {} });

  if (!built) {
    const next = seq.steps[stepEntryIndex + 1];
    ledger.advanceCadence({
      prospectId: opts.prospectId,
      playName: opts.playName,
      newStep: nextIndex,
      nextDueAt: next
        ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString()
        : null,
    });
    if (!next) {
      ledger.setCadenceStatus({
        prospectId: opts.prospectId,
        playName: opts.playName,
        status: "completed",
      });
      return {
        action: "completed",
        payload: null,
        receiptIds: [],
        note: step.label ?? `step ${nextIndex} builder returned null`,
      };
    }
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: step.label ?? `step ${nextIndex} builder returned null`,
    };
  }

  const receiptIds: number[] = [];
  if (!opts.dryRun) {
    // Single send convergence point for every path. A hard send failure is
    // persisted so /cadences can show "send failed · retrying" instead of an
    // indistinguishable "overdue"; cleared on the next successful advance.
    let channelOutcome: Awaited<ReturnType<typeof dispatchStep>>;
    try {
      channelOutcome = await dispatchStep({
        playName: opts.playName,
        prospectId: opts.prospectId,
        prospectEmail: cadence.prospect_email,
        stepIndex: nextIndex,
        step,
        payload: built,
        ...(step.label !== undefined ? { label: step.label } : {}),
      });
    } catch (err) {
      // A daily-cap deferral isn't a failure — the step stays due for
      // tomorrow. Only genuine send errors are recorded.
      if (!isSendDeferred(err)) {
        ledger.recordCadenceSendError({
          prospectId: opts.prospectId,
          playName: opts.playName,
          error: (err as Error)?.message ?? "send failed",
        });
      }
      throw err;
    }
    if (channelOutcome.skipReason) {
      return {
        action: "skipped",
        payload: built,
        receiptIds: [],
        note: channelOutcome.skipReason,
      };
    }
    receiptIds.push(...channelOutcome.receiptIds);
  }

  if (isBreakupStepAt(seq, stepEntryIndex)) {
    ledger.setCadenceStatus({
      prospectId: opts.prospectId,
      playName: opts.playName,
      status: "breakup",
    });
    return {
      action: "breakup",
      payload: built,
      receiptIds,
      note: step.label ?? `step ${nextIndex}`,
    };
  }
  const next = seq.steps[stepEntryIndex + 1];
  ledger.advanceCadence({
    prospectId: opts.prospectId,
    playName: opts.playName,
    newStep: nextIndex,
    nextDueAt: next ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString() : null,
  });
  if (!next) {
    ledger.setCadenceStatus({
      prospectId: opts.prospectId,
      playName: opts.playName,
      status: "completed",
    });
  }
  return {
    action: "step-sent",
    payload: built,
    receiptIds,
    note: step.label ?? `step ${nextIndex}`,
  };
}

export interface CadenceStepPreview {
  subject: string;
  body: string;
  flags: string[];
  payload: StepPayload;
  draftedAt: string;
  stepLabel: string | null;
  isBreakup: boolean;
}

/**
 * Build the next step's draft and persist it via setCadenceDraft. Never
 * sends. Mirrors the /queue regenerate route — the founder reviews on
 * /cadences, then clicks Send next which calls sendCadenceStep.
 */
export async function previewCadenceStep(input: {
  prospectId: number;
  playName: string;
}): Promise<CadenceStepPreview> {
  const ledger = getLedger();
  const cfg = loadConfig();
  const cadence = ledger.getCadence(input.prospectId, input.playName);
  if (!cadence) throw new Error("no cadence for that prospect+play");
  if (cadence.status !== "active") {
    throw new Error(`cadence is ${cadence.status}, can only preview an active cadence`);
  }
  const seq = effectiveSequence(input.playName);
  if (!seq) throw new Error(`no registered sequence for play '${input.playName}'`);
  const nextIndex = cadence.current_step + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) {
    throw new Error("no next step (cadence is at or past the last step)");
  }
  const step = seq.steps[stepEntryIndex];
  if (!step) throw new Error("step undefined");
  const prospect = loadProspect(input.prospectId);
  if (!prospect) throw new Error("prospect not found");
  const built = await step.builder({ prospect, cfg, metadata: {} });
  if (!built) throw new Error("builder returned null — nothing to preview");

  const subject = built.kind === "email" ? built.subject : "(non-email step)";
  const body =
    built.kind === "email"
      ? built.body
      : built.kind === "sms"
        ? built.message
        : built.kind === "voice"
          ? built.objective
          : "";
  const flags = built.kind === "email" ? lintEmail(subject, body, 100) : [];
  ledger.setCadenceDraft({
    prospectId: input.prospectId,
    playName: input.playName,
    draft: { subject, body, flags, payload: built },
  });
  const draft = ledger.getCadenceDraft({
    prospectId: input.prospectId,
    playName: input.playName,
  });
  const draftedAt = draft?.draftedAt ?? new Date().toISOString();
  return {
    subject,
    body,
    flags,
    payload: built,
    draftedAt,
    stepLabel: step.label ?? null,
    isBreakup: isBreakupStepAt(seq, stepEntryIndex),
  };
}

/**
 * Send a previously-previewed cadence step verbatim (throws if none
 * persisted). The advance clears the draft so a later Preview rebuilds
 * against the new current_step.
 */
export async function sendCadenceStep(input: {
  prospectId: number;
  playName: string;
}): Promise<RunCadenceStepResult> {
  const ledger = getLedger();
  const draft = ledger.getCadenceDraft(input);
  if (!draft) throw new Error("no persisted preview — click Preview first");
  return runCadenceStepForProspect({
    prospectId: input.prospectId,
    playName: input.playName,
    dryRun: false,
    persistedPayload: draft.payload as StepPayload,
  });
}

export interface BatchItem {
  prospectId: number;
  playName: string;
}

interface BatchPreviewResult {
  prospectId: number;
  playName: string;
  ok: boolean;
  preview?: CadenceStepPreview;
  error?: string;
}

export interface BatchSendResult {
  prospectId: number;
  playName: string;
  ok: boolean;
  action?: RunCadenceStepResult["action"];
  receiptIds?: number[];
  error?: string;
}

/**
 * Parallel preview of cadence rows (concurrency 3). Per-prospect failures are
 * captured in the result array — the batch never throws. `parallelMap`
 * preserves input order so the result matches `items` 1:1.
 */
export async function previewCadenceStepBatch(items: BatchItem[]): Promise<BatchPreviewResult[]> {
  return parallelMap(items, 3, async (item) => {
    try {
      const preview = await previewCadenceStep(item);
      return { prospectId: item.prospectId, playName: item.playName, ok: true, preview };
    } catch (err) {
      return {
        prospectId: item.prospectId,
        playName: item.playName,
        ok: false,
        error: ((err as Error)?.message ?? "preview failed").slice(0, 120),
      };
    }
  });
}

/**
 * Serial send of previewed cadence rows; per-prospect failures are captured,
 * the batch never throws. Run as a background promise by
 * `POST /api/cadences/send-batch` (202 + refetch-driven progress). Sends stay
 * serial: `onItemSettled` drives the per-row in-flight badge, and parallel
 * SMTP to the same domain risks soft-bounces.
 */
export async function sendCadenceStepBatch(
  items: BatchItem[],
  /** Fires after each item resolves (ok OR error) — lets the API layer
   *  track per-row in-flight state without splitting the iteration. */
  onItemSettled?: (item: BatchItem, result: BatchSendResult) => void,
): Promise<BatchSendResult[]> {
  const out: BatchSendResult[] = [];
  for (const item of items) {
    let result: BatchSendResult;
    try {
      const r = await sendCadenceStep(item);
      result = {
        prospectId: item.prospectId,
        playName: item.playName,
        ok: true,
        action: r.action,
        receiptIds: r.receiptIds,
      };
    } catch (err) {
      result = {
        prospectId: item.prospectId,
        playName: item.playName,
        ok: false,
        error: ((err as Error)?.message ?? "send failed").slice(0, 120),
      };
    }
    out.push(result);
    onItemSettled?.(item, result);
  }
  return out;
}

function dispatchStep(
  input: Parameters<typeof dispatchStepImpl>[0],
): ReturnType<typeof dispatchStepImpl> {
  // Count the whole dispatch as one in-flight send so a graceful shutdown
  // drains it (SDK call + its sequence_events write) before the process exits.
  return trackSend(() => dispatchStepImpl(input));
}

async function dispatchStepImpl(input: {
  playName: string;
  prospectId: number;
  prospectEmail: string | null;
  stepIndex: number;
  step: SequenceStep;
  payload: StepPayload;
  label?: string | undefined;
}): Promise<{ receiptIds: number[]; skipReason?: string }> {
  const ledger = getLedger();
  const receiptIds: number[] = [];

  // Per-step audit envelope: same shape across all channels so receipts can
  // be grouped/filtered by (prospectId, stepIndex, label) on the OneShot side.
  const cadenceAudit = {
    source: "cadence" as const,
    prospectId: input.prospectId,
    prospectEmail: input.prospectEmail,
    stepIndex: input.stepIndex,
    label: input.label ?? null,
    // Cadence correlation key — groups every step's receipts under one goal so an
    // outcome tags the whole sequence at once. Same key the tagger derives from
    // (prospect, play) at outcome time.
    goalId: cadenceGoalId(input.playName, input.prospectEmail ?? `pid:${input.prospectId}`),
  };
  const labelTail = input.label ? ` ${input.label}` : "";

  if (input.payload.kind === "email") {
    if (!input.prospectEmail) return { receiptIds, skipReason: "prospect has no email" };
    const send = await sendEmail(
      { to: input.prospectEmail, subject: input.payload.subject, body: input.payload.body },
      {
        playName: input.playName,
        memo: `${input.playName} step ${input.stepIndex}${labelTail} → ${input.prospectEmail}`,
        decisionContext: { ...cadenceAudit, subject: input.payload.subject },
      },
    );
    receiptIds.push(send.receiptId);
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "email",
      status: "sent",
      receiptId: send.receiptId,
      metadata: {
        subject: input.payload.subject,
        body: input.payload.body,
        label: input.label,
      },
    });
    return { receiptIds };
  }

  if (input.payload.kind === "sms") {
    if (!input.payload.toPhone) {
      return { receiptIds, skipReason: "prospect has no phone for SMS" };
    }
    const send = await sendSms(
      { to: input.payload.toPhone, message: input.payload.message },
      {
        playName: input.playName,
        memo: `${input.playName} step ${input.stepIndex}${labelTail} SMS → ${input.payload.toPhone}`,
        decisionContext: { ...cadenceAudit, toPhone: input.payload.toPhone },
      },
    );
    receiptIds.push(send.receiptId);
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "sms",
      status: "sent",
      receiptId: send.receiptId,
      metadata: { label: input.label },
    });
    return { receiptIds };
  }

  if (input.payload.kind === "voice") {
    if (!input.payload.toPhone) {
      return { receiptIds, skipReason: "prospect has no phone for voice" };
    }
    const call = await voiceCall(
      {
        objective: input.payload.objective,
        to: input.payload.toPhone,
        ...(input.payload.context ? { context: input.payload.context } : {}),
        ...(input.payload.maxDurationMinutes
          ? { maxDurationMinutes: input.payload.maxDurationMinutes }
          : {}),
      },
      {
        playName: input.playName,
        memo: `${input.playName} step ${input.stepIndex}${labelTail} voice → ${input.payload.toPhone}`,
        decisionContext: {
          ...cadenceAudit,
          toPhone: input.payload.toPhone,
          objective: input.payload.objective.slice(0, 120),
        },
      },
    );
    receiptIds.push(call.receiptId);
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "voice",
      status: "sent",
      receiptId: call.receiptId,
      metadata: { label: input.label, ended_reason: call.result.ended_reason ?? null },
    });
    return { receiptIds };
  }

  return { receiptIds, skipReason: "unknown step payload kind" };
}

function normalizeEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1]! : raw).trim().toLowerCase();
}

function loadProspect(id: number): ProspectRecord | null {
  return getLedger().getProspectById(id);
}

export function buildFollowUpEmail(opts: {
  playName: string;
  promptName: string;
  contextLines: string[];
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const system = loadPrompt(opts.promptName) + signatureDirective();
    const priorBlock = buildPriorEmailsBlock(ctx.prospect.id, opts.playName);
    const proofBlock = socialProofBlock();
    // Optional first-name field: prompt rule lets the LLM occasionally open
    // with "Hey {firstName},". Absent when name is null / (unknown) / handle.
    const firstName = firstNameFrom(ctx.prospect.name);
    const user = [
      `FOUNDER: ${ctx.cfg.founderName}`,
      `PRODUCT: ${ctx.cfg.productOneLiner}`,
      `PROSPECT: ${ctx.prospect.name ?? "(unknown)"}`,
      `EMAIL: ${ctx.prospect.email ?? ""}`,
      `COMPANY: ${ctx.prospect.company ?? "(unknown)"}`,
      ...opts.contextLines,
      ...(priorBlock ? ["", priorBlock] : []),
      ...(proofBlock ? ["", proofBlock] : []),
      ...(firstName ? ["", `PROSPECT_FIRST_NAME: ${firstName}`] : []),
    ].join("\n");
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.6,
      maxTokens: 500,
    });
    const parsed = tryParseJsonObject<{ subject?: string; body?: string }>(res.content, {});
    if (!parsed.subject || !parsed.body) return null;
    // Same deterministic humanization the initial-send plays get via
    // draftEmailFromPrompt — without it, follow-ups ship em-dashes raw.
    const cleaned = humanizeDraft({
      subject: parsed.subject.trim(),
      body: parsed.body.trim(),
    });
    return { kind: "email", subject: cleaned.subject, body: cleaned.body };
  };
}

export interface PriorStepRow {
  stepIndex: number;
  /** "initial send" for step 0; the registered step label for 1+; "follow-up" if missing. */
  label: string;
  subject: string;
  /** Null for legacy pre-v8 rows whose metadata_json didn't include the body. */
  body: string | null;
  /** sequence_events.created_at (UTC ISO). */
  sentAt: string;
  status: "sent" | "delivered" | "replied";
}

/**
 * Parse a prospect's prior sends for a play into per-step rows. Shared by the
 * LLM PRIOR-EMAILS injection and the /api/cadences view.
 */
export function getPriorStepsForProspect(prospectId: number, playName: string): PriorStepRow[] {
  if (!prospectId) return [];
  let rows: Array<{
    step_index: number;
    metadata_json: string | null;
    status: string;
    created_at: string;
  }>;
  try {
    rows = getLedger().listSequenceEventsForProspectPlay(prospectId, playName) as Array<{
      step_index: number;
      metadata_json: string | null;
      status: string;
      created_at: string;
    }>;
  } catch {
    return [];
  }
  return rows.map(rowToPriorStep);
}

function rowToPriorStep(r: {
  step_index: number;
  metadata_json: string | null;
  status: string;
  created_at: string;
}): PriorStepRow {
  const meta = tryParseJsonObject<{ subject?: string; body?: string; label?: string }>(
    r.metadata_json ?? "",
    {},
  );
  return {
    stepIndex: r.step_index,
    label: meta.label ?? (r.step_index === 0 ? "initial send" : "follow-up"),
    subject: meta.subject ?? "(no subject)",
    body: meta.body ?? null,
    sentAt: r.created_at,
    status: (r.status as PriorStepRow["status"]) ?? "sent",
  };
}

/**
 * Bulk variant of getPriorStepsForProspect: one SQL round-trip, Map keyed by
 * `${prospectId}|${playName}`. Never-sent pairs are absent (callers default
 * to []).
 */
export function getPriorStepsBulk(
  pairs: ReadonlyArray<{ prospectId: number; playName: string }>,
): Map<string, PriorStepRow[]> {
  if (pairs.length === 0) return new Map();
  let bulk: Map<
    string,
    Array<{
      step_index: number;
      metadata_json: string | null;
      status: string;
      created_at: string;
    }>
  >;
  try {
    bulk = getLedger().listSequenceEventsForCadences(pairs) as Map<
      string,
      Array<{
        step_index: number;
        metadata_json: string | null;
        status: string;
        created_at: string;
      }>
    >;
  } catch {
    return new Map();
  }
  const out = new Map<string, PriorStepRow[]>();
  for (const [key, rows] of bulk) {
    out.set(key, rows.map(rowToPriorStep));
  }
  return out;
}

function buildPriorEmailsBlock(prospectId: number, playName: string): string | null {
  const prior = getPriorStepsForProspect(prospectId, playName).filter(
    (r): r is PriorStepRow & { body: string } => r.body !== null && r.body.length > 0,
  );
  if (prior.length === 0) return null;
  const lines = [
    "PRIOR EMAILS (your previous touches to this prospect on this play; do not repeat their angles, hooks, openers, or closes):",
  ];
  for (const row of prior) {
    lines.push(`--- step ${row.stepIndex} (${row.label}) ---`);
    lines.push(`Subject: ${row.subject}`);
    lines.push(row.body);
  }
  return lines.join("\n");
}

export function buildSmsStep(opts: {
  promptName: string;
  contextLines: string[];
  toPhone: (ctx: CadenceContext) => string | null;
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const phone = opts.toPhone(ctx);
    if (!phone) return null;
    const system = loadPrompt(opts.promptName);
    const user = [
      `FOUNDER: ${ctx.cfg.founderName}`,
      `PRODUCT: ${ctx.cfg.productOneLiner}`,
      `PROSPECT: ${ctx.prospect.name ?? "(unknown)"}`,
      ...opts.contextLines,
    ].join("\n");
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.5,
      maxTokens: 250,
    });
    const parsed = tryParseJsonObject<{ message?: string }>(res.content, {});
    if (!parsed.message) return null;
    return { kind: "sms", message: parsed.message.trim(), toPhone: phone };
  };
}

export function buildVoiceStep(opts: {
  toPhone: (ctx: CadenceContext) => string | null;
  objective: (ctx: CadenceContext) => string;
  context?: (ctx: CadenceContext) => string;
  maxDurationMinutes?: number;
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const phone = opts.toPhone(ctx);
    if (!phone) return null;
    return {
      kind: "voice",
      objective: opts.objective(ctx),
      toPhone: phone,
      ...(opts.context ? { context: opts.context(ctx) } : {}),
      ...(opts.maxDurationMinutes ? { maxDurationMinutes: opts.maxDurationMinutes } : {}),
    };
  };
}

export function receiptUrlsForCadence(receiptIds: number[]): string[] {
  return receiptIds.map(receiptUrlForId);
}
