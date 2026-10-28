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
  cadencePlansFor as cadCadencePlansFor,
  cadenceQueueRow as cadCadenceQueueRow,
  cadencesForQueueRows as cadCadencesForQueueRows,
  type CadenceOfferJson,
  type CadenceWithProspect,
  type QueueRowCadence,
  clearCadenceDraft as cadClearCadenceDraft,
  countSends as cadCountSends,
  discardCadenceDraft as cadDiscardCadenceDraft,
  enrollCadence as cadEnrollCadence,
  eventsByPlay as cadEventsByPlay,
  hasOutreachHistory as cadHasOutreachHistory,
  lastOutreachAt as cadLastOutreachAt,
  listAllSequenceEventsForProspect as cadListAllSequenceEventsForProspect,
  listChannelEventsForProspect as cadListChannelEventsForProspect,
  listSequenceEventsForProspect as cadListSequenceEventsForProspect,
  postponeCadence as cadPostponeCadence,
  listLinkedInInviteEvents as cadListLinkedInInviteEvents,
  listLinkedInInviteCadences as cadListLinkedInInviteCadences,
  updateLinkedInInviteEvent as cadUpdateLinkedInInviteEvent,
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
  setCadenceOffer as cadSetCadenceOffer,
  setCadenceOfferSkip as cadSetCadenceOfferSkip,
  setCadenceStatus as cadSetCadenceStatus,
  stopCadence as cadStopCadence,
  sweepStaleCadenceSends as cadSweepStaleCadenceSends,
} from "./ledger-cadence.ts";
import { LedgerCache } from "./ledger-cache.ts";
import { readLinkedInFunnelSource, type LinkedInFunnelSource } from "./ledger-linkedin-funnel.ts";
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
import { CodeAnswerStore } from "./code-answers-store.ts";
import { SendDeliveryStore } from "./ledger-delivery.ts";
import { OutboundSendStore } from "./ledger-outbound.ts";
import { canonicalLinkedInProfileKey, ProspectStore } from "./ledger-prospects.ts";
import { prospectHasReplied as queueProspectHasReplied, QueueStore } from "./ledger-queue.ts";
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
import { currentWorkspaceName, sharedDbPath, type SharedDb } from "./shared-db.ts";
import { linkedInGuardFacts, linkedInInviteHistory } from "./ledger-linkedin-guard.ts";
import type { LinkedInGuardFacts } from "./linkedin-guard.ts";
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
  ENRICH_DEADLINE_MS,
  LINKEDIN_CACHE_TTL_MS,
  LINKEDIN_MISS_TTL_MS,
  RESEARCH_DEADLINE_MS,
} from "./ledger-cache.ts";

// Re-export the profile-key helper for the Ledger public API.
export { canonicalLinkedInProfileKey };

// Re-export cadence types for the Ledger public API.
export type { CadenceOfferJson, CadenceWithProspect, QueueRowCadence } from "./ledger-cadence.ts";

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
  /** How-it-works questions answered from the source repo (code-answers-store.ts). */
  readonly codeAnswers: CodeAnswerStore;
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
    this.codeAnswers = new CodeAnswerStore(this.db);
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

  /** @see ledger-markers.ts#clearMarker */
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
    /** The offer the sequence starts with; a re-enrolment keeps the one it has. */
    offer?: CadenceOfferJson | null;
    /** The queue row the sequence starts from; a re-enrolment keeps the one it has. */
    queueId?: number | null;
  }): void {
    cadEnrollCadence(this.db, input);
  }

  /** Change an active cadence's offer while no send holds it (ledger-cadence.ts). */
  setCadenceOffer(input: {
    prospectId: number;
    playName: string;
    offer: Record<string, unknown>;
    candidates?: unknown[];
    origin?: CadenceOfferJson["origin"];
    merge?: boolean;
    expect?: Record<string, string | null>;
  }): boolean {
    return cadSetCadenceOffer(this.db, input);
  }

  /** Keep the offer writer's refusal on an active cadence with no offer (ledger-cadence.ts). */
  setCadenceOfferSkip(input: {
    prospectId: number;
    playName: string;
    skip: Record<string, unknown>;
  }): boolean {
    return cadSetCadenceOfferSkip(this.db, input);
  }

  /** The queue row a cadence started from, else its address's newest sent row (ledger-cadence.ts). */
  cadenceQueueRow(
    prospectId: number,
    playName: string,
  ): { id: number; payload: Record<string, unknown>; source: string } | null {
    return cadCadenceQueueRow(this.db, prospectId, playName);
  }

  /** The cadence each queue row started, for a page of rows (ledger-cadence.ts). */
  cadencesForQueueRows(
    rows: ReadonlyArray<{ id: number; prospect_id: number | null; play_name: string }>,
  ): Map<number, QueueRowCadence> {
    return cadCadencesForQueueRows(this.db, rows);
  }

  /** Each cadence's saved plan for its current enrolment, keyed `prospect_id|play_name` (ledger-cadence.ts). */
  cadencePlansFor(
    cadences: ReadonlyArray<Pick<CadenceWithProspect, "prospect_id" | "play_name" | "enrolled_at">>,
  ): Map<string, import("./types.ts").CadencePlanStep[]> {
    return cadCadencePlansFor(this.db, cadences);
  }

  /**
   * LinkedIn invite events (send, withdrawal) for a prospect and play, any
   * status: marked `kind: "linkedin_invite"` at any step, or legacy step-0 rows.
   */
  listLinkedInInviteEvents(prospectId: number, playName: string): SequenceEventRecord[] {
    return cadListLinkedInInviteEvents(this.db, prospectId, playName);
  }

  /** Active cadences with a sent LinkedIn invite: see listLinkedInInviteCadences. */
  listLinkedInInviteCadences(): Array<{ prospect_id: number; play_name: string }> {
    return cadListLinkedInInviteCadences(this.db);
  }

  /** Merge fields into one sequence event's metadata (status unchanged). False when the row is gone. */
  mergeSequenceEventMetadata(id: number, metadata: Record<string, unknown>): boolean {
    return cadUpdateLinkedInInviteEvent(this.db, { id, metadata });
  }

  /** Merge into an invite event's metadata, optionally marking it failed: see updateLinkedInInviteEvent. */
  updateLinkedInInviteEvent(input: {
    id: number;
    status?: "failed";
    metadata: Record<string, unknown>;
  }): boolean {
    return cadUpdateLinkedInInviteEvent(this.db, input);
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

  /** @see ledger-cadence.ts#getCadence */
  getCadence(prospectId: number, playName: string): CadenceWithProspect | null {
    return cadGetCadence(this.db, prospectId, playName);
  }

  /** @see ledger-cadence.ts#listCadencesForProspect */
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

  /** @see ledger-cadence.ts#recordCadenceSendError */
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
    /** The caller is the send worker holding this cadence's sending marker; see ledger-cadence.ts. */
    holdingSendingMarker?: boolean;
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

  /** Drop the stored next-step preview, unless a send holds the row (ledger-cadence.ts). */
  discardCadenceDraft(input: {
    prospectId: number;
    playName: string;
    reason: DraftDiscardReason;
  }): boolean {
    return cadDiscardCadenceDraft(this.db, this.drafts, input);
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

  /** @see ledger-inbox.ts#InboxStore.upsertInboxDraft */
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

  /** @see ledger-inbox.ts#InboxStore.setInboxDraftSteer */
  setInboxDraftSteer(threadKey: string, steer: string | null): void {
    this.inbox.setInboxDraftSteer(threadKey, steer);
  }

  /** @see ledger-inbox.ts#InboxStore.setInboxDraftBody */
  setInboxDraftBody(threadKey: string, body: string, status: "needs_decision" | null): void {
    this.inbox.setInboxDraftBody(threadKey, body, status);
  }

  clearInboxDraft(threadKey: string): void {
    this.inbox.clearInboxDraft(threadKey);
  }

  /** @see ledger-inbox.ts#InboxStore.recordInboxSent */
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

  /** @see ledger-inbox.ts#InboxStore.getInboxThreads */
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

  /** @see ledger-cadence.ts#sweepStaleCadenceSends */
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

  /** Ledger facts the LinkedIn invite guard reads (linkedin-guard.ts). */
  linkedInGuardFacts(prospectId: number): LinkedInGuardFacts | null {
    return linkedInGuardFacts(this.db, prospectId);
  }

  /**
   * Copy the invites this ledger already recorded into the shared
   * `linkedin_touched` table, once per ledger file, so profiles invited before
   * the guard existed still exclude other plays and workspaces. It reads only
   * the connection this ledger holds: another workspace's history is loaded by
   * the explicit import, never from a guard call.
   */
  backfillLinkedInTouched(shared: SharedDb): void {
    const workspace = currentWorkspaceName();
    shared.importLinkedInInvites(`linkedin-invites:${this.path}`, () =>
      linkedInInviteHistory(this.db).map((h) => ({
        slug: h.slug,
        source: `invite:${workspace}`,
        touchedAt: h.touchedAt,
      })),
    );
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

  /** @see ledger-inbox.ts#InboxStore.listRepliedProspectEmails */
  listRepliedProspectEmails(): string[] {
    return this.inbox.listRepliedProspectEmails();
  }

  listInboxArchives(): Map<number, string> {
    return this.inbox.listInboxArchives();
  }

  /** @see ledger-inbox.ts#InboxStore.archiveInboxConversation */
  archiveInboxConversation(
    prospectId: number,
    observedReplyIds: string[],
  ): "archived" | "stale" | "missing" {
    return this.inbox.archiveInboxConversation(prospectId, observedReplyIds);
  }

  restoreInboxConversation(prospectId: number): void {
    this.inbox.restoreInboxConversation(prospectId);
  }

  /** @see ledger-inbox.ts#InboxStore.recordInboxReply */
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

  /** @see ledger-inbox.ts#InboxStore.setInboxReplyIntent */
  setInboxReplyIntent(
    id: string,
    intent: string | null,
    intentReason: string | null,
    details?: InboxReplyIntentDetails,
  ): void {
    this.inbox.setInboxReplyIntent(id, intent, intentReason, details);
  }

  /** @see ledger-inbox.ts#InboxStore.claimInboxReplyForTriage */
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

  /** @see ledger-inbox.ts#InboxStore.listInboxReplyIntents */
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

  /** @see ledger-inbox.ts#InboxStore.listInboxReplyIds */
  listInboxReplyIds(): Set<string> {
    return this.inbox.listInboxReplyIds();
  }

  /** @see ledger-inbox.ts#InboxStore.listUntriagedHumanReplies */
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

  /** @see ledger-inbox.ts#InboxStore.listProspectIdsWithReplies */
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

  /** Run `fn`'s ledger writes as one transaction: all of them land, or none. */
  inTransaction<T>(fn: () => T): T {
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

  /** @see ledger-sending.ts#assignSender */
  assignSender(email: string, identityId: string): string {
    return sendAssignSender(this.db, email, identityId);
  }

  /** @see ledger-sending.ts#countEmailSendsSince */
  countEmailSendsSince(identityId: string, sinceUtcSqlite: string): number {
    return sendCountEmailSendsSince(this.db, identityId, sinceUtcSqlite);
  }

  /** @see ledger-sending.ts#hasPriorEmailSend */
  hasPriorEmailSend(email: string): boolean {
    return sendHasPriorEmailSend(this.db, email);
  }

  /** @see ledger-sending.ts#firstEmailSendAt */
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

  /** @see ledger-cadence.ts#recentSentEmailBodies */
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

  /** @see ledger-prospects.ts#ProspectStore.setProspectDossier */
  setProspectDossier(id: number, dossier: string | null): void {
    this.prospects.setProspectDossier(id, dossier);
  }

  /** @see ledger-prospects.ts#ProspectStore.setProspectAngle */
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

  /** @see ledger-prospects.ts#ProspectStore.listProspectsMissingLinkedIn */
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

  /** @see ledger-prospects.ts#ProspectStore.listProspectsForResearch */
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

  /** @see ledger-prospects.ts#ProspectStore.listProspectsForAngle */
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

  /** @see ledger-outcomes.ts#listLatestOutcomeRecordedAtByProspect */
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

  /** @see ledger-receipts.ts#ReceiptStore.setReceiptValueTag */
  setReceiptValueTag(receiptId: number, valueTagJson: string): void {
    this.receipts.setReceiptValueTag(receiptId, valueTagJson);
  }

  /** @see ledger-receipts.ts#ReceiptStore.setReceiptValueTagByGoal */
  setReceiptValueTagByGoal(goalId: string, valueTagJson: string): number {
    return this.receipts.setReceiptValueTagByGoal(goalId, valueTagJson);
  }

  /** @see ledger-receipts.ts#ReceiptStore.currentGoalValueTag */
  currentGoalValueTag(goalId: string): string | null {
    return this.receipts.currentGoalValueTag(goalId);
  }

  /** @see ledger-receipts.ts#ReceiptStore.goalLabels */
  goalLabels(goalIds: string[]): Map<string, { playName: string | null; prospect: string | null }> {
    return this.receipts.goalLabels(goalIds);
  }

  /** @see ledger-cadence.ts#hasSentSequenceEvent */
  hasSentSequenceEvent(prospectId: number, playName: string, stepIndex: number): boolean {
    return cadHasSentSequenceEvent(this.db, prospectId, playName, stepIndex);
  }

  /** @see ledger-cadence.ts#markLatestStepReplied */
  markLatestStepReplied(input: {
    prospectId: number;
    playName: string;
    repliedAt?: string | null;
  }): boolean {
    return cadMarkLatestStepReplied(this.db, input);
  }

  /** @see ledger-cadence.ts#recordCadenceReply */
  recordCadenceReply(input: { prospectId: number; playName: string; repliedAt?: string | null }): {
    newlyReplied: boolean;
    eventRecorded: boolean;
  } {
    return cadRecordCadenceReply(this.db, this.drafts, input);
  }

  /** @see ledger-cadence.ts#recordProspectReply */
  recordProspectReply(
    prospectId: number,
    opts?: { subject?: string | null; repliedAt?: string | null },
  ): Array<{ playName: string; newlyReplied: boolean; eventRecorded: boolean }> {
    return cadRecordProspectReply(this.db, this.drafts, prospectId, opts);
  }

  /** @see ledger-cadence.ts#latestSentPlayForProspect */
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

  /** @see ledger-cadence.ts#listSequenceEventsForProspect */
  listSequenceEventsForProspect(prospectId: number): SequenceEventRecord[] {
    return cadListSequenceEventsForProspect(this.db, prospectId);
  }

  /** @see ledger-cadence.ts#listSequenceEventsForCadences */
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

  /** @see ledger-receipts.ts#ReceiptStore.countReceipts */
  countReceipts(opts: { sinceIso?: string; playName?: string } = {}): number {
    return this.receipts.countReceipts(opts);
  }

  /** @see ledger-receipts.ts#ReceiptStore.spendSeriesByPlay */
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

  /** @see ledger-spend.ts#reserveSpend */
  reserveSpend(amountUsd: number): number {
    return spendReserveSpend(this.db, amountUsd);
  }

  /** @see ledger-spend.ts#releaseSpendReservation */
  releaseSpendReservation(id: number): void {
    spendReleaseSpendReservation(this.db, id);
  }

  /** @see ledger-spend.ts#reservedSpendUsd */
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

  /** @see ledger-spend.ts#sweepStaleSpendReservations */
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

  /** @see ledger-queue.ts#QueueStore.enqueueTarget */
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

  /** @see ledger-system.ts#upsertPendingResolution */
  upsertPendingResolution(input: {
    playName: string;
    dedupeKey: string;
    source: string;
    raw: unknown;
  }): void {
    sysUpsertPendingResolution(this.db, input);
  }

  /** @see ledger-system.ts#isPendingResolution */
  isPendingResolution(playName: string, dedupeKey: string): boolean {
    return sysIsPendingResolution(this.db, playName, dedupeKey);
  }

  /** @see ledger-system.ts#listPendingResolution */
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

  /** @see ledger-system.ts#markPendingResolutionAttempted */
  markPendingResolutionAttempted(playName: string, dedupeKey: string): void {
    sysMarkPendingResolutionAttempted(this.db, playName, dedupeKey);
  }

  deletePendingResolution(playName: string, dedupeKey: string): void {
    sysDeletePendingResolution(this.db, playName, dedupeKey);
  }

  /** @see ledger-system.ts#sweepStalePendingResolution */
  sweepStalePendingResolution(maxAgeMs: number): number {
    return sysSweepStalePendingResolution(this.db, maxAgeMs);
  }

  /** @see ledger-system.ts#recentXHarvestedTweetIds */
  recentXHarvestedTweetIds(cutoffIso: string): Set<string> {
    return sysRecentXHarvestedTweetIds(this.db, cutoffIso);
  }

  /** @see ledger-system.ts#recordXHarvestedTweets */
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

  /** @see ledger-cadence.ts#prospectHasFirstTouch */
  prospectHasFirstTouch(prospectId: number): boolean {
    return cadProspectHasFirstTouch(this.db, prospectId);
  }

  /** @see ledger-queue.ts#QueueStore.getQueueRowByDedupe */
  getQueueRowByDedupe(playName: string, dedupeKey: string): QueueRow | null {
    return this.queue.getQueueRowByDedupe(playName, dedupeKey);
  }

  /** @see ledger-queue.ts#QueueStore.listQueue (`columns` projects the read, issue #929) */
  listQueue(
    opts: {
      playName?: string;
      status?: QueueStatus;
      limit?: number;
      ids?: number[];
      columns?: readonly string[];
    } = {},
  ): QueueRow[] {
    return this.queue.listQueue(opts);
  }

  getQueueRow(id: number): QueueRow | null {
    return this.queue.getQueueRow(id);
  }

  /** Queue rows by id, for a page at once: keyed by id; a missing id is absent. */
  getQueueRowsByIds(ids: readonly number[]): Map<number, QueueRow> {
    return this.queue.getQueueRowsByIds(ids);
  }

  /** @see ledger-queue.ts#prospectHasReplied */
  prospectHasReplied(prospectId: number): boolean {
    return queueProspectHasReplied(this.db, prospectId);
  }

  /** @see ledger-queue.ts#QueueStore.getQueueRowForProspect */
  getQueueRowForProspect(prospectId: number): QueueRow | null {
    return this.queue.getQueueRowForProspect(prospectId);
  }

  /** @see ledger-queue.ts#QueueStore.searchQueue */
  searchQueue(opts: QueueSearchOpts): { rows: QueueSearchRow[]; total: number | null } {
    return this.queue.searchQueue(opts);
  }

  /** @see ledger-queue.ts#QueueStore.searchQueueStatusCounts */
  searchQueueStatusCounts(
    opts: Pick<QueueSearchOpts, "q" | "playName" | "decidedBy">,
  ): Record<QueueStatus, number> {
    return this.queue.searchQueueStatusCounts(opts);
  }

  /** @see ledger-queue.ts#QueueStore.listQueuePlayNames */
  listQueuePlayNames(): string[] {
    return this.queue.listQueuePlayNames();
  }

  /** @see ledger-cadence.ts#listAllSequenceEventsForProspect */
  listAllSequenceEventsForProspect(prospectId: number): SequenceEventRecord[] {
    return cadListAllSequenceEventsForProspect(this.db, prospectId);
  }

  /** @see ledger-cadence.ts#listChannelEventsForProspect */
  listChannelEventsForProspect(prospectId: number): ChannelEventRecord[] {
    return cadListChannelEventsForProspect(this.db, prospectId);
  }

  /** Read-only snapshot for the LinkedIn funnel and invite listing (#792). */
  readLinkedInFunnelSource(): LinkedInFunnelSource {
    return readLinkedInFunnelSource(this.db);
  }

  /** @see ledger-outcomes.ts#listDealOutcomesForProspect */
  listDealOutcomesForProspect(prospectId: number): DealOutcomeRecord[] {
    return outListDealOutcomesForProspect(this.db, prospectId);
  }

  /** @see ledger-queue.ts#QueueStore.removePendingQueueTarget */
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

  /** @see ledger-queue.ts#QueueStore.claimQueueSendingMarker */
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

  /** @see ledger-queue.ts#QueueStore.sweepStaleQueueSends */
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

  /** @see ledger-queue.ts#QueueStore.dequeueApproved */
  dequeueApproved(opts: { playName: string; limit?: number; leaseSeconds?: number }): QueueRow[] {
    return this.queue.dequeueApproved(opts);
  }

  expirePendingOlderThan(days: number): number {
    return this.queue.expirePendingOlderThan(days);
  }

  queueCounts(): Record<QueueStatus, number> {
    return this.queue.queueCounts();
  }

  /** @see ledger-queue.ts#QueueStore.approvedCountsByPlay */
  approvedCountsByPlay(): Record<string, number> {
    return this.queue.approvedCountsByPlay();
  }

  /** @see ledger-queue.ts#QueueStore.finderApprovalStats */
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

  /** @see ledger-runs.ts#appendRunEvent */
  appendRunEvent(input: { runId: number; event: unknown }): void {
    runAppendRunEvent(this.db, input);
  }

  /** @see ledger-runs.ts#markRunComplete */
  markRunComplete(input: {
    runId: number;
    status: "done" | "interrupted";
    sentEmails?: string[];
  }): void {
    runMarkRunComplete(this.db, input);
  }

  /** @see ledger-runs.ts#setRunSentEmails */
  setRunSentEmails(input: { runId: number; sentEmails: string[] }): void {
    runSetRunSentEmails(this.db, input);
  }

  /** @see ledger-runs.ts#cancelRun */
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

  /** @see ledger-runs.ts#listRuns */
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

  /** @see ledger-runs.ts#sweepStaleRuns */
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

  /** @see ledger-triggers.ts#updateTriggerLastPoll */
  updateTriggerLastPoll(input: { name: string; summary: unknown }): void {
    trgUpdateTriggerLastPoll(this.db, input);
  }

  /** @see ledger-triggers.ts#clearTriggerClaim */
  clearTriggerClaim(input: { name: string; summary: unknown }): void {
    trgClearTriggerClaim(this.db, input);
  }

  /** @see ledger-triggers.ts#markTriggerRunning */
  markTriggerRunning(name: string, startedAtIso: string, staleCutoffIso?: string): boolean {
    return trgMarkTriggerRunning(this.db, name, startedAtIso, staleCutoffIso);
  }

  /** @see ledger-triggers.ts#sweepStaleRunningTriggers */
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

  /** @see ledger-triggers.ts#applyTriggerConfigs */
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

  /** @see ledger-queue.ts#QueueStore.setQueueDraftIfCurrent */
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
      evidenceClause?: boolean;
      /** LinkedIn only: the row is a known connection, so no note was drafted. */
      knownConnection?: { readAt: string };
    };
    discardReason?: DraftDiscardReason;
    sentBy?: "human" | "machine";
  }): void {
    this.queue.setQueueDraft(input);
  }

  /** @see ledger-queue.ts#QueueStore.updateQueuePayload */
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

  /** `source` of the newest queue row for this play and address, whatever its status. */
  latestQueueSource(playName: string, email: string): string | null {
    return this.queue.latestQueueSource(playName, email);
  }

  /** `latestSentQueuePayload` plus the row's `source` and `id`. */
  latestSentQueueRow(
    playName: string,
    email: string,
  ): { id: number; payload: Record<string, unknown>; source: string } | null {
    return this.queue.latestSentQueueRow(playName, email);
  }

  /** @see ledger-queue.ts#QueueStore.latestSentQueuePayloads */
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
  patchLiveQueuePayload(input: {
    id: number;
    patch: Record<string, unknown>;
    /** Compare-and-set: JSON paths that must still hold these scalar values (null: absent). */
    expect?: Array<{ path: string; value: string | null }>;
    /** Compare-and-set on the whole stored payload: any concurrent change skips the write. */
    expectPayloadJson?: string;
    /** Drop the stored draft in the same write (its open version closes as a redraft). */
    discardDraft?: boolean;
  }): boolean {
    return this.queue.patchLiveQueuePayload(input);
  }

  latestQueueId(): number {
    return this.queue.latestQueueId();
  }

  /** @see ledger-queue.ts#QueueStore.listPendingQueueAfterId */
  listPendingQueueAfterId(id: number): QueueRow[] {
    return this.queue.listPendingQueueAfterId(id);
  }

  getProductResearchCache(cacheKey: string, maxAgeMs: number): string | null {
    return this.cache.getProductResearchCache(cacheKey, maxAgeMs);
  }

  setProductResearchCache(cacheKey: string, dossierJson: string): void {
    this.cache.setProductResearchCache(cacheKey, dossierJson);
  }

  /** @see ledger-queue.ts#QueueStore.setQueueNotes */
  setQueueNotes(input: { id: number; notes: string }): void {
    this.queue.setQueueNotes(input);
  }

  /** @see ledger-queue.ts#QueueStore.setQueuePriority */
  setQueuePriority(id: number, priority: ProspectPriority | null): void {
    this.queue.setQueuePriority(id, priority);
  }

  /** @see ledger-queue.ts#QueueStore.listQueueRowsForScoring */
  listQueueRowsForScoring(
    opts: { playName?: string; limit?: number; allStatuses?: boolean } = {},
  ): QueueRow[] {
    return this.queue.listQueueRowsForScoring(opts);
  }

  /** @see ledger-queue.ts#QueueStore.listSentOutcomeRows */
  listSentOutcomeRows(opts: { playName?: string } = {}): SentOutcomeRawRow[] {
    return this.queue.listSentOutcomeRows(opts);
  }

  /** @see ledger-receipts.ts#ReceiptStore.listValueTaggedReceipts */
  listValueTaggedReceipts(): Array<{ goal_id: string; value_tag: string }> {
    return this.receipts.listValueTaggedReceipts();
  }

  /** @see ledger-admin.ts#vacuum */
  vacuum(): void {
    adminVacuum(this.db);
  }

  /** @see ledger-admin.ts#freePages */
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

  /** @see ledger-meetings.ts#upsertMeeting */
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

  /** @see ledger-meetings.ts#touchMeetingLastSeen */
  touchMeetingLastSeen(calendarId: string, eventId: string): boolean {
    return mtgTouchMeetingLastSeen(this.db, calendarId, eventId);
  }

  /** @see ledger-prospects.ts#ProspectStore.listProspectsForFuzzyMatch */
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

  /** @see ledger-cadence.ts#lastOutreachAt */
  lastOutreachAt(prospectId: number): string | null {
    return cadLastOutreachAt(this.db, prospectId);
  }

  /** @see ledger-meetings.ts#listPendingOutcomeMeetings */
  listPendingOutcomeMeetings(): MeetingRecord[] {
    return mtgListPendingOutcomeMeetings(this.db);
  }

  /** @see ledger-meetings.ts#listMeetingsForReview */
  listMeetingsForReview(): MeetingRecord[] {
    return mtgListMeetingsForReview(this.db);
  }

  /** @see ledger-meetings.ts#setMeetingOutcome */
  setMeetingOutcome(input: {
    calendarId: string;
    eventId: string;
    outcome: MeetingOutcome;
    note?: string | null;
  }): void {
    mtgSetMeetingOutcome(this.db, input);
  }

  /** @see ledger-meetings.ts#latestMeetingOutcomeFor */
  latestMeetingOutcomeFor(
    prospectId: number,
  ): { outcome: MeetingOutcome; note: string | null; summary: string | null } | null {
    return mtgLatestMeetingOutcomeFor(this.db, prospectId);
  }

  /** @see ledger-meetings.ts#markMeetingPrompted */
  markMeetingPrompted(calendarId: string, eventId: string): void {
    mtgMarkMeetingPrompted(this.db, calendarId, eventId);
  }

  /** @see ledger-meetings.ts#confirmMeetingMatch */
  confirmMeetingMatch(calendarId: string, eventId: string, prospectId: number): void {
    mtgConfirmMeetingMatch(this.db, calendarId, eventId, prospectId);
  }

  /** @see ledger-meetings.ts#dismissMeetingMatch */
  dismissMeetingMatch(calendarId: string, eventId: string): void {
    mtgDismissMeetingMatch(this.db, calendarId, eventId);
  }

  /** @see ledger-system.ts#consumeWebhookReplay */
  consumeWebhookReplay(replayKey: string, expiresAt: number, now: number): boolean {
    return sysConsumeWebhookReplay(this.db, replayKey, expiresAt, now);
  }

  /** @see ledger-system.ts#clearWebhookReplays */
  clearWebhookReplays(): void {
    sysClearWebhookReplays(this.db);
  }

  /** @see ledger-system.ts#releaseWebhookReplay */
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
