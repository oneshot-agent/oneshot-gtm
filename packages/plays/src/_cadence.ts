import type { DraftAngleChoice } from "@oneshot-gtm/shared-types";
import { replyIntentMeta } from "@oneshot-gtm/shared-types";
import {
  classifyReply,
  type InboxEmail,
  motionMailPolicy,
  automaticMailEligible,
  mailFollowupDueAt,
  sendDirectMail,
  getLedger,
  hasAnySendCapacity,
  isSendDeferred,
  listBounces,
  listInbox,
  loadConfig,
  logEvent,
  readPersonHalf,
  parallelMap,
  cadenceGoalId,
  receiptUrlForId,
  sendEmail,
  sendSms,
  tagOutcomeValue,
  trackSend,
  triggerAngleRefresh,
  voiceCall,
  angleBlockFromJson,
  type BounceKind,
  type ProspectRecord,
  type CadencePlanStep,
  describeTouch,
  recentTouchElsewhere,
  notifySlackBounceRecorded,
  notifySlackReplyReceived,
  sqliteToIso,
  type DemoDay,
  demoDayLine,
  demoDayOf,
  canonicalLinkedInProfileKey,
  currentWorkspaceName,
  linkedInConversationFor,
  linkedInOutreachAccount,
  isWithdrawnStatus,
  type LinkedInOperation,
} from "@oneshot-gtm/core";
import { classifyReplyIntent, complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { followUpEdgeBlock, followUpEdgeSelection } from "./_angles.ts";
import {
  firstNameFrom,
  humanizeDraft,
  lintEmail,
  repairWritingLints,
  lintOpenerFrequency,
  overusedOpeners,
  signatureDirective,
  voiceBlock,
} from "./_lib.ts";

export interface CadenceContext {
  prospect: ProspectRecord;
  cfg: ReturnType<typeof loadConfig>;
  metadata: Record<string, unknown>;
  maxBodyWords?: number;
  recentEmailBodies?: string[];
}

export type StepPayload =
  | { kind: "direct_mail"; draftId: string }
  | {
      kind: "email";
      subject: string;
      body: string;
      /** Which edge angle the follow-up drew on (issue #584); absent when the play's edge has one or none. */
      angle?: DraftAngleChoice;
      /** Hash of the founder's voice card in the prompt; absent when none was set. */
      voiceKey?: string | null;
    }
  | { kind: "sms"; message: string; toPhone?: string }
  /** A LinkedIn message into the conversation opened by an accepted invite. */
  | { kind: "linkedin_message"; text: string }
  | {
      kind: "voice";
      objective: string;
      toPhone?: string;
      context?: string;
      maxDurationMinutes?: number;
    };

interface SequenceStep {
  id?: string;
  /** Days after enrollment (step 0 was the original send). step 1 is the first follow-up. */
  dayOffset: number;
  channel: "email" | "sms" | "voice" | "direct_mail" | "linkedin";
  /** When true, an inbound reply at any time stops the cadence. */
  breakOnReply: boolean;
  /** Builder returns null to skip this step gracefully. */
  builder: (ctx: CadenceContext) => Promise<StepPayload | null>;
  /** Optional label for logs. */
  label?: string;
  /**
   * Word cap for this follow-up, enforced by preview and batch linting.
   * Defaults to 100 when unset; keep it consistent with the step prompt.
   */
  maxBodyWords?: number;
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
  channel: SequenceStep["channel"];
}

/**
 * Number of follow-up steps registered for this play (excludes day-0).
 * Always the registered total regardless of current_step, so the UI's dot
 * count stays stable for completed cadences.
 */
export function playFollowupCount(playName: string, prospectId?: number): number {
  return effectiveSequence(playName, prospectId)?.steps.length ?? 0;
}

/**
 * Describe the NEXT step scheduled to fire, or null at/past the last step.
 * Source of truth for both the server's CadenceView and the /cadences UI.
 */
export function nextStepInfo(
  playName: string,
  currentStep: number,
  prospectId?: number,
): NextStepInfo | null {
  const seq = effectiveSequence(playName, prospectId);
  if (!seq) return null;
  const nextIndex = currentStep + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) return null;
  const step = seq.steps[stepEntryIndex];
  return {
    label: step?.label ?? null,
    isBreakup: isBreakupStepAt(seq, stepEntryIndex),
    nextStepNumber: nextIndex,
    channel: step!.channel,
  };
}

export function getSequence(playName: string, prospectId?: number): Sequence | undefined {
  return effectiveSequence(playName, prospectId);
}

/** The registered (code) sequence, ignoring any founder override. For "reset". */
export function defaultSequence(playName: string): Sequence | undefined {
  return playSequences.get(playName);
}

/**
 * The registered sequence with the founder's per-play timing overrides. Code
 * defines the structure; a matching-length `cadenceOverrides[playName]`
 * replaces each RELATIVE dayOffset. A length mismatch is ignored: code wins,
 * never throws. Read fresh each call so a /plays edit applies without restart.
 */
function mailStep(dayOffset: number): SequenceStep {
  return {
    id: "direct_mail",
    dayOffset,
    channel: "direct_mail",
    breakOnReply: true,
    label: "Direct mail",
    builder: async () => {
      throw new Error("Review this prospect’s direct mail step first");
    },
  };
}

export function sequencePlan(seq: Sequence): CadencePlanStep[] {
  return seq.steps.map((s, i) => ({
    id: s.id ?? `base:${i + 1}`,
    dayOffset: s.dayOffset,
    channel: s.channel,
    label: s.label,
  }));
}

export function effectiveSequence(
  playName: string,
  prospectId?: number,
  rebuild = false,
  /** The cadence's channel when it isn't enrolled yet; read from the cadence otherwise. */
  channel?: string,
): Sequence | undefined {
  const cadenceChannel =
    channel ??
    (prospectId !== undefined ? getLedger().getCadence(prospectId, playName)?.channel : undefined);
  if (cadenceChannel === "linkedin") return linkedInSequence(playName);
  const base = playSequences.get(playName);
  if (!base) return undefined;
  const cfg = loadConfig();
  const override = cfg.cadenceOverrides?.[playName];
  const mail = motionMailPolicy(cfg, playName).settings;
  if (prospectId === undefined && !mail && (!override || override.length !== base.steps.length))
    return base;
  const steps: SequenceStep[] = base.steps.map((step, i) => ({
    id: `base:${i + 1}`,
    channel: step.channel,
    label: step.label,
    builder: step.builder,
    breakOnReply: step.breakOnReply,
    dayOffset: override?.length === base.steps.length ? override[i]! : step.dayOffset,
  }));
  if (prospectId !== undefined) {
    const ledger = getLedger();
    const cadence = ledger.getCadence(prospectId, playName);
    const saved = cadence && ledger.getCadencePlan(prospectId, playName, cadence.enrolled_at);
    if (saved && !rebuild)
      return {
        playName,
        steps: saved.map((entry) => {
          if (entry.channel === "direct_mail") return mailStep(entry.dayOffset);
          const step = steps.find((s) => s.id === entry.id);
          if (!step) throw new Error(`Saved cadence step ${entry.id} is no longer registered`);
          return {
            id: entry.id,
            dayOffset: entry.dayOffset,
            channel: entry.channel,
            label: entry.label,
            builder: step.builder,
            breakOnReply: step.breakOnReply,
          };
        }),
      };
    // Existing enrollments without a snapshot predate configured mail. Reads never mutate them.
    if (cadence && !rebuild) return { playName, steps };
  }
  const prospect =
    prospectId === undefined || mail?.mode !== "automatic"
      ? null
      : getLedger().getProspectById(prospectId);
  const eligible =
    !mail ||
    mail.mode !== "automatic" ||
    prospectId === undefined ||
    automaticMailEligible(playName, {
      ...prospect,
      buyerType: getStep0MetadataField(prospectId, playName, "buyerType"),
    });
  if (mail && eligible)
    steps.splice(Math.min(mail.position - 2, steps.length), 0, mailStep(mail.delayDays));
  return { playName, steps };
}

/** Capture before a configuration write; preserve completed prefixes and any existing mailpiece. */
export function captureCadencePlans(playName: string) {
  const ledger = getLedger();
  return ledger
    .listAllCadences()
    .filter((c) => c.play_name === playName)
    .map((c) => ({
      cadence: c,
      steps: sequencePlan(effectiveSequence(playName, c.prospect_id)!),
    }));
}
export function applyCadencePlans(
  playName: string,
  previous: ReturnType<typeof captureCadencePlans>,
): void {
  const ledger = getLedger();
  const drafts = ledger.listDirectMail();
  for (const { cadence: c, steps: old } of previous) {
    const desired = sequencePlan(effectiveSequence(playName, c.prospect_id, true)!);
    let steps = old;
    const pinned =
      ledger.hasSentSequenceEvent(c.prospect_id, playName, c.current_step + 1) ||
      drafts.some(
        (d) =>
          d.prospectId === c.prospect_id &&
          d.playName === playName &&
          d.enrollment === c.enrolled_at &&
          !d.canceled,
      );
    const prefixMatches = old.slice(0, c.current_step).every((s, i) => desired[i]?.id === s.id);
    if (c.status === "active" && !c.sending_started_at && !pinned && prefixMatches) {
      steps = [...old.slice(0, c.current_step), ...desired.slice(c.current_step)];
      if (JSON.stringify(old[c.current_step]) !== JSON.stringify(steps[c.current_step])) {
        const next = steps[c.current_step];
        ledger.advanceCadence({
          prospectId: c.prospect_id,
          playName,
          newStep: c.current_step,
          nextDueAt: next ? new Date(Date.now() + next.dayOffset * 86400000).toISOString() : null,
        });
        if (!next)
          ledger.setCadenceStatus({ prospectId: c.prospect_id, playName, status: "completed" });
      }
    }
    const oldMail = old.findIndex((s) => s.channel === "direct_mail"),
      newMail = steps.findIndex((s) => s.channel === "direct_mail");
    if (oldMail >= 0 && newMail >= 0 && oldMail !== newMail) {
      const prep = ledger.getMailPreparation(c.prospect_id, playName, c.enrolled_at, oldMail + 1);
      if (prep) {
        ledger.saveMailPreparation(c.prospect_id, playName, c.enrolled_at, newMail + 1, prep);
        ledger.deleteMailPreparation(c.prospect_id, playName, c.enrolled_at, oldMail + 1);
      }
    }
    ledger.saveCadencePlan(c.prospect_id, playName, c.enrolled_at, steps);
  }
}

export function skipDirectMailStep(input: { prospectId: number; playName: string }): void {
  const ledger = getLedger();
  const c = ledger.getCadence(input.prospectId, input.playName);
  const seq = effectiveSequence(input.playName, input.prospectId);
  if (
    !c ||
    c.status !== "active" ||
    c.sending_started_at ||
    seq?.steps[c.current_step]?.channel !== "direct_mail"
  )
    throw new Error("No pending mail step to skip");
  const draft = ledger.findDirectMail(
    input.prospectId,
    input.playName,
    c.enrolled_at,
    c.current_step + 1,
  );
  if (draft?.started) throw new Error("Recover the submitted mailpiece before continuing");
  const next = seq.steps[c.current_step + 1];
  // One transaction: the cancelled draft, the recorded skip and the advance
  // land together or not at all. A retry after a crash never finds a
  // "skipped" row beside a cadence still parked on the letter.
  ledger.transaction(() => {
    if (draft) {
      draft.canceled = true;
      draft.approvalId = undefined;
      ledger.saveDirectMail(draft);
    }
    // The skip is part of the cadence's history (#610): the same step index
    // a send would have written, status "skipped", so "sent so far" and the
    // prospect timeline can say why step N never went out. Every send
    // counter filters on sent/delivered/replied and never sees it.
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: c.current_step + 1,
      channel: "direct_mail",
      status: "skipped",
      metadata: {
        label: seq.steps[c.current_step]?.label ?? "Direct mail",
        reason: "skipped by founder",
      },
    });
    ledger.advanceCadence({
      ...input,
      newStep: c.current_step + 1,
      nextDueAt: next ? new Date(Date.now() + next.dayOffset * 86400000).toISOString() : null,
    });
    if (!next) ledger.setCadenceStatus({ ...input, status: "completed" });
  });
  logEvent("cadence.mail.skipped", input);
}

export function enrollInCadence(input: {
  prospectId: number;
  playName: string;
  /** Channel the cadence runs on; LinkedIn enrolls the LinkedIn sequence. */
  channel?: "email" | "linkedin";
}): void {
  const seq = effectiveSequence(input.playName, input.prospectId, false, input.channel);
  if (!seq || seq.steps.length === 0) return;
  const next = seq.steps[0];
  if (!next) return;
  const dueAt = new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString();
  getLedger().enrollCadence({
    prospectId: input.prospectId,
    playName: input.playName,
    nextDueAt: dueAt,
    ...(input.channel ? { channel: input.channel } : {}),
  });
  const cadence = getLedger().getCadence(input.prospectId, input.playName);
  if (cadence && !getLedger().getCadencePlan(input.prospectId, input.playName, cadence.enrolled_at))
    getLedger().saveCadencePlan(
      input.prospectId,
      input.playName,
      cadence.enrolled_at,
      sequencePlan(seq),
    );
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
   * Replies learned for the FIRST time this poll. The number the reply-rate
   * metrics move by, whatever state the cadence was in.
   */
  repliesDetected: number;
  /** Subset of the above that also stopped a still-active cadence. */
  cadencesStopped: number;
  /** Matched inbound mail classified as non-human (OOO / dead mailbox / unsubscribe): stored, never counted as a reply. */
  autoRepliesSkipped: number;
  /**
   * True only when every source in the live window and backlog was clean.
   * A partial poll cannot establish that all replies for a closing UTC day
   * are recorded, so the scheduler must not advance the daily summary watermark.
   */
  clean: boolean;
  details: Array<{ prospectEmail: string; playName: string; subject: string }>;
}

/** poll_state key for the reply poll's high-water mark (newest received_at seen on a clean poll). */
const REPLY_WATERMARK_KEY = "inbox_replies";
/**
 * poll_state key for an unfinished catch-up slice (JSON `{ since, until }`),
 * drained by later polls. A backlog is delayed, never skipped.
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
/** Page size per fetch. The same window the /inbox route uses. */
const REPLY_POLL_LIMIT = 200;
/**
 * Pages walked per poll before the rest is parked as backlog: bounds a single
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
  /** The whole (since, until) slice was examined: nothing older remains. */
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
/**
 * Stop a prospect's live cadences after an opt-out reply label (REPLY_INTENTS
 * `optOut`, i.e. `unsubscribe`). Idempotent; returns the number stopped.
 */
function stopCadencesForOptOut(prospectId: number): number {
  const ledger = getLedger();
  let stopped = 0;
  for (const cad of ledger.listCadencesForProspect(prospectId)) {
    if (cad.status !== "active" && cad.status !== "paused") continue;
    ledger.recordSequenceEvent({
      prospectId,
      playName: cad.play_name,
      stepIndex: cad.current_step,
      channel: "email",
      status: "unsubscribed",
      metadata: { reason: "unsubscribe" },
    });
    ledger.setCadenceStatus({ prospectId, playName: cad.play_name, status: "unsubscribed" });
    stopped++;
  }
  // A pending or approved breakup-revive row would still go out to a prospect
  // who just asked to be removed: setCadenceStatus touches cadence_state only,
  // so expire the queue rows here, as stopCadence and the reply paths do.
  ledger.expireBreakupReviveQueue(prospectId, "prospect unsubscribed");
  return stopped;
}

/** Replies older than this are out of the live poll's reach (watermark minus its 1h overlap). */
const UNTRIAGED_RETRY_MIN_AGE_MS = 2 * 60 * 60 * 1000;
/** The sweep covers replies the poll missed, not history: older rows are `backfill-intent`'s. */
const UNTRIAGED_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A reply whose classify call failed waits this long before the sweep pays for it again. */
const UNTRIAGED_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Label human replies the live poll can no longer reach: a classify call that
 * failed (the claim was released, intent NULL) once the reply fell out of the
 * poll window, up to a week back. The poll already did the
 * ordinary reply bookkeeping for these (a failed triage still counts as a
 * reply), so the only action here beyond the label is the opt-out stop the
 * poll could not apply. Bounded; claims each row like the poll does.
 */
export async function retryUntriagedReplies(
  opts: { limit?: number; now?: number } = {},
): Promise<{ checked: number; labelled: number; failed: number; cadencesStopped: number }> {
  const ledger = getLedger();
  const now = opts.now ?? Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const rows = ledger.listStaleUntriagedHumanReplies({
    beforeIso: iso(UNTRIAGED_RETRY_MIN_AGE_MS),
    sinceIso: iso(UNTRIAGED_RETRY_MAX_AGE_MS),
    retryBeforeIso: iso(UNTRIAGED_RETRY_BACKOFF_MS),
    limit: opts.limit ?? 25,
  });
  const out = { checked: rows.length, labelled: 0, failed: 0, cadencesStopped: 0 };
  for (const row of rows) {
    if (!ledger.claimInboxReplyForTriage(row.id)) continue;
    try {
      const labelled = await classifyReplyIntent({
        id: row.id,
        from: row.from_email,
        subject: row.subject ?? "",
        body: row.body,
        received_at: row.received_at,
      } satisfies InboxEmail);
      ledger.setInboxReplyIntent(row.id, labelled.intent, labelled.reason || null, {
        confidence: labelled.confidence,
        probabilities: labelled.probabilities,
        classifier: labelled.classifier,
        costMicros: labelled.costMicros,
        review: labelled.review,
      });
      out.labelled++;
      logEvent("reply.intent.classified", {
        intent: labelled.intent,
        classifier: labelled.classifier,
        confidence: labelled.confidence,
        review: labelled.review,
        cost_micros: labelled.costMicros,
        fell_back: labelled.fellBack,
        retry: true,
      });
      if (replyIntentMeta(labelled.intent)?.optOut === true) {
        out.cadencesStopped += stopCadencesForOptOut(row.prospect_id);
      }
    } catch (err) {
      ledger.setInboxReplyIntent(row.id, null, null);
      out.failed++;
      logEvent(
        "inbox.reply.triage_failed",
        { message_120: ((err as Error)?.message ?? "").slice(0, 120), retry: true },
        "warn",
      );
    }
  }
  return out;
}

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
      const prospect =
        e.matched_prospect_id != null
          ? ledger.getProspectById(e.matched_prospect_id)
          : ledger.findProspectByEmail(from);
      if (!prospect) continue;
      // Autoresponders (OOO, "no longer here") and unsubscribe requests are
      // NOT replies: they must not stop cadences as engagement, move the reply
      // metric, or tag RoCS. Classified here. The one choke point every
      // detection path funnels through.
      const kind = classifyReply({
        subject: e.subject,
        body: e.body,
        autoSubmitted: e.auto_submitted,
      });
      // Persist the full inbound (body included). The ledger, not the mailbox,
      // is the reply store. Every matched email, not just the first reply per
      // (prospect, play): later replies on a live thread must be kept too.
      // Same thread key convention as inboxThreadKey (thread_id, else id).
      const playName = ledger.latestSentPlayForProspect(prospect.id, e.subject);
      // recordInboxReply is idempotent. A new insert gates angle refresh and
      // Slack notifications; triage uses a separate atomic claim below.
      const insertedReply = ledger.recordInboxReply({
        id: e.id,
        threadKey: e.thread_id ?? e.id,
        prospectId: prospect.id,
        playName,
        fromEmail: from,
        subject: e.subject,
        body: e.body ?? "",
        receivedAt: e.received_at,
        sourceIdentityId: e.source_identity_id ?? null,
        threadId: e.thread_id ?? null,
        messageId: e.message_id ?? null,
        kind,
      });
      // Refresh only for newly inserted human replies, excluding overlap re-scans
      // and autoresponders. Fire-and-forget; the refresh debounces and never throws.
      if (insertedReply && kind === "human") triggerAngleRefresh(prospect.id);
      // Notify only for newly inserted human replies. Autoresponders and
      // unsubscribe requests must not produce reply alerts.
      if (insertedReply && kind === "human") {
        void notifySlackReplyReceived({
          from_email: from,
          subject: e.subject,
          play_name: playName,
          kind,
        });
      }
      if (kind !== "human") {
        out.autoRepliesSkipped++;
        // A dead mailbox ("retired", "no longer at company") is a human-layer
        // hard bounce; an unsubscribe is a do-not-contact. Either way active
        // cadences stop, but with an honest status, no replied event, and no
        // bounces-table row (that would poison identity reputation stats).
        if (kind === "auto_permanent" || kind === "unsubscribe") {
          const status = kind === "unsubscribe" ? "unsubscribed" : "bounced";
          // Notify once per newly inserted autoresponder email, not per cadence or
          // poll. The overlap window re-reads emails, so only insertedReply prevents
          // duplicate alerts across polls. This contributes to the daily bounce total.
          // No status_code: autoresponders carry no SMTP DSN code.
          if (status === "bounced" && insertedReply) {
            void notifySlackBounceRecorded({
              recipient: from,
              kind: "auto_permanent",
              status_code: null,
            });
          }
          for (const cad of ledger.listCadencesForProspect(prospect.id)) {
            if (cad.status !== "active" && cad.status !== "paused") continue;
            ledger.recordSequenceEvent({
              prospectId: prospect.id,
              playName: cad.play_name,
              stepIndex: cad.current_step,
              channel: "email",
              status,
              metadata: { reason: kind === "unsubscribe" ? "unsubscribe" : "auto-reply-permanent" },
              // Occurrence time = when the autoresponder actually landed in the
              // mailbox, not poll time: same reasoning as the DSN-bounce path
              // in pollInboxBounces, so the Slack daily summary's occurrence
              // window credits this to the right UTC day. unsubscribe rows
              // don't carry bouncedAt: it's a bounced-column semantic, and this
              // status is only "bounced" for the auto_permanent branch.
              ...(status === "bounced" ? { bouncedAt: e.received_at } : {}),
            });
            ledger.setCadenceStatus({ prospectId: prospect.id, playName: cad.play_name, status });
            out.cadencesStopped++;
          }
        }
        if (e.id.startsWith("mailbox:")) ledger.mailboxes.acknowledge(e.id, prospect.id);
        continue;
      }
      // Classify intent separately from deliverability. Replies are already stored;
      // triage failures leave intent NULL for a later retry. Claim atomically with
      // UPDATE ... WHERE intent IS NULL to prevent concurrent paid calls. Release
      // the claim on failure; the pending marker is not a category.
      //
      // A claim loser skips bookkeeping while triage is pending. If a result is
      // already stored, use it so an unsubscribe remains vetoed on every re-scan.
      let triagedIntent: string | null = null;
      let claimPending = false;
      if (ledger.claimInboxReplyForTriage(e.id)) {
        try {
          const labelled = await classifyReplyIntent(e);
          triagedIntent = labelled.intent;
          ledger.setInboxReplyIntent(e.id, labelled.intent, labelled.reason || null, {
            confidence: labelled.confidence,
            probabilities: labelled.probabilities,
            classifier: labelled.classifier,
            costMicros: labelled.costMicros,
            review: labelled.review,
          });
          logEvent("reply.intent.classified", {
            intent: labelled.intent,
            classifier: labelled.classifier,
            confidence: labelled.confidence,
            review: labelled.review,
            cost_micros: labelled.costMicros,
            fell_back: labelled.fellBack,
          });
        } catch (err) {
          ledger.setInboxReplyIntent(e.id, null, null);
          logEvent(
            "inbox.reply.triage_failed",
            { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
            "warn",
          );
        }
      } else {
        const peeked = ledger.peekInboxReplyIntent(e.id);
        claimPending = peeked.pending;
        triagedIntent = peeked.intent;
      }
      // Intent triage may catch an unsubscribe that phrase-based deliverability
      // classification missed. Stop live cadences before reply bookkeeping, using
      // either this poll's verdict or a stored verdict. The stop is idempotent, and
      // contactAllowedClause also blocks re-enrollment on this intent.
      if (replyIntentMeta(triagedIntent)?.optOut === true) {
        out.cadencesStopped += stopCadencesForOptOut(prospect.id);
        // Do not count or bill an unsubscribe as engagement after stopping cadences.
      } else if (!claimPending) {
        for (const r of ledger.recordProspectReply(prospect.id, {
          subject: e.subject,
          // Use receipt time so backlog replies count toward the correct UTC day.
          repliedAt: e.received_at,
        })) {
          if (r.newlyReplied) out.cadencesStopped++;
          if (!r.eventRecorded) continue;
          out.repliesDetected++;
          out.details.push({ prospectEmail: from, playName: r.playName, subject: e.subject });
          // A reply is the first value signal: tag the play's send receipts so
          // RoCS reflects engagement. Best-effort (tagOutcomeValue swallows errors).
          await tagOutcomeValue({
            prospectId: prospect.id,
            playName: r.playName,
            valueTag: { type: "engagement", label: "reply" },
          });
        }
      }
      // While another caller is triaging, skip both opt-out and engagement
      // bookkeeping until a later poll can read the verdict.
      if (e.id.startsWith("mailbox:")) ledger.mailboxes.acknowledge(e.id, prospect.id);
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
    clean: true,
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
  if (!fwd.clean) out.clean = false;

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
    if (!back.clean) out.clean = false;
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
  /** Failures seen for the FIRST time. The ones that were acted on. */
  recorded: number;
  /** Cadences stopped by a hard bounce this poll. */
  cadencesStopped: number;
  /**
   * True only when every bounce source was clean. A partial sweep must not
   * advance the daily summary watermark, including a forced rollover sweep.
   */
  clean: boolean;
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
  const out: BouncePollResult = {
    polled: 0,
    recorded: 0,
    cadencesStopped: 0,
    clean: true,
    details: [],
  };
  const { bounces, failedSources } = await listBounces();
  out.polled = bounces.length;
  out.clean = failedSources.length === 0;

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

    // Slack notification: fire-and-forget, never blocks the poll.
    void notifySlackBounceRecorded({
      recipient: b.recipient,
      kind: b.kind,
      status_code: b.statusCode ?? null,
    });

    // Soft = transient (mailbox full, greylisted). Stored for context, but it
    // says nothing durable about the address or our reputation.
    if (b.kind === "soft") continue;

    if (!prospect) {
      // A bounce for an address we don't track: still counts toward the
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
      // is recorded at current_step + 1 as it fires). That's the touch that
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
        bouncedAt: b.bouncedAt,
      });
      // Only a HARD bounce stops the sequence. A 5.7.x block judges the
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
  opts: { dryRun: boolean; linkedIn?: LinkedInCaller } = { dryRun: false },
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
    // pass's. Otherwise we'd send one more email to a known-dead address.
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
        ...(opts.linkedIn ? { linkedIn: opts.linkedIn } : {}),
      });
    } catch (err) {
      // Deferral mid-pass (caps filled while this batch ran): the step simply
      // stays due. Anything else propagates: parallelMap rejects the whole
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
      send-this-one: used by the /cadences UI after a Preview round-trip). */
  persistedPayload?: StepPayload;
  /** Only the individual reviewed mail action may dispatch physical mail. */
  directMailId?: string;
  /**
   * Calls OneShot as the workspace owning a LinkedIn account (the server's
   * callLinkedIn). Without it LinkedIn steps are never sent from this process.
   */
  linkedIn?: LinkedInCaller;
}

export interface RunCadenceStepResult {
  action: AdvanceResult["details"][number]["action"];
  payload: StepPayload | null;
  receiptIds: number[];
  note?: string;
}

/**
 * Per-prospect cadence step runner: single source of truth for the batch
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
    // same shape as the bounce check: stop before paying for a draft, and
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
  // Code-level on purpose. A prompt can be talked out of a rule, a status
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
  // Meeting verdict (issue #578): modelled on the suppression checks above:
  // a ledger read returning a verdict, then a status change, before paying
  // for a draft. Code-level on purpose, same principle as the ICP gate.
  // Only 'held' is terminal here: a real conversation already happened, so
  // an automated follow-up cadence has been obsoleted by it. A no-show is
  // explicitly NOT terminal (the card: "a reason to write a different
  // reply, not to stop the cadence") and cancelled/rescheduled meetings
  // never happened at all, so neither stops anything. The cadence
  // continues exactly as it would with no meeting on the prospect.
  //
  // dryRun must never mutate the live cadence (same rule the suppression
  // and ICP checks above don't have to worry about because they only READ:
  // this is the one gate here that both reads and writes). A preview pass
  // (finding PRRT_kwDOSKzrBs6gwORi) still reports "skipped" so a caller sees
  // the cadence would stop, but the actual stopCadence write, which clears
  // the live schedule and any pending draft. Only happens for a real run.
  {
    const meeting = ledger.latestMeetingOutcomeFor(opts.prospectId);
    if (meeting?.outcome === "held") {
      if (!opts.dryRun) {
        ledger.stopCadence({
          prospectId: opts.prospectId,
          playName: opts.playName,
          reason: "other",
          note: "meeting held — cadence superseded by a real conversation",
        });
      }
      return {
        action: "skipped",
        payload: null,
        receiptIds: [],
        note: "stopped: meeting held with founder",
      };
    }
  }
  // Cross-workspace hold, same reasoning as the suppression check above:
  // decide before paying for a draft. Not a status change. The step stays
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
  const seq = effectiveSequence(opts.playName, opts.prospectId);
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
  // crash between dispatch and `advanceCadence` can leave a sent step behind:
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
        ? step.channel === "direct_mail"
          ? mailFollowupDueAt(next.dayOffset)
          : new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString()
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

  // A step on a channel this person has no address for is skipped AND the
  // cadence moves on. Leaving it due re-drafted (and re-paid) it every run.
  const missing = missingAddress(step.channel, cadence);
  if (missing) {
    if (!opts.dryRun) {
      ledger.recordSequenceEvent({
        prospectId: opts.prospectId,
        playName: opts.playName,
        stepIndex: nextIndex,
        channel: step.channel,
        status: "skipped",
        metadata: { reason: missing, label: step.label ?? null },
      });
      advanceOrComplete(opts, seq, stepEntryIndex);
    }
    return { action: "skipped", payload: null, receiptIds: [], note: `${missing} — step skipped` };
  }
  if (step.channel === "linkedin") {
    const waiting = await awaitLinkedInAcceptance(opts, cadence);
    if (waiting) return waiting;
  }

  const prospect = loadProspect(opts.prospectId);
  if (!prospect) {
    return { action: "skipped", payload: null, receiptIds: [], note: "prospect not found" };
  }

  const mailDraft = ledger.findDirectMail(
    opts.prospectId,
    opts.playName,
    cadence.enrolled_at,
    nextIndex,
  );
  if ((step.channel === "direct_mail" || mailDraft) && opts.directMailId !== mailDraft?.id) {
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: "Direct mail awaits individual review",
    };
  }
  if (step.channel === "direct_mail" && !mailDraft) {
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: "Direct mail awaits individual review",
    };
  }
  const built: StepPayload | null = mailDraft
    ? { kind: "direct_mail", draftId: mailDraft.id }
    : opts.persistedPayload
      ? opts.persistedPayload
      : await step.builder({
          prospect,
          cfg,
          metadata: {},
          maxBodyWords: step.maxBodyWords ?? 100,
          recentEmailBodies: ledger.recentSentEmailBodies({
            playName: opts.playName,
            stepIndex: nextIndex,
          }),
        });

  if (built?.kind === "direct_mail" && opts.directMailId !== built.draftId) {
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: "Direct mail awaits individual review",
    };
  }
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
        prospectLinkedinUrl: cadence.prospect_linkedin_url,
        linkedIn: opts.linkedIn,
        stepIndex: nextIndex,
        step,
        payload: built,
        ...(step.label !== undefined ? { label: step.label } : {}),
      });
    } catch (err) {
      // A daily-cap deferral isn't a failure. The step stays due for
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
    nextDueAt: next
      ? step.channel === "direct_mail"
        ? mailFollowupDueAt(next.dayOffset)
        : new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString()
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
 * sends. Mirrors the /queue regenerate route. The founder reviews on
 * /cadences, then clicks Send next which calls sendCadenceStep.
 */
/** The edge angle the current persisted preview was built on, if any. */
function currentPreviewAngle(input: { prospectId: number; playName: string }): string | null {
  try {
    const draft = getLedger().getCadenceDraft(input) as { payload?: unknown } | null;
    const angle = (draft?.payload as { angle?: { text?: unknown } } | undefined)?.angle;
    return typeof angle?.text === "string" && angle.text.trim() ? angle.text : null;
  } catch {
    return null;
  }
}

export async function previewCadenceStep(input: {
  prospectId: number;
  playName: string;
  /** Bodies accepted earlier in the same batch. They are not in the ledger
   *  yet, and without them a batch can agree on one brand-new opener and every
   *  row passes the cap individually. */
  extraRecentBodies?: readonly string[];
  /**
   * "Rotate angle": draft on a different edge angle from the current
   * preview's (and the intro's). The replaced preview is recorded as a
   * rejected angle (`rotate`), not a rejected text.
   */
  rotateAngle?: boolean;
}): Promise<CadenceStepPreview> {
  const ledger = getLedger();
  const cfg = loadConfig();
  const cadence = ledger.getCadence(input.prospectId, input.playName);
  if (!cadence) throw new Error("no cadence for that prospect+play");
  if (cadence.status !== "active") {
    throw new Error(`cadence is ${cadence.status}, can only preview an active cadence`);
  }
  const seq = effectiveSequence(input.playName, input.prospectId);
  if (!seq) throw new Error(`no registered sequence for play '${input.playName}'`);
  const nextIndex = cadence.current_step + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) {
    throw new Error("no next step (cadence is at or past the last step)");
  }
  const step = seq.steps[stepEntryIndex];
  if (!step) throw new Error("step undefined");
  const missing = missingAddress(step.channel, cadence);
  if (missing) throw new Error(`${missing} — this step will be skipped`);
  if (
    step.channel === "linkedin" &&
    !linkedInConversationFor({
      workspace: currentWorkspaceName(),
      prospectId: input.prospectId,
      linkedinUrl: cadence.prospect_linkedin_url,
    })
  ) {
    throw new Error("the LinkedIn invite hasn't been accepted yet — nothing to draft");
  }
  const prospect = loadProspect(input.prospectId);
  if (!prospect) throw new Error("prospect not found");
  const mailDraft = ledger.findDirectMail(
    input.prospectId,
    input.playName,
    cadence.enrolled_at,
    nextIndex,
  );
  const built: StepPayload | null = mailDraft
    ? { kind: "direct_mail", draftId: mailDraft.id }
    : await step.builder({
        prospect,
        cfg,
        metadata: input.rotateAngle ? { rotateFrom: currentPreviewAngle(input) } : {},
        maxBodyWords: step.maxBodyWords ?? 100,
        recentEmailBodies: [
          ...(input.extraRecentBodies ?? []),
          ...ledger.recentSentEmailBodies({ playName: input.playName, stepIndex: nextIndex }),
        ],
      });
  if (!built) throw new Error("builder returned null — nothing to preview");

  const subject =
    built.kind === "email"
      ? built.subject
      : built.kind === "linkedin_message"
        ? "LinkedIn message"
        : "(non-email step)";
  const body =
    built.kind === "email"
      ? built.body
      : built.kind === "linkedin_message"
        ? built.text
        : built.kind === "sms"
          ? built.message
          : built.kind === "voice"
            ? built.objective
            : "";
  // Opener-frequency cap on top of the phrase lint: the phrase rules cannot
  // see that this play's last 40 sends all opened the same way. Scoped to the
  // same play + step because that is the population a reader would ever
  // compare. An intro and a day-3 ping are allowed to sound different.
  const flags =
    built.kind === "email"
      ? [
          ...lintEmail(subject, body, step.maxBodyWords ?? 100, undefined, {
            followUp: true,
            demoDay: prospectDemoDay(prospect, input.playName),
          }),
          ...lintOpenerFrequency(body, [
            ...(input.extraRecentBodies ?? []),
            ...ledger.recentSentEmailBodies({ playName: input.playName, stepIndex: nextIndex }),
          ]),
        ]
      : built.kind === "linkedin_message" && body.length > LINKEDIN_MESSAGE_MAX_CHARS
        ? [`too-long: ${body.length}/${LINKEDIN_MESSAGE_MAX_CHARS} characters`]
        : [];
  ledger.setCadenceDraft({
    prospectId: input.prospectId,
    playName: input.playName,
    draft: { subject, body, flags, payload: built },
    // The founder asking for a new draft: on the same angle the replaced
    // preview was rejected on its text (`regenerate`); with Rotate angle, on
    // its angle (`rotate`).
    discardReason: input.rotateAngle ? "rotate" : "regenerate",
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
  /** How LinkedIn steps reach OneShot (the server's callLinkedIn). */
  linkedIn?: LinkedInCaller;
}): Promise<RunCadenceStepResult> {
  const ledger = getLedger();
  const draft = ledger.getCadenceDraft(input);
  if (!draft) throw new Error("no persisted preview — click Preview first");
  // The UI disables Send on a flagged draft; enforce the same rule here so a
  // direct API call cannot dispatch copy the lint held back.
  if (draft.flags.length > 0) {
    throw new Error(`draft held by lint (${draft.flags.join(", ")}) — re-preview first`);
  }
  return runCadenceStepForProspect({
    prospectId: input.prospectId,
    playName: input.playName,
    dryRun: false,
    persistedPayload: draft.payload as StepPayload,
    ...(input.linkedIn ? { linkedIn: input.linkedIn } : {}),
  });
}

/** Recover or send only the cadence step bound to this reviewed mailpiece. */
export async function sendDirectMailCadenceStep(id: string): Promise<RunCadenceStepResult> {
  const ledger = getLedger();
  const mail = ledger.getDirectMail(id);
  if (!mail) throw new Error("Mailpiece not found");
  const input = { prospectId: mail.prospectId, playName: mail.playName };
  const cadence = ledger.getCadence(mail.prospectId, mail.playName);
  if (
    !cadence ||
    cadence.status !== "active" ||
    cadence.enrolled_at !== mail.enrollment ||
    cadence.current_step + 1 !== mail.stepIndex
  ) {
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: "Mailpiece is no longer the current cadence step",
    };
  }
  const payload = ledger.getCadenceDraft(input)?.payload as StepPayload | undefined;
  if (payload?.kind !== "direct_mail" || payload.draftId !== id)
    throw new Error("Current preview does not match this mailpiece; preview it again");
  return runCadenceStepForProspect({
    ...input,
    dryRun: false,
    persistedPayload: payload,
    directMailId: id,
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
 * captured in the result array. The batch never throws. `parallelMap`
 * preserves input order so the result matches `items` 1:1.
 */
export async function previewCadenceStepBatch(items: BatchItem[]): Promise<BatchPreviewResult[]> {
  // Drafts this batch has already accepted, keyed by play (the step is fixed
  // per prospect but the play is what the cap is scoped to). Concurrency 3
  // means the last couple of rows may not see each other; that still closes
  // the batch-wide agreement this exists to catch.
  const accepted = new Map<string, string[]>();
  return parallelMap(items, 3, async (item) => {
    try {
      const preview = await previewCadenceStep({
        ...item,
        extraRecentBodies: accepted.get(item.playName) ?? [],
      });
      if (preview.flags.length === 0) {
        accepted.set(item.playName, [...(accepted.get(item.playName) ?? []), preview.body]);
      }
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
  /** Fires after each item resolves (ok OR error): lets the API layer
   *  track per-row in-flight state without splitting the iteration. */
  onItemSettled?: (item: BatchItem, result: BatchSendResult) => void,
  linkedIn?: LinkedInCaller,
): Promise<BatchSendResult[]> {
  const out: BatchSendResult[] = [];
  for (const item of items) {
    let result: BatchSendResult;
    try {
      const r = await sendCadenceStep({ ...item, ...(linkedIn ? { linkedIn } : {}) });
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
  prospectLinkedinUrl?: string | null;
  linkedIn?: LinkedInCaller | undefined;
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
    // Cadence correlation key: groups every step's receipts under one goal so an
    // outcome tags the whole sequence at once. Same key the tagger derives from
    // (prospect, play) at outcome time.
    goalId: cadenceGoalId(input.playName, input.prospectEmail ?? `pid:${input.prospectId}`),
  };
  const labelTail = input.label ? ` ${input.label}` : "";

  if (input.payload.kind === "direct_mail") {
    const draft = await sendDirectMail(input.payload.draftId);
    if (draft.order?.order_status !== "accepted")
      return {
        receiptIds,
        skipReason: `Physical mail ${draft.order?.order_status ?? "awaiting approval"}`,
      };
    if (draft.receiptId) receiptIds.push(draft.receiptId);
    if (!ledger.hasSentSequenceEvent(input.prospectId, input.playName, input.stepIndex))
      ledger.recordSequenceEvent({
        prospectId: input.prospectId,
        playName: input.playName,
        stepIndex: input.stepIndex,
        channel: "direct_mail",
        status: "sent",
        receiptId: draft.receiptId,
        metadata: {
          orderId: draft.order.order_id,
          meaning: "order accepted; delivery does not prove readership",
        },
      });
    return { receiptIds };
  }
  if (input.payload.kind === "linkedin_message") {
    const conversation = linkedInConversationFor({
      workspace: currentWorkspaceName(),
      prospectId: input.prospectId,
      linkedinUrl: input.prospectLinkedinUrl ?? null,
    });
    if (!conversation) return { receiptIds, skipReason: "no LinkedIn conversation yet" };
    if (!input.linkedIn) {
      return { receiptIds, skipReason: "LinkedIn messages are sent from the dashboard" };
    }
    await input.linkedIn(conversation.workspace, {
      kind: "reply",
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      text: input.payload.text,
      // One message per step: a retried send returns the original.
      idempotencyKey: `gtm:${currentWorkspaceName()}:cadence:${input.prospectId}:${input.playName}:${input.stepIndex}`,
    });
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "linkedin",
      status: "sent",
      metadata: {
        subject: "LinkedIn message",
        body: input.payload.text,
        label: input.label ?? null,
      },
    });
    return { receiptIds };
  }
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
        ...(input.payload.angle ? { angleText: input.payload.angle.text } : {}),
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

/**
 * The OPENERS ALREADY WORN OUT block, or "" when nothing is over the cap.
 *
 * Scoped to this prospect's next step on this play. The same population the
 * `opener-overused` lint measures, so the guidance and the gate cannot
 * disagree. Returns "" on any missing cadence rather than throwing: steering
 * copy is a nicety, and a follow-up must still draft without it.
 */
function overusedOpenersBlock(prospectId: number, playName: string): string {
  const ledger = getLedger();
  const cadence = ledger.getCadence(prospectId, playName);
  if (!cadence) return "";
  const recent = ledger.recentSentEmailBodies({
    playName,
    stepIndex: cadence.current_step + 1,
  });
  const worn = overusedOpeners(recent);
  if (worn.length === 0) return "";
  return [
    "OPENERS ALREADY WORN OUT ON THIS STEP — do not open the body with these words:",
    ...worn.map((stem) => `- "${stem}"`),
    "Pick a different shape from the ones the prompt lists.",
  ].join("\n");
}

/**
 * A single field's value from a prospect's step-0 (initial send) metadata_json
 * for this play, e.g. sources-sought's `responseDeadline`. Returns null when
 * there's no step-0 row, no metadata, or the key isn't a string: callers
 * treat that as "unknown deadline", never as "expired".
 */
export function getStep0MetadataField(
  prospectId: number,
  playName: string,
  key: string,
): string | null {
  if (!prospectId) return null;
  let rows: Array<{ step_index: number; metadata_json: string | null }>;
  try {
    rows = getLedger().listSequenceEventsForProspectPlay(prospectId, playName) as Array<{
      step_index: number;
      metadata_json: string | null;
    }>;
  } catch {
    return null;
  }
  const step0 = rows.find((r) => r.step_index === 0);
  if (!step0) return null;
  const meta = tryParseJsonObject<Record<string, unknown>>(step0.metadata_json ?? "", {});
  const value = meta[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The prospect's demo day for this play, judged now. Read from the intro's
 * step-0 metadata (`demoDayMonth`, else `prospectCohort`), then from the sent
 * queue row, so a follow-up weeks after the intro sees whether it has passed.
 * Null when the cohort has no known schedule.
 */
export function prospectDemoDay(
  prospect: { id: number; email: string | null },
  playName: string,
  now: Date = new Date(),
): DemoDay | null {
  const fromMeta = demoDayOf(
    {
      demoDayMonth: getStep0MetadataField(prospect.id, playName, "demoDayMonth") ?? undefined,
      cohort: getStep0MetadataField(prospect.id, playName, "prospectCohort") ?? undefined,
    },
    now,
  );
  if (fromMeta) return fromMeta;
  const email = prospect.email?.trim();
  if (!email) return null;
  try {
    const ledger = getLedger() as ReturnType<typeof getLedger> & {
      latestSentQueueRow?: (p: string, e: string) => { payload: Record<string, unknown> } | null;
    };
    if (typeof ledger.latestSentQueueRow !== "function") return null;
    return demoDayOf(ledger.latestSentQueueRow(playName, email)?.payload, now);
  } catch {
    return null;
  }
}

/**
 * One line, capped: a scraped title or company description must not be able
 * to open a new section of the prompt.
 */
function oneLine(v: string, max: number): string {
  const flat = v.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** ROLE and COMPANY FACTS for a follow-up, from the prospect row and its researched dossier. */
export function prospectContextLines(prospect: {
  title?: string | null;
  dossier_json?: string | null;
}): string[] {
  const lines: string[] = [];
  if (prospect.title?.trim()) lines.push(`ROLE: ${oneLine(prospect.title, 120)}`);
  const half = readPersonHalf(prospect.dossier_json);
  const facts =
    half && typeof half === "object"
      ? (half as { companyFacts?: unknown }).companyFacts
      : undefined;
  if (typeof facts === "string" && facts.trim()) {
    lines.push(`COMPANY FACTS: ${oneLine(facts, 300)}`);
  }
  return lines;
}

export function buildFollowUpEmail(opts: {
  playName: string;
  promptName: string;
  contextLines: string[];
  /**
   * Add the prospect's role and researched company facts. Off by default so
   * plays whose follow-ups only re-ask keep byte-identical prompts.
   */
  prospectContext?: boolean;
  /**
   * Add the founder's admission (`founderAdmission`) on every prospect, for a
   * step whose prompt reframes it (design-partner offer: early = the founder
   * builds it with you). Unlike the first touch's ~1-in-3 slot, the step's
   * prompt decides how it lands, so it is never withheld.
   */
  admission?: boolean;
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const system = loadPrompt(opts.promptName, { humanizer: "followup" }) + signatureDirective();
    const priorBlock = buildPriorEmailsBlock(ctx.prospect.id, opts.playName);
    // Optional first-name field: prompt rule lets the LLM occasionally open
    // with "Hey {firstName},". Absent when name is null / (unknown) / handle.
    const firstName = firstNameFrom(ctx.prospect.name);
    // Steer the draft away from openers this step has already worn out, rather
    // than only rejecting them afterwards: a rejected draft costs another paid
    // completion, and the model cannot see the last 40 sends on its own.
    const avoidBlock = overusedOpenersBlock(ctx.prospect.id, opts.playName);
    // Per-prospect angle (issue #356, payoff for #355's synthesis): the only
    // signal a follow-up got before this was config + name/email/company +
    // prior step bodies. Missing/empty angle_json → null → no block, byte-
    // identical output to before this issue.
    const angleBlock = angleBlockFromJson(ctx.prospect.angle_json);
    // YOUR EDGE for a follow-up (issue #584): until this, a follow-up never
    // saw the edge at all (only the prior body under "do not repeat") so it
    // could not say anything new. It now gets a DIFFERENT angle from the
    // intro's. No multi-angle edge on the sent row → null → no block.
    const rotateFrom =
      typeof (ctx.metadata as { rotateFrom?: unknown } | undefined)?.rotateFrom === "string"
        ? ((ctx.metadata as { rotateFrom: string }).rotateFrom as string)
        : null;
    const edgeSelection = await followUpEdgeSelection(ctx.prospect, opts.playName, {
      rotateFrom,
    });
    const edgeBlock = followUpEdgeBlock(edgeSelection?.angle ?? null, {
      sameAsIntro: edgeSelection?.sameAsIntro === true,
    });
    // VOICE: the founder's register, when a card is set. The breakup step
    // gets the no-aphorism budget; every other follow-up the default one.
    const voice = voiceBlock(opts.promptName === "breakup-email" ? "breakup" : "followup");
    // Judged now, not at the intro: a demo day that was ahead of them then
    // may be behind them by the time this step sends.
    const demoDay = prospectDemoDay(ctx.prospect, opts.playName);
    const demoDayText = demoDayLine(demoDay);
    const user = [
      `FOUNDER: ${ctx.cfg.founderName}`,
      `PRODUCT: ${ctx.cfg.productOneLiner}`,
      `PROSPECT: ${ctx.prospect.name ?? "(unknown)"}`,
      `EMAIL: ${ctx.prospect.email ?? ""}`,
      `COMPANY: ${ctx.prospect.company ?? "(unknown)"}`,
      ...opts.contextLines,
      ...(opts.prospectContext ? prospectContextLines(ctx.prospect) : []),
      ...(opts.admission && ctx.cfg.founderAdmission?.trim()
        ? [`ADMISSION (true, about the sender): ${ctx.cfg.founderAdmission.trim()}`]
        : []),
      ...(demoDayText ? [demoDayText] : []),
      ...(priorBlock ? ["", priorBlock] : []),
      ...(angleBlock ? ["", angleBlock] : []),
      ...(edgeBlock ? ["", edgeBlock] : []),
      ...(voice ? ["", voice.text] : []),
      ...(firstName ? ["", `PROSPECT_FIRST_NAME: ${firstName}`] : []),
      ...(avoidBlock ? ["", avoidBlock] : []),
    ].join("\n");
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const res = await complete({ messages, temperature: 0.6, maxTokens: 500 });
    const parsed = tryParseJsonObject<{ subject?: string; body?: string }>(res.content, {});
    if (!parsed.subject || !parsed.body) return null;
    // Same deterministic humanization the initial-send plays get via
    // draftEmailFromPrompt, without it, follow-ups ship em-dashes raw.
    let cleaned = humanizeDraft({
      subject: parsed.subject.trim(),
      body: parsed.body.trim(),
    });
    cleaned = await repairWritingLints(messages, cleaned, {
      promptName: opts.promptName,
      temperature: 0.4,
      maxTokens: 500,
      maxBodyWords: ctx.maxBodyWords ?? 100,
      followUp: true,
      demoDay,
      extraLint: (draft) => lintOpenerFrequency(draft.body, ctx.recentEmailBodies ?? []),
    });
    return {
      kind: "email",
      subject: cleaned.subject,
      body: cleaned.body,
      // The voice card in the prompt, so the persisted preview's draft
      // version can be split voice on/off like an intro draft's.
      ...(voice ? { voiceKey: voice.key } : {}),
      // Carried on the payload so the persisted preview, and its draft
      // version: records the angle the way an intro draft does.
      ...(edgeSelection
        ? {
            angle: {
              text: edgeSelection.angle,
              origin: "configured" as const,
              index: edgeSelection.index,
              count: edgeSelection.count,
              ...(edgeSelection.method === "arm" ? { assignment: "arm" as const } : {}),
              ...(edgeSelection.sameAsIntro ? { sameAsIntro: true } : {}),
            },
          }
        : {}),
    };
  };
}

export interface PriorStepRow {
  stepIndex: number;
  /** "initial send" for step 0; the registered step label for 1+; "follow-up" if missing. */
  label: string;
  subject: string;
  /** Null for legacy pre-v8 rows whose metadata_json didn't include the body. */
  body: string | null;
  /** sequence_events.created_at as ISO (the column is SQLite-form): for a skipped letter, when it was skipped. */
  sentAt: string;
  status: "sent" | "delivered" | "replied" | "skipped";
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
  if (r.status === "skipped") {
    // A letter the founder skipped (#610): a line in the history, never a
    // prior email: no subject, no body, so the LLM block ignores it.
    return {
      stepIndex: r.step_index,
      label: "letter skipped",
      subject: "",
      body: null,
      sentAt: sqliteToIso(r.created_at),
      status: "skipped",
    };
  }
  return {
    stepIndex: r.step_index,
    label: meta.label ?? (r.step_index === 0 ? "initial send" : "follow-up"),
    subject: meta.subject ?? "(no subject)",
    body: meta.body ?? null,
    sentAt: sqliteToIso(r.created_at),
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
  const prior = getPriorStepsForProspect(prospectId, playName)
    .filter((s) => s.status !== "skipped")
    .filter((r): r is PriorStepRow & { body: string } => r.body !== null && r.body.length > 0);
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

/** Calls OneShot as a given workspace (the owner of the LinkedIn account). */
export type LinkedInCaller = (workspace: string, operation: LinkedInOperation) => Promise<unknown>;

/** Days an unaccepted invite is given before it is withdrawn and the cadence stops. */
export const LINKEDIN_INVITE_TIMEOUT_DAYS = 21;
/** Most characters a LinkedIn cadence message may run to. */
export const LINKEDIN_MESSAGE_MAX_CHARS = 400;

/** Why this person can't be reached on the step's channel, or null when they can. */
function missingAddress(
  channel: SequenceStep["channel"],
  cadence: { prospect_email: string | null; prospect_linkedin_url: string | null },
): string | null {
  if (channel === "email" && !cadence.prospect_email?.trim()) return "prospect has no email";
  if (
    channel === "linkedin" &&
    !(cadence.prospect_linkedin_url && canonicalLinkedInProfileKey(cadence.prospect_linkedin_url))
  ) {
    return "prospect has no LinkedIn profile";
  }
  return null;
}

/** Advance past the current step, completing the cadence after the last one. */
function advanceOrComplete(
  opts: RunCadenceStepOptions,
  seq: Sequence,
  stepEntryIndex: number,
): void {
  const ledger = getLedger();
  const next = seq.steps[stepEntryIndex + 1];
  ledger.advanceCadence({
    prospectId: opts.prospectId,
    playName: opts.playName,
    newStep: stepEntryIndex + 1,
    nextDueAt: next ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString() : null,
  });
  if (!next) {
    ledger.setCadenceStatus({
      prospectId: opts.prospectId,
      playName: opts.playName,
      status: "completed",
    });
  }
}

/**
 * Before a LinkedIn message: has the invite been accepted? A synced
 * conversation with the prospect says yes (null: go ahead). Otherwise the
 * step waits a day, and after LINKEDIN_INVITE_TIMEOUT_DAYS the invite is
 * withdrawn and the cadence stops.
 */
async function awaitLinkedInAcceptance(
  opts: RunCadenceStepOptions,
  cadence: { prospect_linkedin_url: string | null },
): Promise<RunCadenceStepResult | null> {
  const ledger = getLedger();
  if (
    linkedInConversationFor({
      workspace: currentWorkspaceName(),
      prospectId: opts.prospectId,
      linkedinUrl: cadence.prospect_linkedin_url,
    })
  ) {
    return null;
  }
  // The newest invite is the one pending: an earlier one may have been
  // withdrawn by hand and the person invited again.
  const invite = ledger
    .listLinkedInInviteEvents(opts.prospectId, opts.playName)
    .findLast((e) => e.status === "sent");
  const invitedAt = invite ? Date.parse(sqliteToIso(invite.created_at)) : Date.now();
  const days = (Date.now() - invitedAt) / (24 * 3600 * 1000);
  if (days < LINKEDIN_INVITE_TIMEOUT_DAYS) {
    if (!opts.dryRun) {
      ledger.postponeCadence({
        prospectId: opts.prospectId,
        playName: opts.playName,
        nextDueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
    }
    return {
      action: "waiting",
      payload: null,
      receiptIds: [],
      note: "waiting for the LinkedIn invite to be accepted",
    };
  }
  const note = `LinkedIn invite not accepted after ${LINKEDIN_INVITE_TIMEOUT_DAYS} days`;
  if (opts.dryRun)
    return { action: "skipped", payload: null, receiptIds: [], note: `${note} — would withdraw` };
  let invitationId: string | null = null;
  let sentBy: { workspace: string; accountId: string } | null = null;
  try {
    const meta = JSON.parse(invite?.metadata_json ?? "{}") as {
      invitationId?: unknown;
      accountId?: unknown;
      accountWorkspace?: unknown;
    };
    invitationId = typeof meta.invitationId === "string" ? meta.invitationId : null;
    if (typeof meta.accountId === "string" && typeof meta.accountWorkspace === "string") {
      sentBy = { workspace: meta.accountWorkspace, accountId: meta.accountId };
    }
  } catch {
    invitationId = null;
  }
  // Withdraw through the account that sent the invite; older events fall back.
  const account = sentBy ?? linkedInOutreachAccount();
  let withdrawStatus: string | null = null;
  if (invitationId && account && opts.linkedIn) {
    try {
      const res = (await opts.linkedIn(account.workspace, {
        kind: "withdraw",
        accountId: account.accountId,
        invitationId,
        idempotencyKey: `gtm:${currentWorkspaceName()}:cadence:${opts.prospectId}:${opts.playName}:withdraw:${invitationId}`,
        playName: opts.playName,
      })) as { status?: string };
      withdrawStatus = res.status ?? null;
      // not_pending: accepted or gone some other way: nothing was withdrawn.
      if (isWithdrawnStatus(withdrawStatus)) {
        ledger.recordSequenceEvent({
          prospectId: opts.prospectId,
          playName: opts.playName,
          stepIndex: 0,
          channel: "linkedin",
          status: "withdrawn",
          metadata: { invitationId, withdrawStatus },
        });
      }
    } catch (err) {
      logEvent(
        "cadence.linkedin_withdraw_failed",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      // Leave the invite's cadence running and try again tomorrow: stopping
      // here would strand the invite pending with nothing to retry it.
      ledger.postponeCadence({
        prospectId: opts.prospectId,
        playName: opts.playName,
        nextDueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
      return {
        action: "waiting",
        payload: null,
        receiptIds: [],
        note: `${note} — withdraw failed, retrying tomorrow`,
      };
    }
  }
  ledger.stopCadence({
    prospectId: opts.prospectId,
    playName: opts.playName,
    reason: "other",
    note,
  });
  return {
    action: "completed",
    payload: null,
    receiptIds: [],
    note: withdrawStatus
      ? `${note} — invite ${withdrawStatus}`
      : `${note} — withdraw it from /queue`,
  };
}

/**
 * The LinkedIn sequence every LinkedIn-channel cadence runs, whatever its
 * play: a first message once the invite is accepted, then one last note.
 * Day offsets count from the previous touch; the first message also waits
 * for acceptance (awaitLinkedInAcceptance).
 */
function linkedInSequence(playName: string): Sequence {
  return {
    playName,
    steps: [
      {
        id: "linkedin:1",
        dayOffset: 2,
        channel: "linkedin",
        breakOnReply: true,
        label: "first LinkedIn message",
        builder: (ctx) => buildLinkedInMessage(ctx, playName, "first"),
      },
      {
        id: "linkedin:2",
        dayOffset: 6,
        channel: "linkedin",
        breakOnReply: true,
        label: "LinkedIn breakup",
        builder: (ctx) => buildLinkedInMessage(ctx, playName, "last"),
      },
    ],
  };
}

async function buildLinkedInMessage(
  ctx: CadenceContext,
  playName: string,
  which: "first" | "last",
): Promise<StepPayload | null> {
  const ledger = getLedger();
  const prior = ledger
    .listSequenceEventsForProspectPlay(ctx.prospect.id, playName)
    .filter((e) => e.channel === "linkedin" && e.status === "sent")
    .map((e) => {
      try {
        const m = JSON.parse(e.metadata_json ?? "{}") as { body?: unknown; note?: unknown };
        const text = typeof m.body === "string" ? m.body : typeof m.note === "string" ? m.note : "";
        return text ? `STEP ${e.step_index}: ${text}` : null;
      } catch {
        return null;
      }
    })
    .filter((line): line is string => line !== null);
  const voice = voiceBlock(which === "first" ? "followup" : "breakup");
  const input = [
    `FOUNDER: ${ctx.cfg.founderName ?? ""}`,
    `PRODUCT: ${ctx.cfg.productOneLiner ?? ""}`,
    `PERSON: ${ctx.prospect.name ?? "them"}${ctx.prospect.title ? `, ${ctx.prospect.title}` : ""}${
      ctx.prospect.company ? ` at ${ctx.prospect.company}` : ""
    }`,
    `MESSAGE: ${which === "first" ? "first message after they accepted the connection request" : "last message — a short, graceful close"}`,
    "PRIOR TOUCHES:",
    ...(prior.length > 0 ? prior.map((l) => `  ${l}`) : ["  (none recorded)"]),
    ...(voice ? [`VOICE:\n${voice.text}`] : []),
    `MAX_CHARS: ${LINKEDIN_MESSAGE_MAX_CHARS}`,
  ].join("\n");
  const res = await complete({
    messages: [
      { role: "system", content: loadPrompt("linkedin-message") },
      { role: "user", content: input },
    ],
    temperature: 0.7,
    maxTokens: 700,
  });
  const text = res.content.trim().replace(/^"|"$/g, "");
  return text ? { kind: "linkedin_message", text } : null;
}
