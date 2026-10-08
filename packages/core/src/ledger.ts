import { recoverLearningApplications } from "./learning-decisions.ts";
import type { DecisionReason } from "@oneshot-gtm/shared-types";
import { recordManualQueueSend, type ManualQueueSend } from "./ledger-manual.ts";
import { extractBusinessAddress } from "./mail-address.ts";
import type { DirectMailDraft, PostalAddress } from "./direct-mail.ts";
import { Database } from "bun:sqlite";

import { basename, dirname, join, resolve } from "node:path";
import { demoMode } from "./demo.ts";
import { openStateDatabase } from "./sqlite-open.ts";
import type { OutreachChannel } from "./channels.ts";
import { workspacesDir } from "./workspaces.ts";
import { configDir } from "./config.ts";
import {
  applyReadonlyBusyTimeout,
  freePages as adminFreePages,
  LEDGER_BUSY_TIMEOUT_MS,
  optimizeOnClose,
  truncateWal,
  vacuum as adminVacuum,
} from "./ledger-admin.ts";
import { claimMarker, clearMarker } from "./ledger-markers.ts";
import {
  bounceStatsByIdentity as delivBounceStatsByIdentity,
  contactSuppressionFor as delivContactSuppressionFor,
  countAutoPermanentBounces as delivCountAutoPermanentBounces,
  countBounces as delivCountBounces,
  latestCanaryResult as delivLatestCanaryResult,
  latestSentEmailCopy as delivLatestSentEmailCopy,
  listRecentBounces as delivListRecentBounces,
  recordBounce as delivRecordBounce,
  recordCanaryResult as delivRecordCanaryResult,
  suppressionFor as delivSuppressionFor,
} from "./delivery-health.ts";
import {
  advanceCadence as cadAdvanceCadence,
  breakupReviveHoldFor as cadBreakupReviveHoldFor,
  type CadenceWithProspect,
  clearCadenceDraft as cadClearCadenceDraft,
  countSends as cadCountSends,
  enrollCadence as cadEnrollCadence,
  eventsByPlay as cadEventsByPlay,
  hasOutreachHistory as cadHasOutreachHistory,
  lastOutreachAt as cadLastOutreachAt,
  listAllSequenceEventsForProspect as cadListAllSequenceEventsForProspect,
  listChannelEventsForProspect as cadListChannelEventsForProspect,
  listSequenceEventsForProspect as cadListSequenceEventsForProspect,
  postponeCadence as cadPostponeCadence,
  listLinkedInInviteEvents as cadListLinkedInInviteEvents,
  recordLinkedInInviteEvent as cadRecordLinkedInInviteEvent,
  getCadence as cadGetCadence,
  getCadenceDraft as cadGetCadenceDraft,
  getCadencePlan as cadGetCadencePlan,
  hasSentSequenceEvent as cadHasSentSequenceEvent,
  latestSentPlayForProspect as cadLatestSentPlayForProspect,
  listActiveCadences as cadListActiveCadences,
  listAllCadences as cadListAllCadences,
  listCadencesForProspect as cadListCadencesForProspect,
  listSequenceEventsForCadences as cadListSequenceEventsForCadences,
  listSequenceEventsForProspectPlay as cadListSequenceEventsForProspectPlay,
  markLatestStepReplied as cadMarkLatestStepReplied,
  prospectHasFirstTouch as cadProspectHasFirstTouch,
  recentSentEmailBodies as cadRecentSentEmailBodies,
  recordCadenceReply as cadRecordCadenceReply,
  recordCadenceSendError as cadRecordCadenceSendError,
  recordLinkedInReply as cadRecordLinkedInReply,
  suppressCadencesForReply,
  recordProspectReply as cadRecordProspectReply,
  recordSequenceEvent as cadRecordSequenceEvent,
  saveCadencePlan as cadSaveCadencePlan,
  setCadenceDraft as cadSetCadenceDraft,
  setCadenceStatus as cadSetCadenceStatus,
  stopCadence as cadStopCadence,
  sweepStaleCadenceSends as cadSweepStaleCadenceSends,
} from "./ledger-cadence.ts";
import { LedgerCache } from "./ledger-cache.ts";
import {
  DraftVersionStore,
  type AngleUsageRow,
  type DraftDiscardReason,
  type DraftSlot,
  type DraftUsage,
  type DraftUsageByStep,
  type DraftVersionRow,
} from "./ledger-drafts.ts";
import {
  deleteDirectMail as dmDeleteDirectMail,
  findDirectMail as dmFindDirectMail,
  getDirectMail as dmGetDirectMail,
  getMailAddress as dmGetMailAddress,
  getMailAddressMetadata as dmGetMailAddressMetadata,
  getMailPreparation as dmGetMailPreparation,
  listDirectMail as dmListDirectMail,
  recordMailReceipt as dmRecordMailReceipt,
  saveDirectMail as dmSaveDirectMail,
  saveMailPreparation as dmSaveMailPreparation,
  deleteMailPreparation as dmDeleteMailPreparation,
  setMailAddress as dmSetMailAddress,
  setMailAddresses as dmSetMailAddresses,
  setMailAddressMetadata as dmSetMailAddressMetadata,
} from "./ledger-direct-mail.ts";
import { InboxStore } from "./ledger-inbox.ts";
import {
  confirmMeetingMatch as mtgConfirmMeetingMatch,
  dismissMeetingMatch as mtgDismissMeetingMatch,
  getMeeting as mtgGetMeeting,
  latestMeetingOutcomeFor as mtgLatestMeetingOutcomeFor,
  listMeetingsForReview as mtgListMeetingsForReview,
  listPendingOutcomeMeetings as mtgListPendingOutcomeMeetings,
  markMeetingPrompted as mtgMarkMeetingPrompted,
  setMeetingOutcome as mtgSetMeetingOutcome,
  touchMeetingLastSeen as mtgTouchMeetingLastSeen,
  upsertMeeting as mtgUpsertMeeting,
} from "./ledger-meetings.ts";
import {
  countOutcomes as outCountOutcomes,
  listDealOutcomesForProspect as outListDealOutcomesForProspect,
  listLatestOutcomeRecordedAtByProspect as outListLatestOutcomeRecordedAtByProspect,
  outcomesByPlay as outOutcomesByPlay,
  recordOutcome as outRecordOutcome,
} from "./ledger-outcomes.ts";
import { IcpProposalStore } from "./icp-proposal-store.ts";
import { LearningStore } from "./learning-store.ts";
import { SendDeliveryStore } from "./ledger-delivery.ts";
import { OutboundSendStore } from "./ledger-outbound.ts";
import { canonicalLinkedInProfileKey, ProspectStore } from "./ledger-prospects.ts";
import { QueueStore } from "./ledger-queue.ts";
import {
  appendRunEvent as runAppendRunEvent,
  cancelRun as runCancelRun,
  createRun as runCreateRun,
  getRun as runGetRun,
  listRuns as runListRuns,
  markRunComplete as runMarkRunComplete,
  setRunSentEmails as runSetRunSentEmails,
  sweepStaleRuns as runSweepStaleRuns,
} from "./ledger-runs.ts";
import { runLedgerMigrations } from "./ledger-schema.ts";
import {
  applyTriggerConfigs as trgApplyTriggerConfigs,
  clearTriggerClaim as trgClearTriggerClaim,
  getTrigger as trgGetTrigger,
  listTriggers as trgListTriggers,
  markTriggerRunning as trgMarkTriggerRunning,
  setTriggerConfig as trgSetTriggerConfig,
  setTriggerEnabled as trgSetTriggerEnabled,
  sweepStaleRunningTriggers as trgSweepStaleRunningTriggers,
  updateTriggerLastPoll as trgUpdateTriggerLastPoll,
  upsertTrigger as trgUpsertTrigger,
} from "./ledger-triggers.ts";
import {
  assignSender as sendAssignSender,
  countEmailSendsSince as sendCountEmailSendsSince,
  firstEmailSendAt as sendFirstEmailSendAt,
  getSenderAssignment as sendGetSenderAssignment,
  hasPriorEmailSend as sendHasPriorEmailSend,
  liveSendReservations as sendLiveSendReservations,
  releaseSendReservation as sendReleaseSendReservation,
  reserveSendSlot as sendReserveSendSlot,
} from "./ledger-sending.ts";
import {
  releaseSpendReservation as spendReleaseSpendReservation,
  reserveSpend as spendReserveSpend,
  reserveSpendIfUnderCeiling as spendReserveSpendIfUnderCeiling,
  reservedSpendUsd as spendReservedSpendUsd,
  sweepStaleSpendReservations as spendSweepStaleSpendReservations,
} from "./ledger-spend.ts";
import { MailboxStore } from "./mailbox-store.ts";
import { type ReceiptCompaction, ReceiptStore } from "./ledger-receipts.ts";
import {
  clearWebhookReplays as sysClearWebhookReplays,
  consumeWebhookReplay as sysConsumeWebhookReplay,
  deletePendingResolution as sysDeletePendingResolution,
  getPollWatermark as sysGetPollWatermark,
  isPendingResolution as sysIsPendingResolution,
  listColdProspects as sysListColdProspects,
  listPendingResolution as sysListPendingResolution,
  markPendingResolutionAttempted as sysMarkPendingResolutionAttempted,
  recentXHarvestedTweetIds as sysRecentXHarvestedTweetIds,
  recordInterview as sysRecordInterview,
  recordXHarvestedTweets as sysRecordXHarvestedTweets,
  releaseWebhookReplay as sysReleaseWebhookReplay,
  setPollWatermark as sysSetPollWatermark,
  sweepStalePendingResolution as sysSweepStalePendingResolution,
  upsertPendingResolution as sysUpsertPendingResolution,
} from "./ledger-system.ts";
import { sharedDbPath } from "./shared-db.ts";
import { SharedPeople } from "./shared-people.ts";
import type { ReplyKind } from "./reply-classify.ts";
import type {
  AuthVerdict,
  BounceKind,
  BounceRecord,
  CanaryResultRecord,
  ChannelEventRecord,
  DealOutcomeRecord,
  GmailPlacement,
  InboxReplyIntentDetails,
  InboxReplyRecord,
  IcpDecisionExample,
  InterviewRecord,
  MeetingMatchMethod,
  MeetingMatchStatus,
  MeetingOutcome,
  MeetingRecord,
  ProspectPriority,
  ProspectRecord,
  SentOutcomeRawRow,
  QueueRow,
  QueueSearchOpts,
  QueueSearchRow,
  QueueStatus,
  ReceiptRecord,
  SequenceEventRecord,
  TriggerRow,
  QualifiedOutcomeExample,
} from "./types.ts";

const DEFAULT_DB_PATH = join(configDir(), "ledger.sqlite");

// Re-export cache constants for the Ledger public API.
export {
  ENRICH_CACHE_TTL_MS,
  ENRICH_DEADLINE_MS,
  ENRICH_FAILURE_TTL_MS,
  LINKEDIN_CACHE_TTL_MS,
  LINKEDIN_MISS_TTL_MS,
  RESEARCH_CACHE_TTL_MS,
  RESEARCH_DEADLINE_MS,
} from "./ledger-cache.ts";

// Re-export the profile-key helper for the Ledger public API.
export { canonicalLinkedInProfileKey };

// Re-export cadence types for the Ledger public API.
export type { CadenceWithProspect } from "./ledger-cadence.ts";

// Re-export the busy-timeout constant and truncateWal for the Ledger
// public API (ledger-admin.ts); several call sites import these directly
// off ledger.ts rather than the module they actually live in now.
export { LEDGER_BUSY_TIMEOUT_MS, truncateWal };

/**
 * A plain connection to a ledger file, for code that reads (or, like LinkedIn
 * delivery, rewrites) another workspace's ledger without building a `Ledger`.
 * A bare `new Database()` has no busy timeout, so it fails with "database is
 * locked" the instant that workspace's server is writing; this one waits like
 * `Ledger` does. It runs no migrations.
 */
export function openLedgerDatabase(path: string, opts: { readonly?: boolean } = {}): Database {
  if (!opts.readonly) {
    // A write handle opens like Ledger does: owner-only file (healing an old
    // 0644 one and its -wal/-shm), and the same foreign keys.
    return openStateDatabase(path, { busyTimeoutMs: LEDGER_BUSY_TIMEOUT_MS, foreignKeys: true });
  }
  const db = new Database(path, { readonly: true });
  applyReadonlyBusyTimeout(db, LEDGER_BUSY_TIMEOUT_MS);
  return db;
}

export class Ledger {
  readonly mailboxes: MailboxStore;
  recordManualQueueSend(input: ManualQueueSend): { prospectId: number } {
    return recordManualQueueSend(this.db, this, input);
  }

  private db: Database;
  private path: string;
  private receipts: ReceiptStore;
  private cache: LedgerCache;
  private inbox: InboxStore;
  private queue: QueueStore;
  /** Unified learning proposals, approved guidance and job leases (learning-store.ts, #813). */
  readonly learning: LearningStore;
  /** Compatibility surface over `learning` for the #750 ICP proposal job and routes. */
  readonly icpProposals: IcpProposalStore;
  /** Sent-folder delivery checks for sends with no idempotency key (ledger-delivery.ts). */
  readonly sendDelivery: SendDeliveryStore;
  /** One row per intended outbound email, keyed by a semantic idempotency key (ledger-outbound.ts). */
  readonly outboundSends: OutboundSendStore;
  /**
   * Draft versions for cadence follow-ups (ledger-drafts.ts). Intro drafts
   * are versioned by `QueueStore` through its own instance. The table is the
   * same, the handle is the same, and neither store keeps state.
   */
  private drafts: DraftVersionStore;
  private prospects: ProspectStore;
  private people: SharedPeople | null = null;

  constructor(path: string = DEFAULT_DB_PATH, options: { sharedPeoplePath?: string } = {}) {
    this.path = path;
    // Owner-only file, WAL, synchronous=NORMAL, enforced foreign keys, and a
    // busy timeout so a concurrent writer (a background send and a request
    // both opening the ledger, or parallel test workers migrating a shared
    // file) is waited out instead of surfacing as "database is locked" /
    // "no such table" mid-migration. See sqlite-open.ts.
    this.db = openStateDatabase(path, {
      busyTimeoutMs: LEDGER_BUSY_TIMEOUT_MS,
      foreignKeys: true,
    });
    this.migrate();
    // Build the prospect store before refreshSharedPeople uses it. Mail-address
    // accessors resolve lazily, so later stores need not exist yet.
    this.prospects = new ProspectStore(this.db, {
      get: (key) => this.getMailAddress(key),
      set: (key, address, source) => this.setMailAddress(key, address, source),
      getMetadata: (key) => this.getMailAddressMetadata(key),
    });
    // Recognise both the active home and named workspaces opened by maintenance tools.
    // Arbitrary fixture databases and demo homes must not enter the live person registry.
    const namedWorkspace =
      basename(path) === "ledger.sqlite" && dirname(dirname(resolve(path))) === workspacesDir();
    if (options.sharedPeoplePath || (!demoMode() && (path === DEFAULT_DB_PATH || namedWorkspace))) {
      this.people = new SharedPeople(options.sharedPeoplePath ?? sharedDbPath());
      this.prospects.ensureSharedPersonColumn();
      // Scope `SharedPeople`'s ledger-agnostic membership/link calls to this
      // ledger's own path, matching what the inline `Ledger.bindSharedPerson`
      // used to do before issue #751 round-1 moved the transaction bodies
      // into `ProspectStore`.
      const people = this.people;
      this.prospects.attachSharedIdentity({
        get: (id) => people.get(id),
        resolve: (input, knownId) => people.resolve(input, knownId),
        membership: (prospectId) => people.membership(this.path, prospectId),
        link: (prospectId, personId) => people.link(this.path, prospectId, personId),
        version: () => people.version(),
      });
      this.refreshSharedPeople();
    }
    // Build stores after migration so their tables exist.
    this.receipts = new ReceiptStore(this.db);
    this.cache = new LedgerCache(this.db, this.path);
    this.inbox = new InboxStore(this.db);
    this.mailboxes = new MailboxStore(this.db);
    this.queue = new QueueStore(this.db);
    this.drafts = new DraftVersionStore(this.db);
    this.learning = new LearningStore(this.db);
    this.icpProposals = new IcpProposalStore(this.learning);
    this.sendDelivery = new SendDeliveryStore(this.db);
    this.outboundSends = new OutboundSendStore(this.db);
  }

  getDirectMail(id: string): DirectMailDraft | null {
    return dmGetDirectMail(this.db, id);
  }
  listDirectMail(): DirectMailDraft[] {
    return dmListDirectMail(this.db);
  }
  findDirectMail(
    prospect: number,
    play: string,
    enrollment: string,
    step: number,
  ): DirectMailDraft | null {
    return dmFindDirectMail(this.db, prospect, play, enrollment, step);
  }
  saveDirectMail(draft: DirectMailDraft): void {
    dmSaveDirectMail(this.db, draft);
  }
  deleteDirectMail(id: string): void {
    dmDeleteDirectMail(this.db, id);
  }
  getCadencePlan(
    prospectId: number,
    playName: string,
    enrollment: string,
  ): import("./types.ts").CadencePlanStep[] | null {
    return cadGetCadencePlan(this.db, prospectId, playName, enrollment);
  }
  saveCadencePlan(
    prospectId: number,
    playName: string,
    enrollment: string,
    steps: import("./types.ts").CadencePlanStep[],
  ): void {
    cadSaveCadencePlan(this.db, prospectId, playName, enrollment, steps);
  }
  setMailAddress(key: string, address: PostalAddress, source = "manual"): void {
    dmSetMailAddress(this.db, key, address, source);
  }
  setMailAddressMetadata(key: string, data: Record<string, unknown>): void {
    dmSetMailAddressMetadata(this.db, key, data);
  }
  getMailAddressMetadata(key: string): Record<string, unknown> | null {
    return dmGetMailAddressMetadata(this.db, key);
  }
  getMailPreparation(
    prospectId: number,
    playName: string,
    enrollment: string,
    stepIndex: number,
  ): import("./direct-mail.ts").MailPreparation | null {
    return dmGetMailPreparation(this.db, prospectId, playName, enrollment, stepIndex);
  }
  saveMailPreparation(
    prospectId: number,
    playName: string,
    enrollment: string,
    stepIndex: number,
    data: import("./direct-mail.ts").MailPreparation,
  ): void {
    dmSaveMailPreparation(this.db, prospectId, playName, enrollment, stepIndex, data);
  }
  deleteMailPreparation(
    prospectId: number,
    playName: string,
    enrollment: string,
    stepIndex: number,
  ): void {
    dmDeleteMailPreparation(this.db, prospectId, playName, enrollment, stepIndex);
  }
  setMailAddresses(prospect: number, to: PostalAddress, from: PostalAddress): void {
    dmSetMailAddresses(this.db, prospect, to, from);
  }
  getMailAddress(key: string): PostalAddress | null {
    return dmGetMailAddress(this.db, key);
  }
  recordMailReceipt(receipt: string, input: Parameters<Ledger["recordReceipt"]>[0]): number {
    return dmRecordMailReceipt(this.db, receipt, input, (i) => this.recordReceipt(i));
  }

  private migrate(): void {
    // Schema construction and migrations live in ledger-schema.ts. They run
    // only when this file's user_version is behind (see LEDGER_MIGRATIONS).
    runLedgerMigrations(this.db);
  }

  /**
   * CAS-claim a timestamp marker on a single row: true when the marker was
   * NULL (or older than `staleCutoffIso`) and was set; false when another
   * caller holds the claim. Shared by every in-flight marker in the ledger
   * (ledger-markers.ts).
   */
  private claimMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return claimMarker(this.db, opts);
  }

  /**
   * Release a timestamp marker (set to NULL). Idempotent: no-op if the row
   * doesn't exist or the column is already NULL.
   */
  private clearMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
  }): void {
    clearMarker(this.db, opts);
  }

  enrollCadence(input: {
    prospectId: number;
    playName: string;
    nextDueAt: string;
    /** Channel the cadence runs on; defaults to email. */
    channel?: OutreachChannel;
  }): void {
    cadEnrollCadence(this.db, input);
  }

  /**
   * LinkedIn invite events (send, withdrawal) for a prospect and play, any
   * status: marked `kind: "linkedin_invite"` at any step, or legacy step-0 rows.
   */
  listLinkedInInviteEvents(prospectId: number, playName: string): SequenceEventRecord[] {
    return cadListLinkedInInviteEvents(this.db, prospectId, playName);
  }

  /** Record a marked LinkedIn invite send/withdrawal: see recordLinkedInInviteEvent. */
  recordLinkedInInviteEvent(input: {
    prospectId: number;
    playName: string;
    stepIndex: number;
    status: "sent" | "withdrawn";
    metadata?: Record<string, unknown>;
  }): number {
    return cadRecordLinkedInInviteEvent(this.db, input);
  }

  /** Push an active cadence's due time out without advancing it: see postponeCadence. */
  postponeCadence(input: { prospectId: number; playName: string; nextDueAt: string }): boolean {
    return cadPostponeCadence(this.db, input);
  }

  listActiveCadences(opts: { dueByIso?: string } = {}): CadenceWithProspect[] {
    return cadListActiveCadences(this.db, opts);
  }

  listAllCadences(): CadenceWithProspect[] {
    return cadListAllCadences(this.db);
  }

  /**
   * Single cadence (joined with its prospect) by (prospect_id, play_name). An
   * index seek on the `cadence_state` PRIMARY KEY. Replaces the O(n)
   * `listAllCadences().find(...)` scan callers used to do per row.
   */
  getCadence(prospectId: number, playName: string): CadenceWithProspect | null {
    return cadGetCadence(this.db, prospectId, playName);
  }

  /** All cadences for one prospect: index seek on cadence_state.prospect_id (PK prefix). */
  listCadencesForProspect(prospectId: number): CadenceWithProspect[] {
    return cadListCadencesForProspect(this.db, prospectId);
  }

  advanceCadence(input: {
    prospectId: number;
    playName: string;
    newStep: number;
    nextDueAt: string | null;
  }): void {
    cadAdvanceCadence(this.db, this.drafts, input);
  }

  /**
   * Record the last cadence send FAILURE so /cadences can show the row is
   * blocked upstream (vs. waiting on the founder). Cleared by advanceCadence /
   * setCadenceStatus on any forward progress. No-op if the row is gone.
   */
  recordCadenceSendError(input: { prospectId: number; playName: string; error: string }): void {
    cadRecordCadenceSendError(this.db, input);
  }

  setCadenceStatus(input: {
    prospectId: number;
    playName: string;
    status: "active" | "replied" | "breakup" | "completed" | "bounced" | "off-icp" | "unsubscribed";
  }): void {
    cadSetCadenceStatus(this.db, this.drafts, input);
  }

  stopCadence(input: {
    prospectId: number;
    playName: string;
    reason: "bad_timing" | "other" | "not_a_fit" | "do_not_contact";
    note?: string;
  }): boolean {
    return cadStopCadence(this.db, this.drafts, input);
  }

  setCadenceDraft(input: {
    prospectId: number;
    playName: string;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      payload: unknown;
    };
    /** Why the preview being replaced was discarded (ledger-drafts.ts); default `redraft`. */
    discardReason?: DraftDiscardReason;
  }): void {
    cadSetCadenceDraft(this.db, this.drafts, input);
  }

  getCadenceDraft(input: { prospectId: number; playName: string }): {
    subject: string;
    body: string;
    flags: string[];
    payload: unknown;
    draftedAt: string;
  } | null {
    return cadGetCadenceDraft(this.db, input);
  }

  clearCadenceDraft(input: { prospectId: number; playName: string }): void {
    cadClearCadenceDraft(this.db, this.drafts, input);
  }

  /** Every draft version a queue row or cadence step went through, newest first (ledger-drafts.ts). */
  draftVersionsFor(slot: DraftSlot): DraftVersionRow[] {
    return this.drafts.versionsFor(slot);
  }

  /** Per play, per angle: offered / rotated away / redrafted / sent / auto-sent, counting distinct prospects. */
  angleUsageByPlay(): Record<string, AngleUsageRow[]> {
    return this.drafts.angleUsageByPlay();
  }

  /** Per play: draft-version counts by outcome, intro and follow-up apart. */
  draftUsageByPlay(): Record<string, DraftUsageByStep> {
    return this.drafts.draftUsageByPlay();
  }

  /** Per play: draft-version counts by outcome, voice card on versus off. */
  draftUsageByVoice(): Record<string, { voiced: DraftUsage; plain: DraftUsage }> {
    return this.drafts.draftUsageByVoice();
  }

  /** Intro draft outcomes by first-touch format arm (see ledger-drafts.ts). */
  draftUsageByFormat(): Record<string, Record<string, DraftUsage>> {
    return this.drafts.draftUsageByFormat();
  }

  /**
   * Save (or overwrite) the single in-progress draft for an inbox thread.
   * Backs the /inbox composer's debounced auto-save so a refresh or navigation
   * away no longer discards the draft. Keyed by thread_key (see `inboxThreadKey`
   * in shared-types): Gmail thread_id, else the email id.
   *
   * `status` is recomputed by the CALLER on every save from the body's own
   * lint state (issue #480's `commits-terms` flag). Never trust a
   * client-sent value, so the caller passes the freshly-computed verdict.
   * `steer` is deliberately NOT part of this statement: an ordinary autosave
   * must never clobber a standing founder instruction. Use
   * `setInboxDraftSteer` for that.
   */
  upsertInboxDraft(input: {
    threadKey: string;
    inboundEmailId: string;
    toEmail: string;
    subject: string;
    identityId: string | null;
    body: string;
    status?: "needs_decision" | null;
  }): void {
    this.inbox.upsertInboxDraft(input);
  }

  /**
   * Persist the founder's standing redraft instruction for a thread (issue
   * #480's steer box). A no-op if the thread has no draft row yet (the
   * steer route always upserts a draft first, so this is only ever called
   * after that succeeds).
   */
  setInboxDraftSteer(threadKey: string, steer: string | null): void {
    this.inbox.setInboxDraftSteer(threadKey, steer);
  }

  /**
   * Persist a server-generated draft body (round-1 correction, #480's steer
   * flow): `steerRoute` computes a redraft and returned it to the client
   * without ever writing it back to `inbox_drafts`, so the debounced
   * autosave (which only fires on a body DIFF) never saw a change and the
   * redraft was lost on refresh/collapse. Mirrors `saveDraftRoute`'s body
   * write but leaves `steer` and every other column untouched. The standing
   * steer instruction is set separately via `setInboxDraftSteer` and must
   * survive this call.
   */
  setInboxDraftBody(threadKey: string, body: string, status: "needs_decision" | null): void {
    this.inbox.setInboxDraftBody(threadKey, body, status);
  }

  clearInboxDraft(threadKey: string): void {
    this.inbox.clearInboxDraft(threadKey);
  }

  /**
   * Record a reply that was actually sent (append to history) and clear the
   * thread's draft in one transaction. History is append-only because we let
   * the founder reply again on the same thread.
   */
  recordInboxSent(input: {
    threadKey: string;
    toEmail: string;
    subject: string;
    body: string;
    identityId: string | null;
    requestId: string | null;
  }): void {
    this.inbox.recordInboxSent(input);
  }

  /**
   * Bulk-read persisted reply state for the inbox list route: the saved draft
   * (if any) plus the sent history per thread. Mirrors the `byEmail` map the
   * list route builds for cadence context: one read, indexed by thread_key.
   */
  getInboxThreads(): Map<
    string,
    {
      draftBody: string | null;
      sent: { body: string; sentAt: string }[];
      steer: string | null;
      status: "needs_decision" | null;
    }
  > {
    return this.inbox.getInboxThreads();
  }

  /**
   * Atomic CAS claim of the sending marker: two concurrent Send clicks can't
   * double-fire. `staleCutoffIso` lets a fresh click reclaim a marker stranded
   * by a restart before the cold-boot sweep (else the row 409s until reboot).
   */
  claimCadenceSendingMarker(input: {
    prospectId: number;
    playName: string;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return this.claimMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
      startedAtIso: input.startedAtIso,
      ...(input.staleCutoffIso ? { staleCutoffIso: input.staleCutoffIso } : {}),
    });
  }

  /** Release the sending marker for this cadence (sets sending_started_at = NULL). */
  clearCadenceSendingMarker(input: { prospectId: number; playName: string }): void {
    this.clearMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
    });
  }

  /**
   * Sweep stale `sending_started_at` markers (any non-null value when
   * `staleAgeMs` is 0, for cold-boot recovery). A matching sequence_event means
   * the send went out: clear the marker only; no event means it was stranded:
   * clear the marker but keep the draft. Returns swept rows; takes `now` +
   * `maxAgeMs` as args so tests don't fake the clock.
   */
  sweepStaleCadenceSends(input: { now: Date; maxAgeMs: number }): Array<{
    prospectId: number;
    playName: string;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    return cadSweepStaleCadenceSends(this.db, input);
  }

  findProspectByEmail(email: string): { id: number } | null {
    const local = this.prospects.findProspectByEmail(email);
    if (local) return local;
    const person = this.people?.find({ email });
    return person ? this.prospects.findProspectBySharedPersonId(person.id) : null;
  }

  /** Full prospect record by any verified email alias of the shared person. */
  getProspectByEmail(email: string): ProspectRecord | null {
    const found = this.findProspectByEmail(email);
    return found ? this.getProspectById(found.id) : null;
  }

  resolveProspectForLinkedInReply(input: {
    email?: string;
    linkedinUrl?: string;
  }): { status: "matched"; prospectId: number } | { status: "unmatched" } | { status: "conflict" } {
    const emailId = input.email ? (this.findProspectByEmail(input.email)?.id ?? null) : null;
    return this.prospects.resolveProspectForLinkedInReply(input, emailId);
  }

  suppressCadencesForReply(prospectId: number, accountKey?: string) {
    return suppressCadencesForReply(this.db, this.drafts, prospectId, accountKey);
  }

  recordLinkedInReply(input: {
    prospectId: number;
    accountKey?: string;
    source: string;
    externalEventId: string;
    occurredAt: string;
    /** The message text, when the channel supplies one. Feeds the composer. */
    body?: string | null;
  }): {
    duplicate: boolean;
    prospectId: number;
    cadencesStopped: number;
    inFlightSends: number;
  } {
    return cadRecordLinkedInReply(this.db, this.drafts, input);
  }

  /**
   * Expire live `breakup-revive` queue rows for a prospect who just replied:
   * only ever touches `target_queue`, so the write itself lives in
   * `QueueStore.expireBreakupReviveQueue`; this delegate keeps every
   * reply-handling call site above (`stopCadence`, `recordLinkedInReply`,
   * `recordProspectReply`) unchanged.
   */
  expireBreakupReviveQueue(prospectId: number, reason: string): void {
    this.queue.expireBreakupReviveQueue(prospectId, reason);
  }

  /**
   * Emails of every prospect with a recorded reply. The target list for the
   * inbox's known-replier fetch, so a reply is never lost to the live window.
   */
  listRepliedProspectEmails(): string[] {
    return this.inbox.listRepliedProspectEmails();
  }

  listInboxArchives(): Map<number, string> {
    return this.inbox.listInboxArchives();
  }

  /** Compare the caller's visible replies under the same write lock as archiving. */
  archiveInboxConversation(
    prospectId: number,
    observedReplyIds: string[],
  ): "archived" | "stale" | "missing" {
    return this.inbox.archiveInboxConversation(prospectId, observedReplyIds);
  }

  restoreInboxConversation(prospectId: number): void {
    this.inbox.restoreInboxConversation(prospectId);
  }

  /**
   * Persist one inbound reply (full body) keyed by provider email id.
   * INSERT OR IGNORE: re-sweeps and double captures are no-ops. Returns true
   * when this call stored a NEW reply.
   */
  recordInboxReply(row: {
    id: string;
    threadKey: string;
    prospectId: number;
    playName?: string | null;
    fromEmail: string;
    subject?: string | null;
    body: string;
    receivedAt: string;
    sourceIdentityId?: string | null;
    threadId?: string | null;
    messageId?: string | null;
    kind?: ReplyKind | null;
  }): boolean {
    return this.inbox.recordInboxReply(row);
  }

  /**
   * Set the sentiment/intent classification on an already-persisted reply
   * (issue #480). The triage call runs AFTER recordInboxReply so a triage
   * failure never loses the reply itself. `id IS` a no-op UPDATE if the row
   * somehow isn't there (e.g. a race), which is the correct behaviour: never
   * throw out of a best-effort classification path.
   */
  setInboxReplyIntent(
    id: string,
    intent: string | null,
    intentReason: string | null,
    details?: InboxReplyIntentDetails,
  ): void {
    this.inbox.setInboxReplyIntent(id, intent, intentReason, details);
  }

  /**
   * Atomically claim a persisted reply for triage (issue #558 round-1
   * correction). Two overlapping `pollInboxReplies()` calls (realistically:
   * the server's background scheduler tick and a manually-run `cadence
   * advance` CLI invocation) can both observe the same freshly-inserted row
   * with `intent` still NULL while the first call's `triageEmails()` await is
   * in flight. A bare re-check of the nullable `intent` column can't tell
   * "nobody has started triaging this yet" from "I already looked a moment
   * ago", so both callers would re-trigger the paid triage call and race on
   * the write-back. This flips `intent` from NULL to `INBOX_REPLY_TRIAGE_PENDING`
   * in the SAME statement that checks it's still NULL: SQLite serializes
   * writers, so only one caller's UPDATE can match a given row, and its
   * `changes` count is the claim. The winner must call `setInboxReplyIntent`
   * (real result) or release the claim (`setInboxReplyIntent(id, null, null)`
   * on failure) so a later poll can retry; the loser must skip triage
   * entirely for this row this poll.
   */
  claimInboxReplyForTriage(id: string): boolean {
    return this.inbox.claimInboxReplyForTriage(id);
  }

  /**
   * Round-2 correction (#663, F-1): thin delegate to
   * `InboxStore.peekInboxReplyIntent`: see that method's doc for why a
   * caller that lost `claimInboxReplyForTriage` cannot treat "not the
   * winner" as "not unsubscribe" and must read this back instead.
   */
  peekInboxReplyIntent(id: string): { pending: boolean; intent: string | null } {
    return this.inbox.peekInboxReplyIntent(id);
  }

  /**
   * Cold-boot recovery for `claimInboxReplyForTriage` (round-2 correction,
   * #558): every other claim-marker in this file
   * (claimCadenceSendingMarker/sweepStaleCadenceSends,
   * claimQueueSendingMarker/sweepStaleQueueSends,
   * claimRunningTrigger/sweepStaleRunningTriggers) has a paired sweep so a
   * crash between the claim UPDATE and the try/catch's release doesn't
   * strand the marker forever. This one didn't: a process death mid-triage
   * left `intent = '__triage_pending__'` permanently on the row. It could
   * never be re-claimed (the claim UPDATE only matches `intent IS NULL`) or
   * classified again, and the non-`ReplyIntent` sentinel was exposed to
   * every reader of `intent` (`listInboxReplyIntents`, the /inbox route).
   * Unlike the other markers, the claim here has no `started_at` column to
   * age against. It's held only for the duration of one in-process `await
   * triageEmails(...)`, which cannot survive past that process's death, so
   * there's no `maxAgeMs`: cold boot (called once, like the other sweeps,
   * from apps/server/src/bin.ts) is the only moment a stranded claim can be
   * told apart from one a live process still holds. Returns the number of
   * rows reset so the caller can log it.
   *
   * Known trade-off: a claim held by a live `intel backfill-intent` CLI
   * process at the instant the server boots is cleared too, and the next
   * poll may re-claim that row. The cost is one duplicated triage call
   * (cents) whose result is the same category: last writer wins, no data
   * is lost. Telling the two apart would need a claim timestamp column and
   * an age-gated sweep; not worth a schema change for that window.
   */
  sweepStaleInboxReplyTriage(): number {
    return this.inbox.sweepStaleInboxReplyTriage();
  }

  /**
   * Bulk intent lookup for a set of provider email ids. The /inbox route's
   * badge needs the persisted (LLM-classified) intent per visible reply
   * without an N+1 query. Empty input short-circuits (SQLite's `IN ()` is
   * invalid syntax, not just slow).
   */
  listInboxReplyIntents(ids: string[]): ReturnType<InboxStore["listInboxReplyIntents"]> {
    return this.inbox.listInboxReplyIntents(ids);
  }

  /** All persisted inbound replies for one prospect, oldest first. */
  listInboxRepliesForProspect(prospectId: number): InboxReplyRecord[] {
    return this.inbox.listInboxRepliesForProspect(prospectId);
  }

  /** Recent human replies on a play with one of the given intents (#813). */
  listRepliesByIntentForPlay(
    playName: string,
    intents: readonly string[],
    limit = 20,
  ): InboxReplyRecord[] {
    return this.inbox.listRepliesByIntentForPlay(playName, intents, limit);
  }

  /** Provider ids of every persisted reply: dedupe set for capture passes. */
  listInboxReplyIds(): Set<string> {
    return this.inbox.listInboxReplyIds();
  }

  /**
   * Every persisted HUMAN reply with no intent classification yet (issue
   * #480). The backfill target for `oneshot-gtm intel backfill-intent` and
   * for any pre-#480 install's existing history. `COALESCE(kind,'human')`
   * mirrors the same predicate `listSentOutcomeRows` uses: pre-v23 rows with
   * a NULL kind read as human everywhere.
   */
  listUntriagedHumanReplies(limit = 200, sinceIso?: string): InboxReplyRecord[] {
    return this.inbox.listUntriagedHumanReplies(limit, sinceIso);
  }

  /** Untriaged human replies the live poll missed, with failure backoff: the retry sweep's target. */
  listStaleUntriagedHumanReplies(
    opts: Parameters<InboxStore["listStaleUntriagedHumanReplies"]>[0],
  ): InboxReplyRecord[] {
    return this.inbox.listStaleUntriagedHumanReplies(opts);
  }

  /** Every human reply not mid-triage, oldest first: `backfill-intent --reclassify`'s target. */
  listHumanRepliesForReclassify(
    opts: { sinceIso?: string; limit?: number } = {},
  ): InboxReplyRecord[] {
    return this.inbox.listHumanRepliesForReclassify(opts);
  }

  /** Prospects that have at least one persisted reply, most recent activity first. */
  listProspectIdsWithReplies(): number[] {
    return this.inbox.listProspectIdsWithReplies();
  }

  /** Full prospect record by id (PK seek). Avoids loading every prospect to find one. */
  getProspectById(id: number): ProspectRecord | null {
    const prospect = this.prospects.withSharedIdentity(this.prospects.getProspectRow(id));
    return this.prospects.attachMailAddress(prospect, id);
  }

  /**
   * Paid-lookup caches live in the cross-workspace SHARED DB (shared-db.ts):
   * the same person must never be bought twice across products. Delegated to
   * `LedgerCache` (ledger-cache.ts, #618), which keeps the same contracts.
   */
  getCachedEnrichment(
    email: string,
  ): { result_json: string; fetched_at: string; status: string | null } | null {
    return this.cache.getCachedEnrichment(email);
  }

  getCachedLinkedIn(
    queryKey: string,
  ): { url: string | null; status: string; fetched_at: string } | null {
    return this.cache.getCachedLinkedIn(queryKey);
  }

  setCachedLinkedIn(queryKey: string, url: string | null): void {
    this.cache.setCachedLinkedIn(queryKey, url);
  }

  setCachedEnrichment(email: string, resultJson: string): void {
    this.cache.setCachedEnrichment(email, resultJson);
  }

  setCachedEnrichmentFailure(email: string, message: string): void {
    this.cache.setCachedEnrichmentFailure(email, message);
  }
  /** Rows under a namespaced cache prefix written since `sinceIso` (successes only). */
  countCachedEnrichmentSince(prefix: string, sinceIso: string): number {
    return this.cache.countCachedEnrichmentSince(prefix, sinceIso);
  }

  recordReceipt(input: {
    playName: string;
    callType: string;
    /** Per-call USD cost. Every wrapper in `oneshot.ts` reads `result.cost`
     *  from the SDK response (declared on every result type in
     *  `@oneshot-agent/sdk@0.15.2+`) and forwards it here. NULL in the
     *  column when undefined: visible signal that the SDK omitted cost. */
    costUsd?: number;
    signedReceipt?: unknown;
    oneshotRequestId?: string;
    /** EmailIdentity id for email.send receipts: drives per-identity daily caps. */
    senderIdentity?: string;
    /** Call-time memo (the same value sent to OneShot); defaults to "{play} {callType}". */
    memo?: string;
    /** Call-time decisionContext blob; JSON-stringified into the column. */
    decisionContext?: unknown;
    /** Send-capacity reservation this email.send receipt consumes (issue #794). */
    reservationId?: number;
  }): number {
    return this.receipts.recordReceipt(input);
  }

  /**
   * Run `fn` under SQLite's write lock (BEGIN IMMEDIATE) so a sender pick's
   * capacity read and its reservation are one step across processes (#794).
   */
  withSendCapacityLock<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  reserveSendSlot(groupKey: string, identityId: string, now = new Date()): number {
    return sendReserveSendSlot(this.db, groupKey, identityId, now);
  }

  releaseSendReservation(id: number): void {
    sendReleaseSendReservation(this.db, id);
  }

  liveSendReservations(now = new Date()) {
    return sendLiveSendReservations(this.db, now);
  }

  getSenderAssignment(email: string): string | null {
    return sendGetSenderAssignment(this.db, email);
  }

  /**
   * Pin a prospect email to a sending identity. INSERT OR IGNORE + read-back
   * makes concurrent first-touches race-safe: both callers end up using the
   * single winning assignment instead of splitting the thread across senders.
   */
  assignSender(email: string, identityId: string): string {
    return sendAssignSender(this.db, email, identityId);
  }

  /**
   * Sends by an identity since `sinceUtcSqlite`. The timestamp MUST be in
   * SQLite datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC): receipts
   * default created_at to that format, and an ISO string with its 'T'
   * separator compares GREATER than any same-day SQLite timestamp, silently
   * excluding today's rows.
   */
  countEmailSendsSince(identityId: string, sinceUtcSqlite: string): number {
    return sendCountEmailSendsSince(this.db, identityId, sinceUtcSqlite);
  }

  /**
   * Did we ever email this address pre-rotation? Used to lazy-pin legacy
   * prospects (e.g. in-flight cadences) to the legacy identity instead of
   * letting the rotation picker move their thread to a new From address.
   */
  hasPriorEmailSend(email: string): boolean {
    return sendHasPriorEmailSend(this.db, email);
  }

  /** First email.send by this identity (warm-up ramp anchor). SQLite-format UTC or null. */
  firstEmailSendAt(identityId: string): string | null {
    return sendFirstEmailSendAt(this.db, identityId);
  }

  /**
   * Record one delivery failure. INSERT OR IGNORE on (message_id, recipient):
   * the sweep re-sees the same DSN every tick and it must count once. Returns
   * true only for a NEW bounce: callers gate receipt-tagging/logging on that.
   */
  recordBounce(input: {
    messageId: string;
    recipient: string;
    identityId: string | null;
    kind: BounceKind;
    statusCode: string | null;
    diagnostic: string | null;
    prospectId: number | null;
    bouncedAt: string;
  }): boolean {
    return delivRecordBounce(this.db, input);
  }

  /**
   * The hard bounce that suppresses this address, or null if it's still
   * sendable. HARD ONLY. A `block` is the receiving server refusing a message
   * on policy, not a statement that the mailbox is dead, so suppressing on it
   * would permanently burn valid prospects over one spam-filter verdict.
   * Soft bounces are transient by definition.
   */
  suppressionFor(email: string): BounceRecord | null {
    return delivSuppressionFor(this.db, email);
  }

  /**
   * A do-not-send verdict from the reply stream: the newest 'unsubscribe'
   * (they asked to stop) or 'auto_permanent' (their responder says the
   * mailbox is dead) captured from this address. Durable on purpose. It
   * outlives any one cadence, so a later play can never re-enroll and email
   * an unsubscribed or gone prospect. Sibling of suppressionFor (bounces).
   *
   * `kind` is the declared reason, not necessarily the row's raw `kind`
   * column: a reply whose phrase-classified `kind` stayed 'human' but whose
   * sentiment-triaged `intent` (issue #480) reads 'unsubscribe' is reported
   * here as 'unsubscribe' too (issue #666), since callers use this value to
   * choose between an "unsubscribed" and a "bounced" outcome.
   */
  contactSuppressionFor(email: string): { kind: string; received_at: string } | null {
    return delivContactSuppressionFor(this.db, email);
  }

  /** Permanent manual-stop hold used only by breakup-revive's final send backstop. */
  breakupReviveHoldFor(email: string): { reason: string; stopped_at: string } | null {
    const prospect = this.findProspectByEmail(email);
    if (!prospect) return null;
    return cadBreakupReviveHoldFor(this.db, prospect.id);
  }

  /** Bounce counts per sending identity since `sinceIso`. The doctor check's numerator. */
  bounceStatsByIdentity(opts: {
    sinceIso: string;
  }): Map<string, { hard: number; block: number; soft: number }> {
    return delivBounceStatsByIdentity(this.db, opts);
  }

  /** Most recent bounces for display (doctor detail lines, debugging). */
  listRecentBounces(opts: { limit?: number } = {}): BounceRecord[] {
    return delivListRecentBounces(this.db, opts);
  }

  /**
   * Count of distinct recorded delivery-failure events in the window, keyed
   * by `bounces`' own (message_id, recipient) PK. The Slack daily summary's
   * `bounced` total (issue #71 round-3 review finding). Deliberately NOT
   * derived from `sequence_events`: `pollInboxBounces` inserts one
   * sequence_events row PER CADENCE a bounced prospect is enrolled in, so a
   * single DSN for a prospect in 2+ concurrent cadences would be counted
   * multiple times there, and it skips sequence_events entirely for soft
   * bounces and for bounces on prospects with no ledger match. Both of
   * which still land here and still fire `notifySlackBounceRecorded`. This
   * table is the one row per real bounce event; `bounced_at` is NOT NULL on
   * every row (unlike sequence_events', which predates the column on old
   * rows), so no COALESCE fallback is needed. Sibling of
   * countAutoPermanentBounces (the reply-stream bounce path, which never
   * writes to this table).
   */
  countBounces(opts: { sinceIso?: string; untilIso?: string } = {}): number {
    return delivCountBounces(this.db, opts);
  }

  /**
   * Count of distinct dead-mailbox autoresponder events ("auto_permanent"
   * reply kind, see reply-classify.ts) in the window. The OTHER bounce
   * source the Slack daily summary's `bounced` total must include alongside
   * countBounces (DSN bounces never touch `sequence_events`; this reply-
   * stream path never touches `bounces`). Counted from `inbox_replies`, NOT
   * `sequence_events` (issue #71 round-1 correction): `pollInboxReplies`
   * (and the /inbox route's opportunistic capture) call `recordInboxReply`
   * for EVERY matched auto_permanent email unconditionally, but only write a
   * `sequence_events` row inside the `listCadencesForProspect(...).filter
   * (status active|paused)` loop right after. A dead-mailbox reply for a
   * prospect whose only cadence is already terminal (or who has none) still
   * fires `notifySlackBounceRecorded` and is persisted here, but would never
   * produce a `sequence_events` row to count. `inbox_replies.id` is the
   * provider's own message id and PRIMARY KEY (INSERT OR IGNORE), so each
   * real event is already exactly one row: no de-dup math needed, unlike
   * countBounces' sibling problem on the multi-cadence `sequence_events`
   * path.
   */
  countAutoPermanentBounces(opts: { sinceIso?: string; untilIso?: string } = {}): number {
    return delivCountAutoPermanentBounces(this.db, opts);
  }

  recordCanaryResult(input: {
    fromIdentity: string;
    toIdentity: string;
    placement: GmailPlacement;
    labelIds: string[];
    auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
    subject: string | null;
    sourcePlay: string | null;
    sameDomain: boolean;
    latencyMs: number | null;
  }): number {
    return delivRecordCanaryResult(this.db, input);
  }

  /** Newest placement test, or null if one has never been run. */
  latestCanaryResult(): CanaryResultRecord | null {
    return delivLatestCanaryResult(this.db);
  }

  /**
   * Subject + body of the most recent email this tool actually SENT, for the
   * placement canary to replay. Spam filters judge content, so testing with
   * invented copy would measure nothing that transfers to real outreach.
   * Reads the persisted draft off the sequence_events row (metadata_json
   * carries {subject, body} for sent email steps).
   */
  latestSentEmailCopy(
    opts: { playName?: string } = {},
  ): { subject: string; body: string; playName: string } | null {
    return delivLatestSentEmailCopy(this.db, opts);
  }

  /**
   * Bodies of the most recent email sends for one play + step, newest first.
   * Feeds the opener-frequency lint: a follow-up step that keeps reaching for
   * the same opening words is a fingerprint, and only the ledger knows what
   * the last N sends actually opened with.
   *
   * Same status set as `latestSentEmailCopy`: 'sent' rows are UPDATEd in
   * place to 'replied', so matching only 'sent' would silently drop every
   * prospect who answered and skew the share.
   */
  recentSentEmailBodies(opts: { playName: string; stepIndex: number; limit?: number }): string[] {
    return cadRecentSentEmailBodies(this.db, opts);
  }

  getReceipt(id: number): ReceiptRecord | null {
    return this.receipts.getReceipt(id);
  }

  /** Trim pre-slimming receipt payloads (see `slimReceiptPayload`). Dry run unless `apply`. */
  compactReceiptPayloads(opts: { apply: boolean }): ReceiptCompaction {
    return this.receipts.compactPayloads(opts);
  }

  findContactReceipt(
    input: { email: string } | { fullName: string; companyDomain: string },
  ): ReceiptRecord | null {
    return this.receipts.findContactReceipt(input);
  }

  listReceipts(
    opts: { playName?: string; sinceIso?: string; limit?: number } = {},
  ): ReceiptRecord[] {
    return this.receipts.listReceipts(opts);
  }

  /**
   * Link legacy workspace IDs without renumbering any queue, cadence or
   * reply history. The transaction body lives in `ProspectStore.refreshSharedIdentity`
   * (issue #751 round-1 correction); `Ledger` keeps this method for
   * backward-compat call sites and the module-level singleton getter below.
   */
  refreshSharedPeople(): void {
    this.prospects.refreshSharedIdentity();
  }

  /** Add membership to the same person, preserving this workspace's independent history. */
  linkSharedProspect(personId: string): number {
    const person = this.people?.get(personId);
    if (!person) throw Error("Shared person does not exist");
    const { id, ...identity } = person;
    return this.upsertProspect({ ...identity, shared_person_id: id, source: "workspace-link" });
  }

  /**
   * Upsert with shared-identity resolution. The transaction body lives in
   * `ProspectStore.upsertProspectWithIdentity` (issue #751 round-1
   * correction); `Ledger` keeps this method name for its existing public
   * signature, return value, and transaction boundary.
   */
  upsertProspect(input: Partial<ProspectRecord> & { email?: string | null }): number {
    return this.prospects.upsertProspectWithIdentity(input);
  }

  /**
   * Backfill identity columns that are NULL on an existing prospect. The only
   * such path (`upsertProspect` never writes twice). COALESCE on purpose: a
   * backfill must never clobber a URL a finder already resolved, and
   * `undefined`/`null` leaves the column untouched. True when a column changed.
   */
  updateProspectIdentity(
    id: number,
    patch: {
      linkedin_url?: string | null;
      phone?: string | null;
      company?: string | null;
      source_profile_url?: string | null;
      title?: string | null;
    },
  ): boolean {
    if (this.people) {
      const row = this.prospects.getProspectRow(id);
      if (row) {
        const effective = { ...row };
        for (const key of [
          "linkedin_url",
          "phone",
          "company",
          "source_profile_url",
          "title",
        ] as const)
          if (!effective[key] && patch[key]?.trim()) effective[key] = patch[key]!.trim();
        const canonical = this.people.resolve(effective, row.shared_person_id ?? undefined);
        patch = { ...patch };
        for (const key of ["linkedin_url", "phone", "company", "title"] as const)
          if (patch[key]?.trim()) patch[key] = canonical[key];
      }
    }
    return this.prospects.updateProspectIdentity(id, patch);
  }

  /**
   * Correct a prospect's current role from research. `updateProspectIdentity`
   * is write-once by design (COALESCE), which is right for identity fields
   * captured at finder time but wrong for a title the LinkedIn history says
   * has changed since. Plain overwrite of the given keys only; the finder's
   * originals live inside the dossier person record, not in new columns.
   */
  setProspectCurrentRole(id: number, patch: { title?: string; company?: string }): boolean {
    const sharedId = this.people && this.getProspectById(id)?.shared_person_id;
    if (sharedId) this.people!.setRole(sharedId, patch);
    return this.prospects.setProspectCurrentRole(id, patch);
  }

  /**
   * Record the person-level ICP verdict for a prospect. Overwrites. A
   * re-audit with better data (a real title instead of a stale event bio)
   * must be able to flip an earlier call in either direction.
   *
   * `unclear` is a real, persisted verdict: qualifyPerson is 4-state, and
   * writing its ambiguity as NULL made "we looked and couldn't tell"
   * indistinguishable from "never judged". It is PROVISIONAL, not settled:
   * _qualify.ts escalates `unclear` rather than dropping a candidate, so a
   * re-audit re-judges those rows (picking up role text that arrived since)
   * and skips only pass/reject. Suppression is unaffected. The cadence gate
   * tests `=== "reject"`, so `unclear` fails open exactly as NULL did.
   * `transient` is never persisted; it stays a retry signal.
   *
   * Full contract now lives on `ProspectStore.setProspectIcpVerdict`
   * (ledger-prospects.ts); this thin delegate keeps the existing call site
   * unchanged. STATUS.md's `null`/`unclear` fail-open reference has been
   * updated to point at the new location.
   */
  setProspectIcpVerdict(
    id: number,
    verdict: "pass" | "reject" | "unclear",
    reason?: string | null,
  ): void {
    this.prospects.setProspectIcpVerdict(id, verdict, reason);
  }

  /**
   * Persist a research dossier onto an existing prospect.
   *
   * Deliberately NOT part of updateProspectIdentity: that method's column
   * allowlist is write-once (COALESCE(NULLIF(col,''), ?)), which is right for
   * identity fields but wrong here: re-researching a person must be able to
   * refresh a stale dossier. Plain overwrite; callers decide whether to skip
   * rows that already have one. Pass null to clear.
   */
  setProspectDossier(id: number, dossier: string | null): void {
    this.prospects.setProspectDossier(id, dossier);
  }

  /**
   * Persist a synthesized per-prospect angle (issue #355) onto an existing
   * prospect. Plain UPDATE, mirroring `setProspectDossier`: NOT
   * `upsertProspect`, which skips existing rows and would silently no-op
   * every backfill call. Pass null to clear both columns together, so
   * `angle_synthesized_at` can never point at a row with no `angle_json`.
   */
  setProspectAngle(id: number, angle: string | null, opts?: { approvedAt?: string | null }): void {
    this.prospects.setProspectAngle(id, angle, opts);
  }

  /** A revision of the angle was proposed for review (#813). */
  setProspectAngleProposedAt(id: number, at: string | null): void {
    this.prospects.setProspectAngleProposedAt(id, at);
  }

  /**
   * Write ONE half of a prospect's dossier without clobbering the other.
   *
   * `research-prospects` owns the `person` half and `research-products` owns
   * `product`, and each was doing read → merge → write with the read outside
   * any transaction. Two writers, one column, a wide window between them: the
   * later write silently reverts the earlier one.
   *
   * Not theoretical. It happened during this feature's own dogfood run. The
   * workspace server researched a prospect while a script held a merge in
   * flight, and the curated person half vanished under an API one. The reads
   * were seconds apart.
   *
   * BEGIN IMMEDIATE via `db.transaction` takes the write lock before the
   * re-read, so the merge sees the current value and no one can interleave
   * between the two statements.
   */
  mergeProspectDossierHalf(
    id: number,
    half: "person" | "product",
    value: unknown,
    slice?: number,
  ): void {
    this.prospects.mergeProspectDossierHalf(id, half, value, slice);
  }

  /**
   * Prospects that could take a LinkedIn URL but don't have one. Rows already
   * holding a GitHub/X URL in `linkedin_url` are skipped (updateProspectIdentity
   * won't overwrite them); a name is required. The lookup searches by name.
   */
  listProspectsMissingLinkedIn(opts: { limit?: number; play?: string } = {}): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
  }> {
    return this.prospects.listProspectsMissingLinkedIn(opts);
  }

  /**
   * Prospects worth buying a research dossier for, by scope:
   *
   * - `active`. A cadence is still running, so a dossier changes what gets sent
   * - `replied`. A live conversation, where reply drafting reads the dossier
   * - `unjudged`: no ICP verdict AND a profile URL to research, so the gate can judge
   * - `all`. Every prospect
   *
   * Scopes union. Rows that already hold a dossier are excluded unless
   * `includeResearched`, so an interrupted run resumes instead of re-buying.
   * A row needs a social URL or an email: deepResearchPerson has nothing to
   * chase otherwise.
   */
  listProspectsForResearch(
    opts: {
      scopes?: ReadonlyArray<"active" | "replied" | "unjudged" | "all">;
      includeResearched?: boolean;
      limit?: number;
    } = {},
  ): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
    linkedin_url: string | null;
    dossier_json: string | null;
  }> {
    return this.prospects.listProspectsForResearch(opts);
  }

  /**
   * Prospects worth synthesizing a per-prospect angle for (issue #355), by
   * scope. Mirrors `listProspectsForResearch`'s scope semantics exactly:
   *
   * - `active`. A cadence is still running, so a sharper angle changes what
   *                gets sent once drafting reads it (#356)
   * - `replied`. A live conversation; the reply history is itself an input
   *                to the synthesis (corrections, "not what I meant", etc.)
   * - `unjudged`: no ICP verdict yet, so the angle's `relationship` /
   *                `valueMode` read can inform the gate
   * - `all`. Every prospect
   *
   * Scopes union, not intersect. Unlike `listProspectsForResearch`, this does
   * NOT require a social URL or email: reply history alone is enough input
   * for a synthesis, and gatherAngleEvidence degrades gracefully when GitHub
   * lookups have nothing to chase. Rows that already hold an angle are
   * excluded unless `includeSynthesized`, so an interrupted backfill resumes
   * instead of re-synthesizing (and re-billing) rows already done.
   */
  listProspectsForAngle(
    opts: {
      scopes?: ReadonlyArray<"active" | "replied" | "unjudged" | "all">;
      includeSynthesized?: boolean;
      limit?: number;
    } = {},
  ): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
    linkedin_url: string | null;
    dossier_json: string | null;
    angle_json: string | null;
  }> {
    return this.prospects.listProspectsForAngle(opts);
  }

  recordOutcome(input: {
    prospectId: number;
    playName?: string;
    outcome: "meeting_booked" | "sql_qualified" | "deal_won" | "deal_lost" | "ghosted";
    amountUsd?: number;
    notes?: string;
  }): number {
    return outRecordOutcome(this.db, input);
  }

  /** Latest outcome timestamp per prospect, bulk-read to acknowledge earlier positive replies. */
  listLatestOutcomeRecordedAtByProspect(): Map<number, string> {
    return outListLatestOutcomeRecordedAtByProspect(this.db);
  }

  countOutcomes(
    opts: {
      sinceIso?: string;
      playName?: string;
      outcome?: string;
    } = {},
  ): number {
    return outCountOutcomes(this.db, opts);
  }

  outcomesByPlay(opts: { sinceIso?: string } = {}): Array<{
    play_name: string | null;
    meetings: number;
    sqls: number;
    won: number;
    lost: number;
    ghosted: number;
    won_value_usd: number;
  }> {
    return outOutcomesByPlay(this.db, opts);
  }

  listColdProspects(opts: {
    minDaysSinceLastEvent: number;
    maxDaysSinceLastEvent: number;
    limit?: number;
  }): Array<{
    id: number;
    name: string | null;
    email: string | null;
    company: string | null;
    linkedin_url: string | null;
    phone: string | null;
    last_event_at: string | null;
  }> {
    return sysListColdProspects(this.db, opts);
  }

  recordSequenceEvent(input: {
    prospectId: number;
    playName: string;
    stepIndex: number;
    channel: SequenceEventRecord["channel"];
    status: SequenceEventRecord["status"];
    metadata?: unknown;
    /** The send receipt this step produced: links the step to its billable call
     *  so an outcome (reply/deal) can tag the receipt's value. */
    receiptId?: number;
    /**
     * The provider's own bounce timestamp (DSN `bouncedAt`), for `status:
     * "bounced"` rows only. `created_at` is stamped at POLL/detection time:
     * this is the real occurrence time, so date-windowed rollups (the Slack
     * daily summary) attribute the bounce to the day it actually happened
     * rather than the day the mailbox happened to be polled.
     */
    bouncedAt?: string;
  }): number {
    return cadRecordSequenceEvent(this.db, input);
  }

  /** Persist the RoCS value tag (JSON `{type,amount?,label?}`) on a single receipt. */
  setReceiptValueTag(receiptId: number, valueTagJson: string): void {
    this.receipts.setReceiptValueTag(receiptId, valueTagJson);
  }

  /**
   * Local mirror of a goal-level value tag: stamp every receipt in the cadence
   * (matching `goal_id`) so the /receipts UI shows the value per row. Returns the
   * number of receipts touched. The platform records the value once per goal via
   * `tagReceiptValue({goalId})`; this just keeps the dashboard in sync.
   */
  setReceiptValueTagByGoal(goalId: string, valueTagJson: string): number {
    return this.receipts.setReceiptValueTagByGoal(goalId, valueTagJson);
  }

  /** Current local value tag for a goal (any one of its receipts), or null. */
  currentGoalValueTag(goalId: string): string | null {
    return this.receipts.currentGoalValueTag(goalId);
  }

  /**
   * Human labels (play + prospect) for a set of goalIds, derived from the local
   * receipts so the Measure page can render OneShot's opaque goal_id rollups as
   * "{play} → {prospect}". First receipt per goal wins.
   */
  goalLabels(goalIds: string[]): Map<string, { playName: string | null; prospect: string | null }> {
    return this.receipts.goalLabels(goalIds);
  }

  /**
   * True when a (prospect, play, step) already has a terminal-sent
   * sequence_event. Pre-dispatch guard: a crash between recordSequenceEvent
   * and advanceCadence leaves current_step lagging the sent step. This stops
   * the re-send on the next due tick.
   */
  hasSentSequenceEvent(prospectId: number, playName: string, stepIndex: number): boolean {
    return cadHasSentSequenceEvent(this.db, prospectId, playName, stepIndex);
  }

  /**
   * Mark the latest sent step `replied`. A state transition of the existing
   * step, NOT a new event, so `sent` counts stay correct. Idempotent per
   * (prospect, play) via the NOT EXISTS guard; returns true on the one call
   * that flips a row. Stamps `replied_at` to the actual reply moment. The
   * row's `created_at` stays pinned to the original SEND time, so date-windowed
   * rollups (eventsByPlay, the Slack daily summary) must use replied_at, not
   * created_at, to count a reply on the day it happened rather than the day it
   * was sent. `repliedAt` defaults to now (the manual-reply / UI-send path,
   * where the moment of the call IS the reply); the background inbox poll
   * passes the inbound email's own `received_at` so a reply pulled from a
   * backlog page (arriving in this process well after it actually landed in
   * the mailbox) is still credited to the day it was actually sent, not the
   * day this poll happened to run.
   */
  markLatestStepReplied(input: {
    prospectId: number;
    playName: string;
    repliedAt?: string | null;
  }): boolean {
    return cadMarkLatestStepReplied(this.db, input);
  }

  /**
   * Single source of truth for "a prospect replied to a cadence": writes both
   * planes in one transaction so they can't drift. Control plane
   * (`cadence_state.status='replied'`) is conservative: only a live cadence
   * (`active`/`paused`) flips, so a terminal sequence is never resurrected.
   * Analytics plane (sequence_events) is unconditional: the event is recorded
   * for ANY status: gating the two together silently drops replies that
   * arrive after a sequence finishes. Count replies on `eventRecorded` (true
   * exactly once per (prospect, play)); `newlyReplied` marks the control
   * transition.
   */
  recordCadenceReply(input: { prospectId: number; playName: string; repliedAt?: string | null }): {
    newlyReplied: boolean;
    eventRecorded: boolean;
  } {
    return cadRecordCadenceReply(this.db, this.drafts, input);
  }

  /**
   * Record a reply and stop every live cadence for the prospect:
   * nobody keeps getting follow-ups after answering. Analytics: the reply is
   * credited to the play whose sent subject it threads on
   * (`Re: …`), else the most recent play that emailed them. Returns one entry
   * per play touched. `repliedAt` (default now) should be the inbound
   * email's own received/sent timestamp when known: see
   * markLatestStepReplied's note on why the background inbox poll must pass
   * it rather than let this stamp the moment the poll happened to run.
   */
  recordProspectReply(
    prospectId: number,
    opts?: { subject?: string | null; repliedAt?: string | null },
  ): Array<{ playName: string; newlyReplied: boolean; eventRecorded: boolean }> {
    return cadRecordProspectReply(this.db, this.drafts, prospectId, opts);
  }

  /**
   * Which play an EMAIL reply belongs to. With a subject, the sent email whose
   * subject it threads on wins (reply prefixes in a few languages stripped, case
   * and whitespace ignored); otherwise, or when nothing matches, the prospect's
   * most recent sent email. Other channels (sms/voice/linkedin) are never
   * credited with an email reply. Null if never emailed.
   */
  latestSentPlayForProspect(prospectId: number, replySubject?: string | null): string | null {
    return cadLatestSentPlayForProspect(this.db, prospectId, replySubject);
  }

  getPollWatermark(key: string): string | null {
    return sysGetPollWatermark(this.db, key);
  }

  setPollWatermark(key: string, value: string): void {
    sysSetPollWatermark(this.db, key, value);
  }

  /**
   * A play's prior steps for one prospect. Every send, plus a letter the
   * founder skipped (#610), so the cadence history says why step N never
   * went out. The conversation view (`listSequenceEventsForProspect`) stays
   * sends-only; so does every counter.
   */
  listSequenceEventsForProspectPlay(prospectId: number, playName: string): SequenceEventRecord[] {
    return cadListSequenceEventsForProspectPlay(this.db, prospectId, playName);
  }

  /** Every sent step for a prospect across ALL plays. The outreach half of a conversation timeline. */
  listSequenceEventsForProspect(prospectId: number): SequenceEventRecord[] {
    return cadListSequenceEventsForProspect(this.db, prospectId);
  }

  /**
   * Bulk variant of listSequenceEventsForProspectPlay: one round-trip, Map
   * keyed `${prospect_id}|${play_name}`, same (step_index ASC, id ASC)
   * ordering. Index-served by idx_sequence_events_prospect_play.
   */
  listSequenceEventsForCadences(
    pairs: ReadonlyArray<{ prospectId: number; playName: string }>,
  ): Map<string, SequenceEventRecord[]> {
    return cadListSequenceEventsForCadences(this.db, pairs);
  }

  recordInterview(input: Omit<InterviewRecord, "id" | "created_at">): number {
    return sysRecordInterview(this.db, input);
  }

  countSends(opts: { playName?: string } = {}): number {
    return cadCountSends(this.db, opts);
  }

  spendByPlay(
    opts: { sinceIso?: string } = {},
  ): Array<{ play_name: string; calls: number; total_usd: number }> {
    return this.receipts.spendByPlay(opts);
  }

  /**
   * Per-play rollup of sequence_events, windowed by `sinceIso`/`untilIso`.
   *
   * By default every column windows on `created_at` alone: byte-for-byte the
   * pre-existing behaviour every current caller (home.ts's sentLast7d/
   * repliedLast7d, measure.ts's reply-rate %, weekly-review.ts) depends on,
   * which guarantees `replied <= sent` for any window: a reply can only be
   * counted once its originating send's `created_at` already falls inside
   * the same window.
   *
   * Pass `occurrenceWindow: true` to window `replied`/`bounced` on their OWN
   * occurrence column instead (COALESCEd onto `created_at` for older rows
   * that predate it), which the Slack daily summary needs so a reply or
   * bounce landing the day AFTER it was sent still shows up on the day it
   * actually happened rather than vanishing from every completed-day rollup.
   * See `ledger-cadence.ts`'s `eventsByPlay` for the full contract.
   */
  eventsByPlay(
    opts: { sinceIso?: string; untilIso?: string; occurrenceWindow?: boolean } = {},
  ): Array<{
    play_name: string;
    sent: number;
    delivered: number;
    replied: number;
    bounced: number;
  }> {
    return cadEventsByPlay(this.db, opts);
  }

  /**
   * How many receipts fall in the window.
   *
   * Callers wanting a count must not list the rows and measure the array: the
   * Today page did exactly that behind a `limit: 1000`, so any install busy
   * enough to exceed it reported precisely 1000 calls a week, for ever, with
   * nothing in the response to say it had been truncated.
   */
  countReceipts(opts: { sinceIso?: string; playName?: string } = {}): number {
    return this.receipts.countReceipts(opts);
  }

  /**
   * Daily signed spend per play, for the trend sparklines on Measure.
   *
   * Bucketed in SQL rather than by listing receipts and grouping in the
   * browser. The page used to pull 500 rows and bucket them client-side, which
   * silently became a five-hour window once an install carried tens of
   * thousands of receipts; and `new Date("YYYY-MM-DD HH:MM:SS")` parses as
   * local time, so the buckets drifted by the viewer's UTC offset. `date()`
   * here has neither problem.
   */
  spendSeriesByPlay(opts: { days: number }): Array<{
    play_name: string;
    day: string;
    total_usd: number;
  }> {
    return this.receipts.spendSeriesByPlay(opts);
  }

  totalSpendUsd(opts: { sinceIso?: string; playName?: string } = {}): number {
    return this.receipts.totalSpendUsd(opts);
  }

  /**
   * Hold `amountUsd` against the daily ceiling for the duration of an
   * automated call. Returns the reservation id: callers MUST release it
   * (on success or failure) via `releaseSpendReservation`, else it counts
   * against the ceiling until `sweepStaleSpendReservations` reclaims it.
   */
  reserveSpend(amountUsd: number): number {
    return spendReserveSpend(this.db, amountUsd);
  }

  /** Release a reservation once the caller's actual spend has posted (or the call was skipped/failed). */
  releaseSpendReservation(id: number): void {
    spendReleaseSpendReservation(this.db, id);
  }

  /** Sum of currently-held reservations since `sinceIso` (the local-midnight boundary). */
  reservedSpendUsd(sinceIso: string): number {
    return spendReservedSpendUsd(this.db, sinceIso);
  }

  /**
   * Atomic check-then-reserve against the daily ceiling (issue #481
   * round-1 review finding). The read (posted spend + held reservations
   * since `sinceIso`) and the write (INSERT into `spend_reservations`)
   * happen inside ONE transaction on this connection. The same
   * `BEGIN IMMEDIATE` pattern `dequeueApproved` uses to close its own
   * cross-process claim race. IMMEDIATE takes SQLite's RESERVED write lock
   * at the START of the transaction (not the default DEFERRED, which only
   * locks on the first write), so in WAL mode two separate OS processes,
   * e.g. a `find watch --once` cron run and the server's in-process
   * scheduler firing the same tick, cannot both read the pre-reservation
   * total and both pass the check before either commits: the second
   * caller's transaction blocks until the first one's reservation is
   * already reflected in the sum it reads. Returns the new reservation id
   * when granted, or null when posted+reserved+`amountUsd` would EXCEED
   * `ceilingUsd`. Landing exactly on the ceiling is allowed: the ceiling is
   * "spend up to this", and a finder whose worst-case estimate equals the
   * ceiling (`config spend-ceiling 5` against a `maxCostUsd: 5` finder) must
   * still be able to fire once, with `>=` it never could, reporting
   * "$0.00/$5.00 spent today" while refusing forever (#488).
   */
  reserveSpendIfUnderCeiling(opts: {
    sinceIso: string;
    ceilingUsd: number;
    amountUsd: number;
  }): number | null {
    return spendReserveSpendIfUnderCeiling(this.db, {
      ...opts,
      postedSpendUsd: (sinceIso) => this.totalSpendUsd({ sinceIso }),
    });
  }

  /**
   * Sweep reservations older than `maxAgeMs`. A crashed process (kill -9
   * between reserve and release) must not hold spend against the ceiling for
   * the rest of the day. Returns the number of rows swept.
   */
  sweepStaleSpendReservations(maxAgeMs: number, now = new Date()): number {
    return spendSweepStaleSpendReservations(this.db, maxAgeMs, now);
  }

  /** Recent reviewed rows for few-shot ICP classification. */
  recentIcpDecisions(limit = 20, opts: { reasoned?: boolean } = {}): IcpDecisionExample[] {
    return this.queue.recentIcpDecisions(limit, opts);
  }

  /** Count of human approve/reject decisions available to the ICP classifiers (learning-loop v2, #750). */
  countHumanIcpDecisions(opts: { reasoned?: boolean } = {}): number {
    return this.queue.countHumanIcpDecisions(opts);
  }

  /** Founder-recorded meeting/SQL/won outcomes with review context (#813). */
  qualifiedOutcomeExamples(limit = 20): QualifiedOutcomeExample[] {
    return this.queue.qualifiedOutcomeExamples(limit);
  }

  /**
   * Insert a row into target_queue. Returns the new id, or null if a row with
   * the same (play_name, dedupe_key) already exists.
   */
  enqueueTarget(input: {
    playName: string;
    payload: unknown;
    dedupeKey: string;
    source: string;
    notes?: string;
    /**
     * Status to insert with. Defaults to "pending" (the normal review path).
     * Pass "rejected" to record an auto-drop (e.g. ICP filter said no) so the
     * founder can see what was filtered out and override if needed.
     */
    initialStatus?: QueueStatus;
    /**
     * Shadow-mode priority artifact, persisted verbatim. Omit/null for
     * producers that can't score (manual rows, legacy callers, auto-drops).
     */
    priority?: ProspectPriority | null;
    /** Outreach channel of the first touch; defaults to email (channels.ts). */
    channel?: OutreachChannel;
  }): number | null {
    return this.queue.enqueueTarget(input);
  }

  isQueueDuplicate(playName: string, dedupeKey: string): boolean {
    return this.queue.isQueueDuplicate(playName, dedupeKey);
  }

  /**
   * Persist a candidate whose paid resolution hit a transient platform error,
   * so the retry pass can complete it later (and re-scan won't re-create it).
   * Idempotent: a re-discovered candidate keeps its original first_seen_at and
   * attempt count (the retry pass owns attempt bookkeeping).
   */
  upsertPendingResolution(input: {
    playName: string;
    dedupeKey: string;
    source: string;
    raw: unknown;
  }): void {
    sysUpsertPendingResolution(this.db, input);
  }

  /** True when (play, dedupeKey) is awaiting retry: finders OR this into their dedup. */
  isPendingResolution(playName: string, dedupeKey: string): boolean {
    return sysIsPendingResolution(this.db, playName, dedupeKey);
  }

  /** Pending rows (optionally one play), oldest first, for the retry pass. */
  listPendingResolution(opts?: { playName?: string; limit?: number }): Array<{
    play_name: string;
    dedupe_key: string;
    source: string;
    raw_json: string;
    first_seen_at: string;
    last_attempt_at: string | null;
    attempts: number;
  }> {
    return sysListPendingResolution(this.db, opts);
  }

  /** Mark a pending row as just-attempted (bumps attempts + last_attempt_at). */
  markPendingResolutionAttempted(playName: string, dedupeKey: string): void {
    sysMarkPendingResolutionAttempted(this.db, playName, dedupeKey);
  }

  deletePendingResolution(playName: string, dedupeKey: string): void {
    sysDeletePendingResolution(this.db, playName, dedupeKey);
  }

  /**
   * Purge pending rows older than maxAgeMs (permanently-unresolvable or an
   * aged-out time-windowed source) so their dedupe_key frees for future
   * re-discovery and the table doesn't silt. Returns the number removed.
   */
  sweepStalePendingResolution(maxAgeMs: number): number {
    return sysSweepStalePendingResolution(this.db, maxAgeMs);
  }

  /** Tweet ids the x-reposters finder paid for since `cutoffIso`: skipped on the next harvest. */
  recentXHarvestedTweetIds(cutoffIso: string): Set<string> {
    return sysRecentXHarvestedTweetIds(this.db, cutoffIso);
  }

  /**
   * Record tweets just paid for and prune rows past the skip window in one
   * transaction, so the table can't silt. Re-recording an id refreshes its
   * timestamp (a re-buy inside the freshness window restarts its clock).
   */
  recordXHarvestedTweets(ids: string[], nowIso: string, pruneCutoffIso: string): void {
    sysRecordXHarvestedTweets(this.db, ids, nowIso, pruneCutoffIso);
  }

  /**
   * Cross-play dedup (finder side): is this email in a non-terminal queue row
   * under ANY play? Catches the window before either play has sent (no
   * prospect row exists yet). Matches both `email` and `founderEmail`.
   */
  isEmailPendingInQueue(email: string): boolean {
    return this.queue.isEmailPendingInQueue(email);
  }

  /**
   * The LinkedIn-channel twin of the email dedupe: a known prospect with this
   * profile, or a live queue row in any play carrying it.
   */
  isLinkedInProfileKnown(linkedinUrl: string): boolean {
    const prospect = this.prospects.resolveProspectForLinkedInReply({ linkedinUrl }, null);
    return prospect.status !== "unmatched" || this.queue.isLinkedInPendingInQueue(linkedinUrl);
  }

  /**
   * Cross-play dedup (send side): has this prospect already received an initial
   * (step-0) touch under ANY play? The authoritative guard against first-touching
   * the same person twice. Mirrors the step-0 existence check in
   * sweepStaleCadenceSends. Note: deliberate re-engagement (breakup-revive)
   * bypasses this via sendDraftedEmail's `allowRecontact`.
   */
  prospectHasFirstTouch(prospectId: number): boolean {
    return cadProspectHasFirstTouch(this.db, prospectId);
  }

  /**
   * Look up a queue row by its (play_name, dedupe_key). The unique pair.
   * Used by the SSE /run endpoint to map drafts back to the originating
   * row so we can persist `last_draft_json`. Returns null when absent.
   */
  getQueueRowByDedupe(playName: string, dedupeKey: string): QueueRow | null {
    return this.queue.getQueueRowByDedupe(playName, dedupeKey);
  }

  listQueue(
    opts: { playName?: string; status?: QueueStatus; limit?: number; ids?: number[] } = {},
  ): QueueRow[] {
    return this.queue.listQueue(opts);
  }

  getQueueRow(id: number): QueueRow | null {
    return this.queue.getQueueRow(id);
  }

  /**
   * Most recent queue row linked to a prospect. The finder's original signal
   * that queued them, used as evidence input to angle synthesis (issue #355).
   * Not every prospect has one: manually added prospects, or rows whose queue
   * entry was never linked via `setQueueProspectId`, return null.
   *
   * Tiebreak on `id DESC` after `found_at DESC`: `found_at` is
   * second-granularity (`datetime('now')`), so two rows queued within the
   * same second (routine in a fast backfill or a test) would otherwise tie
   * and return whichever SQLite happens to prefer.
   */
  getQueueRowForProspect(prospectId: number): QueueRow | null {
    return this.queue.getQueueRowForProspect(prospectId);
  }

  /**
   * The /prospects browse view: every queue row, any status, searched, sorted
   * and paged. `q` is a deliberate full scan (LIKE over json_extract can use
   * no index): measured at ~50 ms on 9k rows. Past ~100k rows an FTS5
   * external-content table is the upgrade path; nothing here would change
   * shape. Without `q` the derived table is pruned by the status/play
   * indexes like `listQueue`.
   */
  searchQueue(opts: QueueSearchOpts): { rows: QueueSearchRow[]; total: number | null } {
    return this.queue.searchQueue(opts);
  }

  /**
   * Per-status counts for the /prospects filter chips under the current
   * search/play/decided filters. The status filter itself is left out so a
   * chip can show how many rows it would reveal.
   */
  searchQueueStatusCounts(
    opts: Pick<QueueSearchOpts, "q" | "playName" | "decidedBy">,
  ): Record<QueueStatus, number> {
    return this.queue.searchQueueStatusCounts(opts);
  }

  /** Every play that has ever enqueued a row, for the /prospects play filter. */
  listQueuePlayNames(): string[] {
    return this.queue.listQueuePlayNames();
  }

  /**
   * Every recorded step for a prospect across all plays: including bounced,
   * failed and unsubscribed ones, which `listSequenceEventsForProspect`
   * (the conversation view) filters out. `queued` rows are reservations,
   * not history. Oldest first.
   */
  listAllSequenceEventsForProspect(prospectId: number): SequenceEventRecord[] {
    return cadListAllSequenceEventsForProspect(this.db, prospectId);
  }

  /** Inbound engagement on non-email channels (LinkedIn replies) for one prospect, oldest first. */
  listChannelEventsForProspect(prospectId: number): ChannelEventRecord[] {
    return cadListChannelEventsForProspect(this.db, prospectId);
  }

  /** Recorded deal outcomes for one prospect, oldest first. */
  listDealOutcomesForProspect(prospectId: number): DealOutcomeRecord[] {
    return outListDealOutcomesForProspect(this.db, prospectId);
  }

  /** Remove an unreviewed queue reservation, leaving reviewed rows untouched. */
  removePendingQueueTarget(id: number): boolean {
    return this.queue.removePendingQueueTarget(id);
  }

  removeExpiredQueueTarget(id: number): boolean {
    return this.queue.removeExpiredQueueTarget(id);
  }

  setQueueStatus(input: {
    id: number;
    status: QueueStatus;
    notes?: string;
    /**
     * Who made this transition. Defaults are per-status, chosen so every
     * existing unannotated caller stays correctly classified:
     * - approved → "human": approving IS the review act; no machine path
     *   approves single rows today (bulk goes through approveAllPending).
     * - rejected/sent → "machine": auto-reject gates and drain sends call
     *   this unannotated, and an unannotated caller must never mint a human
     *   REJECTION label (a mislabeled negative poisons any future fit):
     *   the per-row UI routes pass "human" explicitly.
     */
    decidedBy?: "human" | "machine";
    /** The founder's structured reason (#813); see QueueStore.setQueueStatus. */
    decisionReason?: DecisionReason | null;
  }): void {
    let storedFitReason: string | null = null;
    if (input.status === "approved" && input.decidedBy !== "machine") {
      const row = this.queue.getQueueRow(input.id);
      if (row && (row.channel == null || row.channel === "email")) {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          /* Legacy malformed payload. */
        }
        if (payload && !["pass", "reject", "unclear"].includes(String(payload.icpVerdict))) {
          const email =
            typeof payload.email === "string" && payload.email.trim()
              ? payload.email.trim()
              : payload.founderEmail;
          const prospect = typeof email === "string" ? this.getProspectByEmail(email) : null;
          if (prospect?.icp_verdict === "reject") {
            storedFitReason = prospect.icp_verdict_reason ?? "person gate rejected";
          }
        }
      }
    }
    // Persist a row-local human override. Keep the original prospect assessment
    // intact; sendDraftedEmail honors the fresh queue verdict first.
    this.queue.setQueueStatus({ ...input, storedFitReason });
  }

  /**
   * Atomic claim of the queue-send marker on `target_queue.send_started_at`.
   * Mirrors `claimCadenceSendingMarker` semantics: survives server restart so
   * `/queue` Send-draft UI doesn't lose its spinner on `bun --watch` reloads.
   * Cleared on success via `setQueueStatus('sent', …)`, on failure via
   * `clearQueueSendingMarker`, on cold boot via `sweepStaleQueueSends`.
   */
  claimQueueSendingMarker(input: {
    id: number;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return this.queue.claimQueueSendingMarker(input);
  }

  clearQueueSendingMarker(id: number): void {
    this.queue.clearQueueSendingMarker(id);
  }

  /**
   * Sweep queue rows whose `send_started_at` is older than `maxAgeMs` (or any
   * non-null when 0, for cold-boot recovery). Classify each row by current
   * status. Status='sent' means the SDK call landed before the kill (clear
   * the marker only); otherwise the send was stranded (clear the marker,
   * draft is still on the row for retry).
   */
  sweepStaleQueueSends(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    return this.queue.sweepStaleQueueSends(input);
  }

  approveAllPending(opts: { playName?: string } = {}): number {
    return this.queue.approveAllPending(opts);
  }

  /**
   * Atomic claim-and-return: SELECT + `drain_claimed_at` UPDATE in one
   * transaction so concurrent drains can't overlap. 15-min lease self-heals a
   * crashed drain; held/error rows back off for the lease duration.
   */
  dequeueApproved(opts: { playName: string; limit?: number; leaseSeconds?: number }): QueueRow[] {
    return this.queue.dequeueApproved(opts);
  }

  expirePendingOlderThan(days: number): number {
    return this.queue.expirePendingOlderThan(days);
  }

  queueCounts(): Record<QueueStatus, number> {
    return this.queue.queueCounts();
  }

  /**
   * Approved-row count per play, across the whole queue. Deliberately ignores
   * any status/play filter the caller is showing: /queue's drain button needs
   * to know a play has drainable rows even when the visible page is filtered
   * to `pending`. Plays with zero approved rows are absent from the map.
   */
  approvedCountsByPlay(): Record<string, number> {
    return this.queue.approvedCountsByPlay();
  }

  /** Reviewed queue outcomes for one finder inside a trailing time window. */
  finderApprovalStats(input: { finder: string; sinceIso: string }): {
    approved: number;
    reviewed: number;
    rate: number | null;
  } {
    return this.queue.finderApprovalStats(input);
  }

  // One row per /run Execute click; the SSE endpoint persists events/counters,
  // the UI rebuilds progress from the row, and the cold-boot sweep flips
  // stranded `running` rows to `interrupted`.

  createRun(input: {
    playName: string;
    dryRun: boolean;
    targets: unknown[];
    dedupeKeys?: Array<string | null>;
  }): {
    runId: number;
    startedAt: string;
  } {
    return runCreateRun(this.db, input);
  }

  /**
   * Append a single event to a run's events_json and bump the matching
   * counter. Cheap re-serialize is fine: events_json fits in a single row;
   * runs are bounded at ~25 targets typically.
   */
  appendRunEvent(input: { runId: number; event: unknown }): void {
    runAppendRunEvent(this.db, input);
  }

  /**
   * Terminal write for a run that finished on its own. Cancellation goes
   * through `cancelRun` instead. It is the only writer of 'cancelled', so a
   * cancelled row can never exist without the reason that explains it.
   */
  markRunComplete(input: {
    runId: number;
    status: "done" | "interrupted";
    sentEmails?: string[];
  }): void {
    runMarkRunComplete(this.db, input);
  }

  /**
   * Overwrite the run's record of which prospects it actually emailed, in any
   * status. Deliberately not CASed on 'running': a cancelled run's last sends
   * land after the row went terminal (the play's workers finish one by one),
   * and the /cadences?sinceRun deep-link needs them.
   */
  setRunSentEmails(input: { runId: number; sentEmails: string[] }): void {
    runSetRunSentEmails(this.db, input);
  }

  /**
   * Flip a still-'running' row to the terminal 'cancelled' state with the
   * reason it ended. CAS on `status = 'running'` makes this a no-op for a run
   * that already finished, so it races safely with
   * the SSE handler's own completion write. `sentEmails` records what did go
   * out before the abort, keeping the /cadences?sinceRun deep-link honest.
   *
   * Returns whether this call was the one that cancelled it, plus the row's
   * status afterwards (null when there is no such run).
   */
  cancelRun(input: { runId: number; reason: string; sentEmails?: string[] }): {
    cancelled: boolean;
    status: "running" | "done" | "interrupted" | "cancelled" | null;
  } {
    return runCancelRun(this.db, input);
  }

  getRun(runId: number): {
    id: number;
    playName: string;
    dryRun: boolean;
    status: "running" | "done" | "interrupted" | "cancelled";
    startedAt: string;
    completedAt: string | null;
    targetCount: number;
    draftedCount: number;
    sentCount: number;
    errorCount: number;
    targets: unknown[];
    dedupeKeys: Array<string | null>;
    events: unknown[];
    prospectEmails: string[];
    cancelReason: string | null;
  } | null {
    return runGetRun(this.db, runId);
  }

  /**
   * Compact run listing for dashboards. Returns lightweight columns only:
   * `events_json` + `targets_json` stay on the row but aren't read here so
   * `/api/home` doesn't pay to ship them on every 30s poll. Default order:
   * newest started_at first; capped at `limit` rows (default 5). When
   * `status` is set, filters via the existing `idx_runs_status` index.
   */
  listRuns(
    opts: { status?: "running" | "done" | "interrupted" | "cancelled"; limit?: number } = {},
  ): Array<{
    id: number;
    playName: string;
    status: "running" | "done" | "interrupted" | "cancelled";
    startedAt: string;
    completedAt: string | null;
    targetCount: number;
    draftedCount: number;
    sentCount: number;
    errorCount: number;
  }> {
    return runListRuns(this.db, opts);
  }

  /**
   * Sweep run rows whose status is still 'running' but predate the cutoff
   * (or any non-null when 0, for cold-boot recovery). Marks them as
   * 'interrupted' so the UI shows a truthful banner instead of an eternal
   * spinner. Returns the swept rows so the caller can log them.
   *
   * Terminal rows (including 'cancelled') are never touched: a run the user
   * cancelled must not be relabelled as a crash by the next cold boot.
   */
  sweepStaleRuns(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    playName: string;
    startedAt: string;
    ageMs: number;
  }> {
    return runSweepStaleRuns(this.db, input);
  }

  upsertTrigger(input: { name: string; configJson: string; enabled?: boolean }): void {
    trgUpsertTrigger(this.db, input);
  }

  getTrigger(name: string): TriggerRow | null {
    return trgGetTrigger(this.db, name);
  }

  listTriggers(): TriggerRow[] {
    return trgListTriggers(this.db);
  }

  /**
   * Records the result of a finished run AND clears `running_started_at` in
   * the same statement. This is the only "completed" path. Both success and
   * caught-finder-throw funnel through here, so clearing the in-flight flag
   * here is the right semantic. Also steps `company_batch_seq` by 1 (issue
   * #708 correction). The rotation cursor `companyBatchCursorFor` reads,
   * so the starting company batch advances by exactly one index every
   * completed run, unlike `last_polled_at`'s wall-clock value whose modulo
   * can repeat.
   */
  updateTriggerLastPoll(input: { name: string; summary: unknown }): void {
    trgUpdateTriggerLastPoll(this.db, input);
  }

  /**
   * Release a trigger's in-flight claim WITHOUT stamping `last_polled_at`
   * (issue #481 review finding). Used only when the finder never actually
   * ran: currently the daily spend ceiling refusal branches in
   * `registry.ts`. `updateTriggerLastPoll` would treat the refusal as a
   * completed poll and push `dueAt` a full interval into the future, so a
   * trigger blocked by the ceiling would sit unpolled long after headroom
   * (or a new day) opens back up. `last_run_summary` still records the
   * refusal reason so the dashboard/doctor surface it, same as before.
   */
  clearTriggerClaim(input: { name: string; summary: unknown }): void {
    trgClearTriggerClaim(this.db, input);
  }

  /**
   * Atomic claim: marks a trigger in-flight only if not already running. The
   * conditional UPDATE closes the TOCTOU race where two fireTriggerNow calls
   * both fire and double-spend. `staleCutoffIso` also lets the claim succeed
   * over a stale marker so a dead row doesn't 409 until the next cold boot.
   * Cleared by updateTriggerLastPoll or sweepStaleRunningTriggers.
   */
  markTriggerRunning(name: string, startedAtIso: string, staleCutoffIso?: string): boolean {
    return trgMarkTriggerRunning(this.db, name, startedAtIso, staleCutoffIso);
  }

  /**
   * Sweep stale `running_started_at` rows: write `{error:"killed_by_restart"}`
   * and clear the in-flight flag; returns swept rows. Takes `now` + `maxAgeMs`
   * as args so tests don't fake the clock.
   */
  sweepStaleRunningTriggers(input: {
    now: Date;
    maxAgeMs: number;
  }): Array<{ name: string; startedAt: string; ageMs: number }> {
    return trgSweepStaleRunningTriggers(this.db, input);
  }

  setTriggerEnabled(name: string, enabled: boolean): void {
    trgSetTriggerEnabled(this.db, name, enabled);
  }

  setTriggerConfig(name: string, configJson: string): void {
    trgSetTriggerConfig(this.db, name, configJson);
  }

  /**
   * Apply a batch of trigger config writes atomically: insert a fresh
   * enabled row for a trigger with no stored config, or update an existing
   * row's config and enable it, for every entry in ONE transaction. Used by
   * the packs apply route: `applyPackRoute` previously ran each trigger's
   * upsert/update pair outside a transaction, so a later write throwing left
   * earlier writes in the batch persisted and the route returned a 500 with
   * a half-applied pack (finding PRRT_kwDOSKzrBs6fCBct). A throw here rolls
   * back every write in the batch, not just the failing one.
   */
  applyTriggerConfigs(entries: Array<{ name: string; configJson: string }>): void {
    trgApplyTriggerConfigs(this.db, entries);
  }

  /**
   * Associate a queued target with a known prospect (so the queue page can
   * link back to the prospect record). Best-effort. The caller is expected
   * to swallow failures since the link is a convenience, not a correctness
   * invariant. Only the row's own `prospect_id` write lives in
   * `QueueStore.setQueueProspectId`; the best-effort mail-address seeding
   * below reaches into the prospect/mail-address domains, so it stays here.
   */
  setQueueProspectId(id: number, prospectId: number): void {
    this.queue.setQueueProspectId(id, prospectId);
    const row = this.getQueueRow(id);
    if (row && !this.getMailAddress(`prospect:${prospectId}`)) {
      const payload = JSON.parse(row.payload_json);
      const address = extractBusinessAddress(payload, this.getProspectById(prospectId)?.name ?? "");
      if (address)
        this.setMailAddress(
          `prospect:${prospectId}`,
          address,
          payload.businessAddressSource ?? row.source,
        );
    }
  }

  /** Save a generated draft only if no concurrent edit/send changed its inputs. */
  setQueueDraftIfCurrent(input: {
    id: number;
    previousDraft: string | null;
    previousPayload: string;
    previousChannel?: string;
    draft: Parameters<Ledger["setQueueDraft"]>[0]["draft"];
    discardReason?: DraftDiscardReason;
  }): boolean {
    return this.queue.setQueueDraftIfCurrent(input);
  }

  /** Move an unsent row to another outreach channel, dropping its draft: see QueueStore.setQueueChannel. */
  setQueueChannel(id: number, channel: OutreachChannel): "changed" | "sent" | "busy" {
    return this.queue.setQueueChannel(id, channel);
  }

  /** Drop a row's stored draft (and close its open version as a redraft): see QueueStore.clearQueueDraft. */
  clearQueueDraft(id: number): void {
    this.queue.clearQueueDraft(id);
  }

  /** Close a queue row's open draft version without a draft write (the mark-sent path). */
  closeQueueDraftVersion(id: number, outcome: "sent" | "auto_sent"): boolean {
    return this.queue.closeQueueDraftVersion(id, outcome);
  }

  /**
   * Persist the most-recent draft for this queue row (the /run page is
   * ephemeral; /queue reviews from here). Most-recent-wins: re-runs
   * overwrite without history.
   */
  setQueueDraft(input: {
    id: number;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      sent: boolean;
      receiptIds: number[];
      dryRun: boolean;
      enrichmentFailed?: boolean;
      angle?: unknown;
      /** Voice card hash and first-touch format arm the draft was written with, when set. */
      voiceKey?: string | null;
      /** Fingerprint of the approved learned-guidance set in the prompt (#813); absent when none applied. */
      learningKey?: string | null;
      formatKey?: string | null;
    };
    discardReason?: DraftDiscardReason;
    sentBy?: "human" | "machine";
  }): void {
    this.queue.setQueueDraft(input);
  }

  /**
   * Overwrite a queue row's `payload_json`. Manual add-prospect flow: the row
   * is enqueued as a placeholder, then rewritten with the researched dossier
   * so regenerate re-drafts without paying for research again.
   */
  updateQueuePayload(input: { id: number; payload: unknown }): void {
    this.queue.updateQueuePayload(input);
  }

  /**
   * The payload of the most recent SENT queue row for this play and address:
   * how a follow-up recovers the edge the intro drew its angle from (issue
   * #584), whichever path sent it (drain, /queue send-draft, mark-sent). Null
   * when nothing was sent to them on this play, or the payload won't parse.
   */
  latestSentQueuePayload(playName: string, email: string): Record<string, unknown> | null {
    return this.queue.latestSentQueuePayload(playName, email);
  }

  /** `latestSentQueuePayload` plus the row's `source`. */
  latestSentQueueRow(
    playName: string,
    email: string,
  ): { payload: Record<string, unknown>; source: string } | null {
    return this.queue.latestSentQueueRow(playName, email);
  }

  /**
   * `latestSentQueuePayload` for a whole page of cadences at once (issue
   * #599): one query over the sent rows of the plays involved, newest first,
   * keeping the first row per `play|email`. Keyed exactly like the single-row
   * lookup canonicalises (lower-cased, trimmed email). Pairs with no email are
   * skipped; an empty input touches nothing. Never throws: `json_valid`
   * keeps a malformed row out of `json_extract` (which would fail the whole
   * query), so a bad payload is simply absent from the map.
   */
  latestSentQueuePayloads(
    pairs: ReadonlyArray<{ playName: string; email: string | null }>,
  ): Map<string, Record<string, unknown>> {
    return this.queue.latestSentQueuePayloads(pairs);
  }

  /**
   * Run several ledger writes as one SQLite transaction. For the engine
   * steps that must land together (a recorded event and the state advance it
   * explains). An interruption between them would leave a row that says one
   * thing and a cadence that says another.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Merge a few keys into a LIVE queue row's payload (issue #592): pending or
   * approved, not sent, not mid-send. One statement, so there is no window
   * between checking eligibility and writing: a row that got sent between the
   * caller's listing and this call is simply not updated, and the caller is
   * told. `updateQueuePayload` above has no guard and stays for the paths that
   * own their row (the manual add's research rewrite).
   */
  patchLiveQueuePayload(input: { id: number; patch: Record<string, unknown> }): boolean {
    return this.queue.patchLiveQueuePayload(input);
  }

  latestQueueId(): number {
    return this.queue.latestQueueId();
  }

  /** Newly-created pending rows, used by the post-finder product research stage. */
  listPendingQueueAfterId(id: number): QueueRow[] {
    return this.queue.listPendingQueueAfterId(id);
  }

  getProductResearchCache(cacheKey: string, maxAgeMs: number): string | null {
    return this.cache.getProductResearchCache(cacheKey, maxAgeMs);
  }

  setProductResearchCache(cacheKey: string, dossierJson: string): void {
    this.cache.setProductResearchCache(cacheKey, dossierJson);
  }

  /**
   * Set a queue row's `notes` without touching its status. Used by the manual
   * add-prospect flow to update the transient "researching profile…" note to
   * a "no email found" flag (or a research-failed message) once the async job
   * settles. Pass an empty string to clear it.
   */
  setQueueNotes(input: { id: number; notes: string }): void {
    this.queue.setQueueNotes(input);
  }

  /**
   * Overwrite a queue row's shadow priority (the `score-prospects` backfill
   * writer). Pass null to clear.
   */
  setQueuePriority(id: number, priority: ProspectPriority | null): void {
    this.queue.setQueuePriority(id, priority);
  }

  /**
   * Rows the score-prospects backfill considers: pending + approved. Approved
   * implies unsent. A dispatched row moves to status 'sent'. Id-ascending so
   * an interrupted run resumes deterministically.
   */
  listQueueRowsForScoring(
    opts: { playName?: string; limit?: number; allStatuses?: boolean } = {},
  ): QueueRow[] {
    return this.queue.listQueueRowsForScoring(opts);
  }

  /**
   * Every sent queue row joined to its outcome evidence (Phase 3 of #410).
   * The prospect link is `prospect_id` when the post-send backfill caught it,
   * else an email join (LOWER/TRIM defeats the index: acceptable, this is an
   * offline report path over hundreds of rows). `COALESCE(kind,'human')` is
   * mandatory: pre-v23 replies have NULL kind and read as human everywhere.
   * `deal_lost`/`ghosted` map to no rank on purpose: deal_outcomes is
   * positives-only by construction (the cadences modal offers only the three
   * positive states), so its absence is never evidence of failure.
   */
  listSentOutcomeRows(opts: { playName?: string } = {}): SentOutcomeRawRow[] {
    return this.queue.listSentOutcomeRows(opts);
  }

  /**
   * The local funnel ladder: receipts value-tagged by outcome attribution
   * (engagement < meeting < qualified < revenue). Goal_id is a sha256 of
   * (play, email), not computable in SQLite, so the caller joins in JS via
   * `cadenceGoalId`.
   */
  listValueTaggedReceipts(): Array<{ goal_id: string; value_tag: string }> {
    return this.receipts.listValueTaggedReceipts();
  }

  /**
   * Reclaim free pages after a large delete/trim. VACUUM needs the database
   * to itself, so a running dashboard or CLI on this ledger makes it fail
   * with "database is locked" once busy_timeout runs out. In WAL mode the
   * rebuilt database lands in the WAL, so the checkpoint after it is what
   * actually shrinks the file.
   */
  vacuum(): void {
    adminVacuum(this.db);
  }

  /** Pages VACUUM would reclaim. */
  freePages(): number {
    return adminFreePages(this.db);
  }

  /** Path of the SQLite file this ledger opened. */
  get filePath(): string {
    return this.path;
  }

  close(): void {
    this.people?.close();
    optimizeOnClose(this.db);
    this.db.close();
  }

  /**
   * Upsert one calendar event. NEVER `INSERT OR REPLACE` (a cancellation
   * stub carries almost no fields and would wipe summary/prospect_id/
   * outcome) and NEVER `INSERT OR IGNORE` (unlike an immutable inbox_replies
   * row, an event mutates in place. A reschedule or cancellation is an
   * UPDATE to the same row). `undefined` on any field means "this poll
   * response didn't carry it" and preserves the existing value via
   * `COALESCE(excluded.col, meetings.col)`; pass `null` explicitly to CLEAR
   * a field.
   *
   * Two special cases the caller relies on:
   *  - A cancellation stub (`status: 'cancelled'`, no `startsAt`) for an
   *    event this ledger has never seen is a no-op: there's no start time
   *    to even file a ghost row under, so nothing is inserted.
   *  - A reschedule (an existing row whose `startsAt` differs from the new
   *    value) clears `outcomePromptedAt`. A stale nudge must withdraw:
   *    while leaving any already-recorded `outcome` untouched.
   *
   * Returns whether this event is new to the ledger and whether its
   * `attendeesFingerprint` changed since last seen. The poller uses the
   * latter to decide whether re-matching is worth running at all (a
   * founder's dismiss must stick until the attendee set actually changes).
   */
  upsertMeeting(input: {
    calendarId: string;
    eventId: string;
    icalUid?: string | null;
    recurringEventId?: string | null;
    status: string;
    summary?: string | null;
    allDay?: boolean;
    startsAt?: string | null;
    endsAt?: string | null;
    eventTimezone?: string | null;
    organizerEmail?: string | null;
    selfResponse?: string | null;
    externalAttendeeCount?: number;
    externalAttendeesJson?: string | null;
    attendeesOmitted?: boolean;
    matchStatus?: MeetingMatchStatus;
    matchMethod?: MeetingMatchMethod;
    matchConfidence?: number | null;
    prospectId?: number | null;
    suggestedProspectId?: number | null;
    eventUpdatedAt?: string | null;
    attendeesFingerprint?: string | null;
  }): { isNew: boolean; fingerprintChanged: boolean } {
    return mtgUpsertMeeting(this.db, input);
  }

  getMeeting(calendarId: string, eventId: string): MeetingRecord | null {
    return mtgGetMeeting(this.db, calendarId, eventId);
  }

  /**
   * The fast path for an unchanged event (`event_updated_at` hasn't
   * advanced since last poll): touch `last_seen_at` only, skip re-deriving
   * anything else. Returns false (no-op) if the row doesn't exist.
   */
  touchMeetingLastSeen(calendarId: string, eventId: string): boolean {
    return mtgTouchMeetingLastSeen(this.db, calendarId, eventId);
  }

  /**
   * Every prospect's (id, name, email, company), for the calendar matcher's
   * fuzzy domain/name signals: there's no `company_domain` column, so the
   * matcher derives a domain from `email` and slug-compares `company`
   * against it in JS. A full scan is fine at founder scale (same precedent
   * `resolveProspectForLinkedInReply` already relies on).
   */
  listProspectsForFuzzyMatch(): Array<{
    id: number;
    name: string | null;
    email: string | null;
    company: string | null;
  }> {
    return this.prospects.listProspectsForFuzzyMatch();
  }

  /**
   * Whether `prospectId` has any outreach history (sequence_events). The
   * calendar matcher's tie-break when two prospects share an exact-match
   * email account: the one with outreach history wins; only when NEITHER
   * has history is the match `ambiguous`.
   */
  hasOutreachHistory(prospectId: number): boolean {
    return cadHasOutreachHistory(this.db, prospectId);
  }

  /** Most recent sequence_events timestamp for a prospect, or null with no history. Tie-break helper alongside `hasOutreachHistory`. */
  lastOutreachAt(prospectId: number): string | null {
    return cadLastOutreachAt(this.db, prospectId);
  }

  /**
   * Past meetings linked to a prospect with no recorded outcome yet. The
   * /inbox-style "awaiting" list. Grace period so a call that ran long
   * isn't nagged about the instant it crosses `ends_at`. Declined-by-founder
   * and all-day rows are excluded: a self-block or an all-day conference is
   * not a call, and COALESCE(self_response,'accepted') reads a NULL
   * response (never triaged, or an old row) as accepted rather than
   * silently dropping it from the nudge.
   */
  listPendingOutcomeMeetings(): MeetingRecord[] {
    return mtgListPendingOutcomeMeetings(this.db);
  }

  /** Founder-facing review queue: events with a fuzzy suggestion or an ambiguous multi-candidate match, unresolved. */
  listMeetingsForReview(): MeetingRecord[] {
    return mtgListMeetingsForReview(this.db);
  }

  /** Record a founder-set outcome. Clears outcome_prompted_at is NOT done here. The row is resolved, not withdrawn. */
  setMeetingOutcome(input: {
    calendarId: string;
    eventId: string;
    outcome: MeetingOutcome;
    note?: string | null;
  }): void {
    mtgSetMeetingOutcome(this.db, input);
  }

  /**
   * The most recent founder-recorded outcome for a prospect's calendar
   * meeting(s) (issue #578): modelled on `contactSuppressionFor`, a ledger
   * read returning a verdict for the reply drafter and cadence gate to act
   * on. This is the DIRECT path from an outcome into a draft: the existing
   * `tagOutcomeValue` → `triggerAngleRefresh` → `prospects.angle_json` path
   * never hands the outcome to the synthesizer as text, so this is a second
   * read, not a replacement. Newest by `outcome_recorded_at` wins when a
   * prospect has more than one resolved meeting.
   */
  latestMeetingOutcomeFor(
    prospectId: number,
  ): { outcome: MeetingOutcome; note: string | null; summary: string | null } | null {
    return mtgLatestMeetingOutcomeFor(this.db, prospectId);
  }

  /**
   * Stamp `outcome_prompted_at`: called when the founder is shown the
   * nudge for this meeting, so a UI that dedupes reminders doesn't have to
   * infer "already asked" from anything else. `upsertMeeting`'s reschedule
   * branch clears this back to NULL when `starts_at` genuinely changes, so
   * a stale nudge withdraws on its own.
   */
  markMeetingPrompted(calendarId: string, eventId: string): void {
    mtgMarkMeetingPrompted(this.db, calendarId, eventId);
  }

  /**
   * Founder confirms a suggested/ambiguous match: promotes it to prospect_id
   * and marks match_status 'exact' so it stops appearing in the review queue
   * (it's still surfaced via prospect_id everywhere else).
   */
  confirmMeetingMatch(calendarId: string, eventId: string, prospectId: number): void {
    mtgConfirmMeetingMatch(this.db, calendarId, eventId, prospectId);
  }

  /**
   * Founder dismisses a suggestion. Match_status flips to 'dismissed', which
   * the matcher (packages/plays' calendar poll) must treat as "do not
   * re-suggest" UNTIL `attendees_fingerprint` changes. That's the whole
   * point of storing the fingerprint.
   */
  dismissMeetingMatch(calendarId: string, eventId: string): void {
    mtgDismissMeetingMatch(this.db, calendarId, eventId);
  }

  /** Atomically consume a signed webhook replay key. */
  consumeWebhookReplay(replayKey: string, expiresAt: number, now: number): boolean {
    return sysConsumeWebhookReplay(this.db, replayKey, expiresAt, now);
  }

  /** Test helper for isolating webhook verification cases. */
  clearWebhookReplays(): void {
    sysClearWebhookReplays(this.db);
  }

  /**
   * Release a previously-consumed replay key. Used when a webhook was
   * verified but downstream processing (ICP filtering, enqueueing) failed
   * before a success response was sent, so the provider's retry of the same
   * signed payload isn't rejected as a replay.
   */
  releaseWebhookReplay(replayKey: string): void {
    sysReleaseWebhookReplay(this.db, replayKey);
  }
}

let singleton: Ledger | null = null;

export function getLedger(): Ledger {
  if (!singleton) {
    singleton = new Ledger();
    try {
      recoverLearningApplications(singleton);
    } catch (error) {
      singleton = null;
      throw error;
    }
  }
  singleton.refreshSharedPeople();
  return singleton;
}
