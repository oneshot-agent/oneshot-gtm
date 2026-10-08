import type { DecisionReason } from "./learning.ts";
export * from "./reply-email-view.ts";
/**
 * Wire types shared between apps/cli, apps/server, and apps/web.
 * These are the API contracts for /api/* endpoints. Keep stable.
 */

export type CadenceStatus =
  | "active"
  | "replied"
  | "breakup"
  | "completed"
  | "paused"
  /** Explicitly stopped by the founder before the cadence naturally finished. */
  | "stopped"
  /** Stopped by a hard bounce. The address is dead and is suppressed from further sends. */
  | "bounced"
  /** Stopped by an explicit do-not-contact reply. The prospect is suppressed from further sends. */
  | "unsubscribed";

export type CadenceStopReason = "bad_timing" | "other" | "not_a_fit" | "do_not_contact";

export interface CadenceNextStepDraft {
  subject: string;
  body: string;
  flags: string[];
  draftedAt: string;
  /** Which edge angle the follow-up was built on, when the play's edge has several. */
  angle?: DraftAngleChoice;
}

export interface CadenceSentStep {
  /** 0 = initial send; 1..N = registered cadence follow-ups in order. */
  stepIndex: number;
  /** Step label from the play registry ("initial send", "value follow-up", "breakup", …). */
  label: string;
  subject: string;
  /** Null when this row was written before subject/body persistence landed (pre-v8). */
  body: string | null;
  /** ISO timestamp of when the email actually sent: for a skipped letter, when it was skipped. */
  sentAt: string;
  /** Absent on older servers; `skipped` is a direct-mail step the founder skipped (#610). */
  status?: "sent" | "delivered" | "replied" | "skipped";
  /** Sent-folder delivery check of this step's email, when one ran. */
  delivery?: SendDeliveryView | null;
}
export type StepChannel =
  | "email"
  | "sms"
  | "voice"
  | "linkedin"
  | "x"
  | "direct_mail"
  | "reddit"
  | "hacker-news";

export interface BusinessMailAddress {
  name: string;
  address_line1: string;
  address_line2?: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  address_country?: "US";
}

/** The other workspace's touch that holds a cadence's next send. */
export interface CadenceHeldElsewhere {
  workspace: string;
  playName: string;
  /** When the other workspace emailed this person. */
  sentAt: string;
  /** When the 7-day window ends and this cadence can send. */
  until: string;
}

export interface CadenceView {
  nextStepChannel?: StepChannel | null;
  businessAddress?: BusinessMailAddress | null;
  mailDraftId?: string | null;
  prospectId: number;
  prospectEmail: string | null;
  prospectName: string | null;
  prospectCompany: string | null;
  prospectTitle: string | null;
  /** Present only when the stored polymorphic profile field is a valid LinkedIn member URL. */
  prospectLinkedinUrl: string | null;
  playName: string;
  status: CadenceStatus;
  currentStep: number;
  enrolledAt: string;
  nextDueAt: string | null;
  lastPolledAt: string | null;
  stopReason: CadenceStopReason | null;
  stopNote: string | null;
  stoppedAt: string | null;
  /** Most recent persisted human reply channel; null for legacy reply rows without an inbound event. */
  replyChannel: "email" | "linkedin" | null;
  replyAt: string | null;
  /** Persisted next-step preview (set by Preview, cleared on advance). */
  nextStepDraft: CadenceNextStepDraft | null;
  /** Label of the next step ("value follow-up", "breakup", …). Null when
   *  no next step exists (cadence is at or past the last step). */
  nextStepLabel: string | null;
  /** Whether the next step is the final breakup. Derived from the cadence
   *  engine's registered sequence: single source of truth. */
  nextStepIsBreakup: boolean;
  /** Total registered follow-up steps for this play (excludes day-0).
   *  The UI uses `followupCount + 1` for the step-progress dot count. */
  followupCount: number;
  /** Touches already sent for this cadence (step 0 + cadence follow-ups), oldest first.
   *  Empty array when the cadence has just been enrolled and nothing has fired yet. */
  priorSteps: CadenceSentStep[];
  /** True while /send-next or /send-batch is sending this step. Cleared when
   *  its SDK call resolves; prevents further Send actions while in flight. */
  isSending: boolean;
  /** Last failed send's message, including platform `ref:`, until a send succeeds;
   *  null otherwise. Used for the "send failed · retrying" indicator. */
  lastSendError: string | null;
  /** ISO timestamp of `lastSendError`. */
  lastSendErrorAt: string | null;
  /**
   * Another workspace emailed this person inside the shared 7-day contact
   * window, so a send from here is held until `until`. Null when nothing
   * holds it (or the cadence is not active). Advisory: the send-time claim
   * is still the gate.
   */
  heldElsewhere: CadenceHeldElsewhere | null;
  /**
   * The payload of the latest SENT queue row for this play + email. The
   * signal the finder matched on and the `fitReason` the intro was drawn from
   * (issue #599). The /cadences sheet shows both as the reminder of why this
   * person is being followed up. Null when no sent row exists (a cadence
   * enrolled by hand, an older ledger). The UI simply omits the reminder.
   */
  queuePayload: unknown | null;
}

/**
 * Cadence summary counts, scoped only by sinceRun and independent of the table's
 * active/all filter. `overdue` counts active cadences past due.
 */
export interface CadenceCounts {
  active: number;
  replied: number;
  breakup: number;
  completed: number;
  paused: number;
  stopped: number;
  bounced: number;
  overdue: number;
}

export interface CadencesResult {
  cadences: CadenceView[];
  counts: CadenceCounts;
  /** Absent when the capacity computation failed: pages skip the figure. */
  sendsToday?: SendsToday;
}

export interface LinkedInReplyResult {
  accepted: true;
  duplicate: boolean;
  prospectId: number;
  cadencesStopped: number;
  inFlightSends: number;
}

/** RoCS value tag attached to a receipt once its outcome is known. */
export interface ReceiptValueTag {
  type: string;
  amount?: number;
  label?: string;
}

export interface ReceiptView {
  id: number;
  playName: string;
  callType: string;
  costUsd: number | null;
  oneshotRequestId: string | null;
  createdAt: string;
  /** Call-time reason ("why did I make this call?"). */
  memo: string | null;
  /** Outcome value ("did this call generate value?"), null until tagged. */
  valueTag: ReceiptValueTag | null;
}

export interface ReceiptDetail extends ReceiptView {
  signedReceipt: unknown | null;
  /** Structured call-time reasoning ("what was the structured reasoning?"). */
  decisionContext: unknown | null;
}

export interface SpendByPlay {
  playName: string;
  calls: number;
  totalUsd: number;
}

export interface EventsByPlay {
  playName: string;
  sent: number;
  delivered: number;
  replied: number;
  bounced: number;
}

export interface OutcomeByPlay {
  playName: string | null;
  meetings: number;
  sqls: number;
  won: number;
  lost: number;
  ghosted: number;
  /** Closed-won dollars for this play in the window. Pipeline is never valued. */
  wonValueUsd: number;
}

/**
 * Per-cadence RoCS rollup (OneShot `rocsByGoal`) with local labels. `value` is
 * confirmed outcome value, `pendingValue` self-reported but unconfirmed; `rocs`
 * is value ÷ spend.
 */
/** Daily signed spend for one play, oldest bucket first. See `SpendSeries`. */
export interface SpendSeriesPlay {
  playName: string;
  /** One entry per day in the window, oldest first. Days with no spend are 0. */
  spend: number[];
}

export interface SpendSeries {
  /** How many daily buckets each `spend` array carries. */
  days: number;
  series: SpendSeriesPlay[];
}

export interface RocsGoalView {
  goalId: string;
  playName: string | null;
  prospect: string | null;
  spend: number;
  value: number;
  pendingValue: number;
  rocs: number;
  receiptCount: number;
}

/**
 * Run summary for the home dashboard. Targets and events are available on
 * GET /api/runs/:id, keeping event arrays out of the 30-second home poll.
 */
export interface RunSummary {
  id: number;
  playName: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  targetCount: number;
  draftedCount: number;
  sentCount: number;
  errorCount: number;
}

/**
 * Whole-pool daily send usage, aggregated per cap-group (a shared OneShot
 * domain counts once). A null cap means at least one identity is uncapped;
 * render as "X/∞".
 */
export interface SendsToday {
  sent: number;
  cap: number | null;
}

export interface HomeMetrics {
  spendUsd7d: number;
  spendUsd30d: number;
  callsLast7d: number;
  sentLast7d: number;
  repliedLast7d: number;
  activeCadences: number;
  /** Durable, all-time first-send milestone derived from sent sequence events. */
  hasFirstSend: boolean;
  /** Absent when the capacity computation failed: pages skip the figure. */
  sendsToday?: SendsToday;
  /**
   * Runs currently `running` (in-flight). Capped at 5 for the home widget.
   * The `CurrentRunsStrip` on /home hides itself when this is empty.
   */
  currentRuns: RunSummary[];
}

export interface PlayDescription {
  whenToUse: string;
  actions: string;
  requires: string;
  produces: string;
}

export interface PlayDescriptor {
  /** Optional for older dashboard fixtures and servers. Current API includes every play. */
  description?: PlayDescription;
  directMail?: { position: number; delayDays: number; mode?: "automatic" | "always" } | null;
  mailRecommendation?: string;
  mailAutomaticSupported?: boolean;
  mailEligible?: boolean;
  baseSteps?: { day: number; label: string; channel: StepChannel; isBreakup: boolean }[];
  name: string;
  channels: StepChannel[];
  followupCount: number;
  hasBreakup: boolean;
  cliInvocation: string;
  /**
   * Follow-up steps with effective (override-applied) CUMULATIVE day from the
   * day-0 initial send. The initial send itself isn't listed (always day 0,
   * not editable). Empty for one-touch plays.
   */
  steps: { day: number; label: string; channel: StepChannel; isBreakup: boolean }[];
  /** Code-default cumulative days for the same steps: lets the UI offer "reset". */
  defaultDays: number[];
}

export type LlmProvider = "openrouter" | "openai" | "anthropic";
export type WalletMode = "cdp" | "private-key";
export type KeySource = "env" | "file" | null;

/** Section a doctor check renders under in the dashboard's grouped panel. */
export type DoctorGroup = "install" | "senders" | "deliverability" | "finders" | "spend";

export interface DoctorCheck {
  name: string;
  /** Optional so stale clients tolerate its absence; the engine always sets it. */
  group?: DoctorGroup;
  severity: "ok" | "warn" | "fail";
  message: string;
  hint?: string;
  /** `wallet balance` only: USDC amount and when it was last read (cached a day; `?refresh=1` re-reads). */
  balanceUsd?: number;
  balanceCheckedAt?: string;
  approvalRate?: number | null;
  approved?: number;
  reviewed?: number;
  threshold?: number;
  windowDays?: number;
  minSamples?: number;
  deprioritized?: boolean;
}

export interface SetupRequest {
  /** Validate a complete minimum-onboarding step without changing CLI settings semantics. */
  onboardingStep?: 1 | 2 | 3;
  founderName?: string;
  founderEmail?: string;
  productOneLiner?: string;
  productDomain?: string;
  sendingDomain?: string;
  /** Email transport: OneShot SDK (wallet-owned domain) or the founder's own Gmail/Workspace account. Legacy: ignored once the identities pool exists. */
  emailProvider?: "oneshot" | "gmail";
  /**
   * Per-identity edits. `maxPerDay`: daily cap, null = uncapped, absent = unchanged.
   * `sendVia` (Smartlead mailboxes): "smtp" sends straight through the
   * mailbox's own SMTP under one fixed Message-ID per email; refused unless its
   * SMTP + IMAP credentials resolve. "provider" (the default) uses Smartlead.
   */
  identityUpdates?: Array<{
    id: string;
    maxPerDay?: number | null;
    sendVia?: "provider" | "smtp";
  }>;
  /**
   * New sending identities to add to the pool. OneShot: a wallet-owned domain
   * (must be one returned by the provisioned-domain pool) + a mailbox
   * local-part. Smartlead: a connected account's address (from the accounts
   * listing), with `providerMessagePerDay` carrying Smartlead's own cap so the
   * default ceiling clamps to it. Omit `maxPerDay` to take the cold-start
   * warm-up ramp; pass `null` to add uncapped. Smartlead `sendVia`: omit to
   * get direct SMTP when the mailbox's SMTP + IMAP credentials resolve (else
   * the Smartlead API, reported in the response's `sendViaNotices`); "smtp"
   * is refused (400) without credentials; "provider" forces the Smartlead API.
   */
  addIdentities?: Array<
    | {
        provider: "oneshot";
        sendingDomain: string;
        mailbox?: string;
        label?: string;
        maxPerDay?: number | null;
      }
    | {
        provider: "smartlead";
        address: string;
        label?: string;
        maxPerDay?: number | null;
        providerMessagePerDay?: number | null;
        sendVia?: "provider" | "smtp";
      }
  >;
  /** Identities to drop from the rotation pool. Existing prospect pins to a removed id will refuse to send until restored. */
  removeIdentityIds?: string[];
  icpOneLiner?: string;
  /** Founder background: résumé, prior companies, named roles. Founder-trust proof. */
  founderCredentials?: string;
  /** Products / projects you've shipped (free text, e.g. comma-separated). Peer-founder proof. */
  productPortfolio?: string;
  /** Notable partners / customers (free text, brand names). Brand-recognition proof. */
  partners?: string;
  /** Your OWN accelerator batch tag ("yc-w23"), only if you actually did one. Blank = accelerator-batch writes as an outsider. */
  founderCohort?: string;
  /** One true concession ("two people, no enterprise logos yet") for the optional damaging-admission beat. */
  founderAdmission?: string;
  /** What you offer someone who has not adopted on their own; the builder plays' last follow-up offers it instead of a plain breakup. */
  pilotOffer?: string;
  /** Product facts + canonical links replies may cite. Links absent from this brief are never sent. */
  productBrief?: string;
  founderVoice?: string;
  /** When true, signature appends a literal "Sent from my iPhone" line. */
  mobileSignature?: boolean;
  /** Slack incoming-webhook URL for reply/bounce/daily-summary notifications. Empty string clears it (feature off). */
  slackWebhookUrl?: string;
  /**
   * Install-wide daily USD spend ceiling (issue #481). `undefined` = leave
   * unchanged; `null` = clear it (unlimited); a positive number = set it.
   */
  dailySpendCeilingUsd?: number | null;
  /**
   * Which Gmail identity's calendar the scheduler polls (issue #577).
   * `undefined` = leave unchanged; `null` = turn the feature off (entirely
   * inert: no poll, no writes). Must be a `provider: 'gmail'` identity id
   * already in the pool with calendar.readonly scope.
   */
  calendarIdentityId?: string | null;
  /** Which calendar of `calendarIdentityId`'s account to poll. `undefined` = leave unchanged; blank/omit defaults to "primary" server-side. */
  calendarId?: string;
  llmProvider?: LlmProvider;
  llmModel?: string;
  telemetryEnabled?: boolean;
  walletMode?: WalletMode;
  /**
   * Default /queue review order. `undefined` = leave unchanged. Anything but
   * the two literals is ignored (keeps the current value).
   */
  queueReviewOrder?: "ranked" | "newest";
  /**
   * How reply intents are labelled. `undefined` = leave unchanged; `null` =
   * back to the default (`llm`). `decisions` needs a `model`; `minConfidence`
   * must be within 0–1. Anything else is a 400.
   */
  replyClassifier?: {
    engine: "llm" | "decisions";
    model?: string;
    minConfidence?: number;
  } | null;
  /**
   * Install-wide IANA time zone (issue #451 surfaced it: no other writer
   * exists). `undefined` = leave unchanged; `null` or blank = clear back to the
   * runtime zone; otherwise must be a valid IANA name or the request is 400.
   */
  timezone?: string | null;
  secrets?: Partial<
    Record<
      | "OPENROUTER_API_KEY"
      | "OPENAI_API_KEY"
      | "ANTHROPIC_API_KEY"
      | "CDP_API_KEY_ID"
      | "CDP_API_KEY_SECRET"
      | "CDP_WALLET_SECRET"
      | "AGENT_PRIVATE_KEY"
      | "GMAIL_CLIENT_ID"
      | "GMAIL_CLIENT_SECRET"
      | "GMAIL_REFRESH_TOKEN"
      | "SMARTLEAD_API_KEY"
      | "X_API_KEY"
      | "X_API_SECRET"
      | "X_ACCESS_TOKEN"
      | "X_ACCESS_SECRET"
      | "TWITTERAPI_IO_KEY"
      | "GITHUB_TOKEN"
      | "LUMA_SESSION_COOKIE"
      | "LINKEDIN_SESSION_COOKIE",
      string
    >
  >;
}

/**
 * One provisioned sending domain as seen by the browser. The wallet-owned
 * domain pool (SDK 0.19 `listDomains`), trimmed to the fields the setup UI
 * needs. Mirrors the SDK's DomainPoolEntry without leaking the SDK type into
 * the web layer.
 */
export interface DomainPoolView {
  domain: string;
  poolStatus: "active" | "warming" | "paused" | "removed";
  warmupScore: number | null;
  dailySendLimit: number;
  dailySentCount: number;
}

/** Result of POST /api/domains/{resume,pause}. The domain's new pool status. */
export interface DomainActionResult {
  domain: string;
  poolStatus: "active" | "paused";
}

/**
 * One Smartlead-connected mailbox as seen by the browser/CLI: sanitized
 * (Smartlead's raw rows carry mailbox passwords; those never leave core).
 */
export interface SmartleadAccountView {
  id: number;
  fromEmail: string;
  fromName: string | null;
  /** Smartlead's own per-mailbox daily send limit. */
  messagePerDay: number | null;
  dailySentCount: number;
  /** False = SMTP connection broken on Smartlead's side; sends will fail. */
  isSmtpSuccess: boolean;
  /** GMAIL | OUTLOOK | SMTP */
  type: string;
  /** ACTIVE | INACTIVE | PAUSED */
  warmupStatus: string | null;
  /** e.g. "95%" */
  warmupReputation: string | null;
  /** Already in this workspace's rotation pool. */
  alreadyRegistered: boolean;
}

/** One sender identity as shown on /setup: pool entry + today's usage. */
export interface SenderIdentityView {
  id: string;
  provider: "oneshot" | "gmail" | "smartlead";
  label: string | null;
  address: string | null;
  sendingDomain: string | null;
  /** OneShot only: the From local-part (mailbox) for this identity. Null for Gmail / legacy. */
  mailbox: string | null;
  maxPerDay: number | null;
  warmup: { startPerDay: number; incrementPerWeek: number } | null;
  /**
   * Smartlead mailboxes only: "smtp" sends through the mailbox's own SMTP
   * under one fixed Message-ID per email; "provider" goes through Smartlead.
   * Null for other providers. Absent in older API responses.
   */
  sendVia?: "provider" | "smtp" | null;
  /** This mailbox's own sends today. */
  sentToday: number;
  /**
   * Sends today across the whole cap-group this identity shares: i.e. every
   * mailbox on the same OneShot sending domain (reputation + the daily limit
   * are per-domain). Equals `sentToday` when the identity is the only mailbox
   * on its domain (and for Gmail, which is always per-account).
   */
  domainSentToday: number;
  /** The cap-group's effective ceiling today after the warm-up ramp (shared across the domain's mailboxes); null = uncapped. */
  capToday: number | null;
  /** True when synthesized from legacy single-provider config (not yet a persisted pool). */
  legacy: boolean;
  /**
   * Gmail only (issue #577): whether this identity's token carries the
   * calendar.readonly scope. Null for non-Gmail providers, which have no
   * calendar concept at all. The /setup "Reconnect for calendar" action is
   * only offered on `false`.
   */
  hasCalendarScope: boolean | null;
}

export type QueueStatusView = "pending" | "approved" | "rejected" | "sent" | "expired";

export const PRIORITY_COMPONENT_KEYS = [
  "personFit",
  "accountFit",
  "intentStrength",
  "timingFreshness",
  "signalConfidence",
  "contactability",
] as const;
export type PriorityComponentKey = (typeof PRIORITY_COMPONENT_KEYS)[number];

/** Every priority-artifact version the system can parse and render. */
export type PriorityVersion = "heuristic-v1" | "heuristic-v2";

/**
 * Canonical per-version component weights (percent, each row sums to 100).
 * The scoring engine (packages/find) AND the web chip both read THIS table:
 * never restate the numbers elsewhere; a hand-copied weight list drifted
 * once already. V2 kept v1's weights on purpose: the label-mined fix was
 * feature DIRECTION (exec titles and Host roles were anti-signals), not the
 * weighting.
 */
export const PRIORITY_WEIGHTS_BY_VERSION: Record<
  PriorityVersion,
  Record<PriorityComponentKey, number>
> = {
  "heuristic-v1": {
    personFit: 30,
    accountFit: 20,
    intentStrength: 20,
    timingFreshness: 15,
    signalConfidence: 10,
    contactability: 5,
  },
  "heuristic-v2": {
    personFit: 30,
    accountFit: 20,
    intentStrength: 20,
    timingFreshness: 15,
    signalConfidence: 10,
    contactability: 5,
  },
};

/**
 * Shadow-mode explainable priority score (issue #410, Phase 1). Mirrors
 * core's `ProspectPriority`. The API contract copy, like
 * `QueueStatus`/`QueueStatusView`. Display-only: nothing orders, filters, or
 * gates by it, and it is NOT a conversion probability.
 */
export interface ProspectPriorityView {
  version: PriorityVersion;
  /** Weighted total, clamped integer 0..100. */
  total: number;
  components: Record<PriorityComponentKey, number>;
  /** Concise evidence strings, fixed order. */
  reasons: string[];
  finder: string;
  scoredAt: string;
}

/**
 * What the sending mailbox's Sent folder held for one recorded email send
 * (Smartlead / Gmail only: OneShot sends carry an idempotency key). `duplicate`
 * = the provider delivered it more than once; `not_found` = no copy after the
 * check window (possible silent drop); `skipped` = the mailbox could not be
 * read for good (e.g. the identity was removed).
 */
export interface SendDeliveryView {
  status: "ok" | "duplicate" | "not_found" | "skipped";
  expected: number;
  observed: number | null;
  /** ISO times of each copy found, oldest first. */
  deliveredAt: string[];
  sentAt: string;
  checkedAt: string;
  transport: "smartlead" | "gmail";
  identity: string;
  error: string | null;
  /**
   * The send carried an idempotency key and one fixed Message-ID: the outbound
   * sweep confirmed it by that id, and it is never resent. Absent in older API
   * responses.
   */
  keyed?: boolean;
}

export interface QueueRowView {
  /** Known email fit hold; absent in older API responses. Approval status is independent. */
  sendHold?: { code: "off-icp"; reason: string } | null;
  /** Delivery check of the first-touch send, when one ran (sent rows only). */
  delivery?: SendDeliveryView | null;
  id: number;
  playName: string;
  /** Outreach channel of the first touch: email, linkedin or x. */
  channel: "email" | "linkedin" | "x" | "reddit" | "hacker-news";
  /**
   * Who sends it: `api` (Send / drain), `manual` (copy, send by hand, Mark
   * sent) or `unavailable` (nothing can send on this channel yet).
   */
  sender: "api" | "manual" | "unavailable";
  payload: unknown;
  dedupeKey: string;
  source: string;
  status: QueueStatusView;
  foundAt: string;
  reviewedAt: string | null;
  sentAt: string | null;
  notes: string | null;
  prospectId: number | null;
  /**
   * Most-recent draft generated for this row by the /api/run SSE endpoint.
   * Null on rows that have never been through a /run pass. The /queue UI
   * uses this to render the draft block in the expanded row.
   */
  lastDraft: LastDraft | null;
  /** ISO timestamp of `lastDraft`. Null when no draft persisted. */
  lastDraftedAt: string | null;
  /**
   * True when a Send-draft is in flight on this row. Backed by the persisted
   * `target_queue.send_started_at` marker so the `/queue` UI's spinner
   * survives navigate-away-and-back AND server restart. Cleared automatically
   * when the row's status flips to a terminal state.
   */
  isSending: boolean;
  /**
   * Shadow-mode priority artifact, or null on manual/legacy/pre-migration
   * rows and rows whose stored artifact fails shape validation.
   */
  priority: ProspectPriorityView | null;
  /**
   * Decision provenance (ledger v26). `status` alone is lossy. An expiry
   * overwrites an approval, so the browse view reads these to say who
   * decided what. Null on undecided and pre-v26 rows.
   */
  decision: "approve" | "reject" | "auto_reject" | null;
  decidedBy: "human" | "human_bulk" | "machine" | null;
  decidedAt: string | null;
  /** The structured reason the founder picked (#813); null on legacy, bulk and machine decisions. */
  decisionReason?: DecisionReason | null;
}

/** Who decided a queue row, as a /prospects filter. `human` groups per-row and bulk clicks. */
export type DecidedByFilter = "human" | "machine" | "none";
export type ProspectSortKey = "found" | "decided" | "name";

/** The prospect record a queue row resolved to: by `prospect_id`, else by its payload email. */
export interface ProspectLinkView {
  id: number;
  name: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  /** 'pass' | 'reject' | 'unclear' | null (never judged). Only 'reject' suppresses sending. */
  icpVerdict: string | null;
  icpVerdictReason: string | null;
  hasDossier: boolean;
  linkedBy: "prospect_id" | "email";
}

/** One row of the /prospects browse table: a queue row plus its linked prospect, if any. */
export interface ProspectBrowseRow extends QueueRowView {
  prospect: ProspectLinkView | null;
}

/**
 * The decision trail in three words: one vocabulary for the /prospects
 * table, its drawer and the history list, so a bulk approval never reads
 * "bulk-approved" on one line and "approved (bulk)" on the next.
 */
export function describeDecision(row: {
  decision: QueueRowView["decision"];
  decidedBy: QueueRowView["decidedBy"];
  status?: QueueStatusView;
}): string {
  if (row.decision === "auto_reject" || (row.decision === "reject" && row.decidedBy === "machine"))
    return "auto-rejected";
  if (row.decision === "reject") return "rejected by you";
  if (row.decision === "approve") {
    if (row.decidedBy === "human_bulk") return "bulk-approved";
    if (row.decidedBy === "machine") return "approved by machine";
    return "approved by you";
  }
  if (row.status === "expired") return "expired";
  return row.status ? "undecided" : "decided";
}

/** GET /api/queue/search */
export interface ProspectSearchResponse {
  rows: ProspectBrowseRow[];
  /** Rows matching every filter, before paging. */
  total: number;
  limit: number;
  offset: number;
  /** Per-status counts under the q/play/decided filters: NOT narrowed by the status filter. */
  counts: QueueCounts;
  /** Every play that has ever enqueued a row, for the play filter. */
  plays: string[];
}

/** One entry of a prospect's history, newest first. Carries no reply bodies: /inbox owns those. */
export interface ProspectTimelineEvent {
  /** ISO timestamp. */
  at: string;
  kind: "surfaced" | "decided" | "sent" | "sequence" | "reply" | "channel" | "outcome";
  label: string;
  detail: string | null;
  playName: string | null;
}

/** GET /api/queue/:id: everything the /prospects detail drawer shows. */
/** One post by (or reposted by) a prospect, from research or the newsfeed capture. */
export interface DossierPostView {
  platform: string | null;
  content: string | null;
  url: string | null;
  postedAt: string | null;
  likes: number | null;
  replies: number | null;
  shares: number | null;
  /** Someone else's words ("RT @handle: …"). */
  isRepost: boolean;
  source: "research" | "newsfeed";
}

export interface DossierRoleView {
  company: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
}

export interface DossierEducationView {
  school: string;
  degree: string | null;
  period: string | null;
}

/**
 * `GET /api/queue/:id/dossier`: the full cached person research behind a row,
 * which the row payload only carries a bounded summary of, plus every cached
 * recent post. Read-only: it never buys research or a newsfeed.
 */
export interface QueueDossierView {
  /** complete = the full research cache entry was found; summary-only = only the row's bounded summary. */
  status: "complete" | "summary-only" | "none";
  researchedAt: string | null;
  person: {
    fullName: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    summary: string | null;
    linkedinUrl: string | null;
    emails: string[];
    phones: string[];
    skills: string[];
  };
  experience: DossierRoleView[];
  education: DossierEducationView[];
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    location: string | null;
    size: string | null;
    fundingStage: string | null;
    description: string | null;
  } | null;
  /** Newest first, deduped across both sources. */
  posts: DossierPostView[];
  /** When the newsfeed was captured, or null when it never ran (it runs on approval). */
  newsfeedFetchedAt: string | null;
}

export interface QueueRowDetail {
  row: ProspectBrowseRow;
  prospect: (ProspectLinkView & { linkedinUrl: string | null; createdAt: string }) | null;
  cadences: CadenceView[];
  timeline: ProspectTimelineEvent[];
  flags: {
    /** The prospect has answered (email or LinkedIn). An override must not re-email them. */
    replied: boolean;
    /** A hard bounce suppresses the address. */
    bounced: boolean;
    /** 'unsubscribe' | 'auto_permanent' from the reply stream, else null. */
    contactSuppressed: string | null;
    /** A not-a-fit / do-not-contact manual stop. */
    breakupHold: boolean;
    icpReject: boolean;
  };
}

/**
 * Manual "Add Prospect": paste a LinkedIn or X/Twitter profile URL (optionally
 * an email to use). The server researches the profile, has the LLM pick an
 * ICP-grounded angle + draft the intro, and lands it as a reviewable row in the
 * Queue under the `profile-intro` play.
 */
export interface AddProspectRequest {
  businessAddress?: BusinessMailAddress;
  /** A LinkedIn, X/Twitter, or GitHub profile URL. */
  url: string;
  /** Optional email to use when research can't find one. */
  email?: string;
}

/**
 * The add returns immediately (research runs ~2-5 min in the background). The
 * drafted prospect appears on `/queue` when ready. `queued:false` with
 * `duplicate:true` means this profile is already in the queue.
 */
export interface AddProspectResult {
  queued: boolean;
  duplicate?: boolean;
  queueId?: number;
}

/**
 * Per-row draft envelope persisted after each /api/run dispatch. `dryRun`
 * distinguishes preview-only drafts from real-send attempts; `sent` is
 * true only when the SDK actually emitted the email (false for dryRun
 * and for lint-blocked drafts).
 */
/**
 * Which angle a draft was built on. The part of `DraftAngle` every draft
 * path (drain, /api/run, regenerate, cadence preview) can supply. The
 * draft-version record keys on `text`.
 */
export interface DraftAngleChoice {
  text: string;
  origin: "configured" | "generated";
  index: number;
  count: number;
  /** Follow-ups: the angle is the intro's own, not a new one. */
  sameAsIntro?: boolean;
}

/** One entry in a row's draft history (`GET /api/queue/:id/drafts`, `GET /api/cadences/:id/drafts`). */
export interface DraftVersionView {
  id: number;
  stepIndex: number;
  subject: string;
  body: string;
  flags: string[];
  angle: { text: string; origin: "configured" | "generated" } | null;
  outcome: "open" | "discarded" | "sent" | "auto_sent";
  discardReason: "regenerate" | "rotate" | "redraft" | "abandoned" | null;
  /** Fingerprint of the approved learned-guidance set the draft was written with (#813). */
  learningKey?: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** Per-angle review outcomes, counted in distinct prospects (see ledger-drafts.ts). */
export interface AngleUsageView {
  text: string;
  offered: number;
  rotatedAway: number;
  redrafted: number;
  sent: number;
  autoSent: number;
  /** Distinct prospects who replied to a send built on this angle. */
  replied: number;
  /** Distinct prospects this angle was sent to (reviewed or unattended). The rate's denominator. */
  reached: number;
  /**
   * The same counts restricted to drafts whose angle the trigger's
   * `angleAssignment: "arm"` split assigned instead of the fit classifier:
   * the controlled comparison. Absent (or zero) when no arm draft exists.
   */
  armOffered?: number;
  armReached?: number;
  armReplied?: number;
}

/** Draft-version counts by outcome for one play and one scope (intro or follow-up). */
export interface DraftUsageView {
  open: number;
  regenerated: number;
  rotated: number;
  sent: number;
  autoSent: number;
  /** Sent or auto-sent versions whose send got a reply. */
  replied: number;
}

/** The same counts split by whether a founder voice card was in the prompt (ledger-drafts.ts `draftUsageByVoice`). */
export interface VoiceUsageView {
  voiced: DraftUsageView;
  plain: DraftUsageView;
}

export interface DraftAngle {
  pool?: Array<{ text: string; origin: "configured" | "generated" }>;
  text: string;
  origin: "configured" | "generated";
  index?: number;
  count?: number;
  /**
   * `arm` when the trigger's `angleAssignment: "arm"` split assigned this
   * angle (an even, stable per-prospect assignment) instead of the fit
   * classifier; absent otherwise. A rotated angle is the founder's choice and
   * never carries it.
   */
  assignment?: "arm";
  fingerprint: string;
  history: string[];
}

export interface LastDraft {
  angle?: DraftAngle;
  subject: string;
  body: string;
  flags: string[];
  sent: boolean;
  receiptIds: number[];
  dryRun: boolean;
  draftedAt: string;
  /** Enrichment SDK failed for this prospect: draft built from payload only. Non-blocking (send stays enabled). */
  enrichmentFailed?: boolean;
  /** Hash of the founder's voice card the draft was written with; absent when none was set. */
  voiceKey?: string | null;
  /** Fingerprint of the approved learned-guidance set the draft was written with (#813). */
  learningKey?: string | null;
  /** First-touch format arm the draft was written in (`standard` / `brief`); absent when the trigger set none. */
  formatKey?: string | null;
}

/**
 * Where a queue row's `fitReason` came from (issue #592): the company-level
 * ICP gate at find time, the person-level gate, one generated sentence (the
 * finders with no gate, the manual add, the backfill), or a reason recovered
 * from a pre-#592 `notes` template by the backfill.
 */
export type FitReasonSource = "company-gate" | "person-gate" | "generated" | "notes";

/**
 * Draft flags that HOLD a draft from auto-send but are deliberately overridable
 * by a founder on a manual "send this one". They mean "needs a human glance,"
 * not "broken copy." Unlike lint flags (em-dash, rule-of-three, …) or dedup
 * outcomes (already-contacted), regenerating won't clear these and shouldn't:
 * the founder either sends as-is or rejects.
 *
 * Currently: `stale-event`. A luma-events event >14 days past, where the
 * guest-list signal is old enough to want confirmation before sending;
 * `contacted-elsewhere`: another WORKSPACE (another product of yours) emailed
 * this person inside the 7-day hold window, so two motions don't stack in one
 * inbox; and `ungrounded`: enrichment failed and the row carries no title or
 * bio, so the draft could only lean on the company name (`lintGrounding`).
 * Regenerating cannot clear that one either: the research is what is missing,
 * and a founder who has read the draft is the only judge of whether it still
 * says something true. `email-at-former-employer`: person research says the
 * stored address belongs to a company they have left; the address is never
 * swapped (dedupe, verification and consent history key on it), the founder
 * decides. Sending as-is is the founder saying "I know, do it anyway."
 * `commits-terms`. The reply promises pricing, distribution, partnership terms
 * or documentation placement (#480). It blocked Send outright until #647, on the
 * premise that the sender cannot authorise what they are promising. For a solo
 * founder that premise is inverted: they are the only person who can, and the
 * block landed hardest on the replies that most needed sending, where a partner
 * had asked point blank whether the terms were authorised. It still earns a
 * second read, which is what a soft flag is for.
 */
export const SOFT_REVIEW_FLAGS: readonly string[] = [
  "stale-event",
  "contacted-elsewhere",
  "ungrounded",
  "email-at-former-employer",
  "commits-terms",
];

/**
 * The subset of a draft's flags that genuinely block sending (everything except
 * the founder-overridable soft-review flags). Empty → the draft is sendable.
 * Shared by the server send gate and the queue UI's send button so the two
 * never disagree on whether a held draft can be force-sent.
 */
export function blockingFlags(flags: string[]): string[] {
  return flags.filter((f) => !SOFT_REVIEW_FLAGS.includes(f));
}

/**
 * Plays the SSE `/api/run/:playName` endpoint can dispatch: i.e. the ones
 * drivable from the dashboard rather than the CLI. Canonical: the server's run
 * gate, /queue's drain button and the Plays page all read THIS, because three
 * hand-copied mirrors of the list had already drifted apart (the queue's copy
 * was missing luma-events, the Plays page's was missing competitor-switch).
 *
 * Adding a play here also requires a form schema in the web app's
 * `lib/playSchemas.ts`; a test pins the two together.
 */
export const RUNNABLE_PLAYS: readonly string[] = [
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
  "competitor-switch",
  "stack-consolidation",
  "repo-interest",
  "luma-events",
  "sources-sought",
  "civic-pilot",
  "design-partner-loi",
  "discovery-interview",
  "free-pilot",
  "new-business",
];

/**
 * Parse a `?ids=1,2,3` queue-row pick (the "drain selected" path).
 *
 * Returns `undefined` only when the parameter is ABSENT. A present-but-unusable
 * value (`?ids=`, `?ids=abc`) returns `[]` (an explicit empty pick) because
 * collapsing it to "absent" would silently downgrade a scoped drain into an
 * unscoped one and hydrate rows the founder never selected, which they could
 * then send. Tokens must be whole decimal integers: `123abc` is rejected
 * outright rather than parsed as `123`, which would load an unintended row.
 * Capped at 500 to match the list endpoint's own limit.
 */
export function parseQueueIds(raw: string | null | undefined): number[] | undefined {
  if (raw == null) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, 500);
}

const RUNNABLE_PLAY_SET = new Set(RUNNABLE_PLAYS);

export function isRunnablePlay(playName: string): boolean {
  return RUNNABLE_PLAY_SET.has(playName);
}

/** The x-reposters finder's data provider. First-party costs ~55x more per read. */
export type XEngine = "xapi" | "twitterapiio";

/**
 * Return a copy of an x-reposters trigger config with the engine set. Shared
 * by the /setup card and `config x-engine`. Both sides must apply the same
 * rule: when the engine actually CHANGES, drop the `maxSpendPerRun` and
 * `knobs` overrides so the registry's per-engine defaults re-apply (carrying
 * twitterapi.io's $1 ceiling onto the X API buys ~100 user reads and stalls
 * the run). Explicit re-overrides stay possible via the /queue config editor.
 */
export function withXEngine(
  config: Record<string, unknown> | null | undefined,
  engine: XEngine,
): Record<string, unknown> {
  const out = { ...config };
  if (out["engine"] !== engine) {
    delete out["maxSpendPerRun"];
    delete out["knobs"];
  }
  out["engine"] = engine;
  return out;
}

/**
 * Classification of an inbound email (mirrors core's reply-classify.ts):
 * `human` is a real reply; `auto` a temporary autoresponder (OOO);
 * `auto_permanent` a dead-mailbox notice; `unsubscribe` a removal request.
 */
export type InboundReplyKind = "human" | "auto" | "auto_permanent" | "unsubscribe";

/**
 * Sentiment/intent classification of a HUMAN reply (issue #480). The single
 * source of truth for the label set: both classifiers (the LLM triage prompt
 * and the typed decisions engine) and every consumer derive from this table.
 * Independent of `InboundReplyKind` above (that's deliverability triage; this
 * is sentiment). NULL/absent on a reply means it hasn't been triaged yet, or
 * the triage call failed.
 *
 * Existing label strings never change: stored rows and the opt-out checks
 * (`intent = 'unsubscribe'`) depend on them.
 */
export interface ReplyIntentMeta {
  label: string;
  /** Definition sent to both classifiers. */
  description: string;
  /** Short human label for the dashboard. */
  title: string;
  polarity: "positive" | "neutral" | "negative";
  /** Shows as waiting for the founder's answer on /inbox. */
  needsReply: boolean;
  /**
   * What the label means for the cadence. Today any human reply already stops
   * the cadence whatever its label; this records that per label.
   */
  stopsCadence: boolean;
  /** Contact is vetoed everywhere (contact-optout.ts). Only `unsubscribe`. */
  optOut: boolean;
}

export const REPLY_INTENTS = [
  {
    label: "interested",
    title: "Interested",
    description:
      "They want to talk or see a demo, ask a buying question, or describe their own use case.",
    polarity: "positive",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "question",
    title: "Question",
    description: "They ask a clarifying question that doesn't yet show buying intent.",
    polarity: "positive",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "partnership",
    title: "Partnership",
    description: "They propose an integration, a partnership, or co-marketing.",
    polarity: "positive",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "meeting",
    title: "Meeting",
    description:
      "They book, accept, reschedule, or confirm a meeting, including calendar invites and scheduling logistics.",
    polarity: "positive",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "intro",
    title: "Intro",
    description:
      "They introduce you to someone else, or a connector writes to introduce two people to each other.",
    polarity: "positive",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "not_now",
    title: "Not now",
    description: "Interested, but the timing is off (circle back next quarter, after our launch).",
    polarity: "neutral",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "objection",
    title: "Objection",
    description:
      "Concrete pushback on the product or offer: price, fit, integration, security, competing tools.",
    polarity: "neutral",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "complaint",
    title: "Complaint",
    description:
      "They complain about the outreach itself: duplicate emails, wrong details about them, too many messages.",
    polarity: "negative",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "not_interested",
    title: "Not interested",
    description:
      "A polite no or 'not relevant', without hostility and without asking to stop being emailed.",
    polarity: "negative",
    needsReply: false,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "wrong_person",
    title: "Wrong person",
    description: "Not their area: they point you to someone else or say they're the wrong contact.",
    polarity: "neutral",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "unsubscribe",
    title: "Unsubscribe",
    description: "An explicit request to stop emailing them, or a hostile reply.",
    polarity: "negative",
    needsReply: false,
    stopsCadence: true,
    optOut: true,
  },
  {
    label: "pitch_back",
    title: "Pitch back",
    description: "They pitch their own product or service to you instead of responding to yours.",
    polarity: "neutral",
    needsReply: false,
    stopsCadence: true,
    optOut: false,
  },
  {
    label: "auto_reply",
    title: "Auto-reply",
    description: "An out-of-office, vacation notice, or other autoresponder.",
    polarity: "neutral",
    needsReply: false,
    stopsCadence: false,
    optOut: false,
  },
  {
    label: "other",
    title: "Other",
    description: "Anything that doesn't fit the other labels cleanly.",
    polarity: "neutral",
    needsReply: true,
    stopsCadence: true,
    optOut: false,
  },
] as const satisfies readonly ReplyIntentMeta[];

export type ReplyIntent = (typeof REPLY_INTENTS)[number]["label"];

/** Every label, in table order. */
export const REPLY_INTENT_LABELS: readonly ReplyIntent[] = REPLY_INTENTS.map((i) => i.label);

const REPLY_INTENT_BY_LABEL: ReadonlyMap<string, ReplyIntentMeta> = new Map(
  REPLY_INTENTS.map((i): [string, ReplyIntentMeta] => [i.label, i]),
);

export function isReplyIntent(value: unknown): value is ReplyIntent {
  return typeof value === "string" && REPLY_INTENT_BY_LABEL.has(value);
}

/** The table entry for a label, or null for an unknown/legacy string. */
export function replyIntentMeta(label: string | null | undefined): ReplyIntentMeta | null {
  return label ? (REPLY_INTENT_BY_LABEL.get(label) ?? null) : null;
}

/**
 * Intents that surface the intent badge + needs-decision state on /inbox:
 * the replies waiting for the founder's answer.
 */
export const POSITIVE_REPLY_INTENTS: readonly ReplyIntent[] = REPLY_INTENTS.filter(
  (i) => i.needsReply,
).map((i) => i.label);

/**
 * Labels `find calibrate` reads as positive reply evidence: positive polarity,
 * plus `objection` (a live back-and-forth, not a ghost) and `other` (unchanged
 * from before the table). Every other known label, and any unknown string,
 * is not positive evidence.
 */
export const POSITIVE_OUTCOME_INTENTS: readonly ReplyIntent[] = REPLY_INTENTS.filter(
  (i) => i.polarity === "positive" || i.label === "objection" || i.label === "other",
).map((i) => i.label);

/** A single inbox email (reply to outreach), with prospect/play context when matched. */
export interface InboxReplyView {
  bounceKind?: "hard" | "block" | "soft" | null;
  id: string;
  /** What this inbound actually is. Only `human` counts as a reply anywhere. */
  kind: InboundReplyKind;
  /** Sentiment classification (issue #480); null = not yet triaged (or triage failed). */
  intent: ReplyIntent | null;
  intentReason: string | null;
  /** Classifier confidence in `intent` (0–1), when the engine gives one. */
  intentConfidence?: number | null;
  /** The label's confidence was under the workspace threshold: check it before acting. */
  intentReview?: boolean;
  /** Normalized sender address (lowercased, display-name stripped). */
  fromEmail: string;
  /** Raw From header as received (may include a display name). */
  fromRaw: string;
  subject: string;
  receivedAt: string;
  body: string;
  /** Sender identity whose mailbox received this email. The reply goes out from it. Null on legacy/unattributed rows. */
  sourceIdentityId: string | null;
  /** Provider of the receiving identity. Gmail replies thread properly; oneshot replies are best-effort fresh sends (paid, subject-threading only). */
  sourceProvider: "gmail" | "oneshot" | "smartlead" | null;
  /** Gmail thread id (gmail sources only): passed back on send to thread the reply. */
  threadId: string | null;
  /** RFC 2822 Message-ID of the inbound email (gmail sources only): In-Reply-To on the reply. */
  messageId: string | null;
  /** Set when the sender matches a known prospect; null for unmatched mail. */
  matched: {
    name: string | null;
    company: string | null;
    playName: string | null;
    cadenceStatus: string | null;
  } | null;
  /**
   * Persisted reply activity for this thread: the saved (auto-saved) draft, and
   * the append-only history of replies already sent. Null when nothing has been
   * drafted or sent yet. Keyed server-side by `inboxThreadKey`.
   */
  thread: {
    draftBody: string | null;
    sent: { body: string; sentAt: string }[];
    /** Founder's standing redraft instruction for this thread, if set. */
    steer: string | null;
    /** 'needs_decision' when the current draft's `commits-terms` lint flag survived the repair pass: Send is blocked until edited or steered. Null otherwise. */
    status: "needs_decision" | null;
  } | null;
}

/**
 * Stable key for an inbox thread, shared by the server (persistence) and the
 * web composer (send payload) so both sides agree. Gmail rows carry a
 * thread_id; OneShot rows fall back to the email id (best-effort: OneShot has
 * no thread API).
 */
export function inboxThreadKey(v: { threadId: string | null; id: string }): string {
  return v.threadId ?? v.id;
}

/** One item on a conversation timeline, oldest first. */
export type ConversationItem =
  | {
      /** An outreach step this tool sent (sequence_events, email channel). */
      kind: "outreach";
      at: string;
      subject: string | null;
      body: string | null;
      stepIndex: number;
      playName: string;
    }
  | {
      /** An inbound reply from the prospect (ledger-persisted, or live mail not yet captured). */
      kind: "reply";
      at: string;
      subject: string | null;
      body: string;
      id: string;
      threadKey: string;
      sourceIdentityId: string | null;
      threadId: string | null;
      messageId: string | null;
      /** Classification of this inbound (NULL rows from before the classifier read as human). */
      replyKind: InboundReplyKind;
      /** Sentiment classification (issue #480); null = not yet triaged. */
      intent: ReplyIntent | null;
    }
  | {
      /** A manual reply the founder sent from /inbox (inbox_sent). */
      kind: "sent";
      at: string;
      subject: string | null;
      body: string;
    };

/** The full exchange with one prospect: ledger-backed, complete forever. */
export interface ConversationView {
  prospectId: number;
  /** Workspace-local archive; a new inbound reply clears it. */
  archivedAt: string | null;
  name: string | null;
  company: string | null;
  email: string;
  playName: string | null;
  cadenceStatus: string | null;
  lastActivityAt: string;
  /** Saved (auto-saved) composer draft for the newest inbound's thread, if any. */
  draftBody: string | null;
  /** Founder's standing redraft instruction for the newest inbound's thread, if set. */
  steer: string | null;
  /** 'needs_decision' when the current draft's `commits-terms` lint flag survived the repair pass. */
  status: "needs_decision" | null;
  /** Sentiment classification of the newest inbound reply; null = not yet triaged. */
  intent: ReplyIntent | null;
  /**
   * True when a positive-intent inbound is still unacknowledged (round-2
   * correction, #480): the founder has neither replied to it nor recorded a
   * deal outcome for this prospect strictly after it arrived. Historical outcomes
   * do not acknowledge newer inbound replies. False once either
   * happens, even though `intent` itself is never cleared: `intent` is a
   * historical classification, this is the "does it still need the nav dot"
   * signal derived from it.
   */
  awaitingReply: boolean;
  items: ConversationItem[];
}

export interface InboxResult {
  /** Durable direct-mailbox threads, separate from legacy per-prospect conversations. */
  mailboxThreads?: MailboxThreadView[];
  mailboxes?: MailboxHealthView[];
  replies: InboxReplyView[];
  /** Threaded matched view: one entry per prospect with a recorded reply. */
  conversations?: ConversationView[];
  hasMore: boolean;
  /** Present when the inbox fetch failed; replies will be empty. */
  error?: string;
}

export type InboxArchiveRequest =
  | { prospectId: number; archived: true; observedReplyIds: string[] }
  | { prospectId: number; archived: false };

export interface InboxArchiveResult {
  ok: true;
}

/** POST /api/inbox/draft-reply: generate an LLM reply draft for an inbound email. */
export interface InboxDraftReplyRequest {
  fromEmail: string;
  subject: string;
  body: string;
  /** Inbound email id + thread id, so the server can include this thread's prior sent replies. */
  id?: string;
  threadId?: string | null;
}

export interface InboxDraftReplyResult {
  learningKey?: string | null;
  body: string;
  /** Paid research spend this draft incurred (0 on cache hits / known prospects). */
  costUsd: number;
  /** True when the server ran paid research on the sender before drafting. */
  researched: boolean;
  /** Lint flags that survived the repair pass: currently only ever `commits-terms`. */
  flags: string[];
  /** True when `flags` includes `commits-terms`: /inbox blocks Send until edited or steered. */
  needsDecision: boolean;
}

/** POST /api/inbox/draft: persist the in-progress draft for a thread (auto-save). */
export interface InboxSaveDraftRequest {
  threadKey: string;
  inboundEmailId: string;
  toEmail: string;
  subject: string;
  identityId: string | null;
  body: string;
}

export interface InboxSaveDraftResult {
  saved: boolean;
  /** 'needs_decision' when the SAVED body's `commits-terms` lint flag fires: recomputed server-side from the text itself, never client-supplied. */
  status: "needs_decision" | null;
}

/**
 * POST /api/inbox/steer: persist a founder redraft instruction on a thread
 * and generate a fresh draft grounded in it (issue #480).
 */
export interface InboxSteerRequest {
  fromEmail: string;
  subject: string;
  body: string;
  id?: string;
  threadId?: string | null;
  threadKey: string;
  steer: string;
}

export type InboxSteerResult = InboxDraftReplyResult;

/** POST /api/inbox/reply: send a (possibly edited) reply. */
export interface InboxSendReplyRequest {
  inboundEmailId?: string;
  sendRequestId?: string;
  to: string;
  subject: string;
  body: string;
  identityId: string;
  /** Thread key for persisting the sent reply (see `inboxThreadKey`). */
  threadKey: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  /** OneShot inbox email id for server-side threading (OneShot-source rows). */
  replyToEmailId?: string | null;
}

export interface InboxSendReplyResult {
  sent: boolean;
  id: string;
  costUsd: number;
}

export interface MailboxHealthView {
  identityId: string;
  address: string;
  lastSyncAt: string | null;
  status: "syncing" | "connected" | "error" | "disconnected";
  error: string | null;
  backfillRemaining: boolean;
  messages: number;
}

export interface MailboxThreadView {
  threadKey: string;
  identityId: string;
  mailboxAddress: string;
  prospectId: number | null;
  name: string | null;
  company: string | null;
  email: string;
  unread: boolean;
  archivedAt: string | null;
  historyComplete: boolean;
  lastActivityAt: string;
  reply: InboxReplyView;
  items: ConversationItem[];
}

export interface MailboxStateRequest {
  threadKey: string;
  observedReplyIds: string[];
  read?: boolean;
  archived?: boolean;
}

export interface MailboxConnectionRequest {
  identityId: string;
  address: string;
  imap: { host: string; port: number; secure: boolean; user: string; pass: string };
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
}

export interface QueueCounts {
  pending: number;
  approved: number;
  rejected: number;
  sent: number;
  expired: number;
}

export interface QueueListResponse {
  rows: QueueRowView[];
  counts: QueueCounts;
  /**
   * Approved rows per play across the WHOLE queue, unaffected by the `status` /
   * `play` filters that scoped `rows`. /queue's drain button reads this so it
   * can offer a play whose rows aren't on the visible page. Plays with nothing
   * approved are omitted.
   */
  approvedByPlay: Record<string, number>;
  /** Absent when the capacity computation failed: pages skip the figure. */
  sendsToday?: SendsToday;
  /**
   * The order `rows` actually came back in: `?order=` param, else the
   * configured `queueReviewOrder`. "ranked" only ever applies to the pending
   * review view; every other view is "newest" (found_at DESC).
   */
  order: "ranked" | "newest";
}

export interface DrainRequest {
  playName: string;
  limit: number;
  dryRun: boolean;
}

export interface DrainResult {
  drained: number;
  sent: number;
  errors: Array<{ id: number; message: string }>;
  /** Named reason the daily spend ceiling (issue #481) blocked this drain, if it did. */
  haltedReason?: string;
}

export interface TriggerView {
  name: string;
  lastPolledAt: string | null;
  lastRunSummary: unknown | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
  /** Registry default config. Null if this trigger isn't in the registry (orphan). */
  defaultConfig: Record<string, unknown> | null;
  defaultIntervalMs: number;
  /** Currently-active interval (defaultIntervalMs unless overridden via config.intervalMs). */
  intervalMs: number;
  /** True while an ad-hoc run is in flight on the server (fire-and-forget). */
  running: boolean;
  /** ISO timestamp of when the current in-flight run started. Null when `running=false`. */
  runningSince: string | null;
  /**
   * False when the spec declares a `readiness` fn that returns not-ready for
   * the current config (e.g. github-topics without `topics`). The UI uses
   * this to disable the Enable toggle + Run button.
   */
  ready: boolean;
  /** Human-readable reason when `ready === false`; null otherwise. */
  notReadyReason: string | null;
  approvalRate: number | null;
  approvalReviewed: number;
  approvalMinSamples: number;
  approvalRateThreshold: number;
  approvalRateWindowDays: number;
  deprioritized: boolean;
  deprioritizedReason: string | null;
  /**
   * What the founder did with each configured angle of this trigger's edge,
   * in config order, plus one bucket for generated alternatives. Null when
   * the trigger has no `yourEdge`/`yourClaim`.
   */
  angleUsage: { angles: AngleUsageView[]; generated: AngleUsageView } | null;
  /** Draft outcomes for this play, intro and follow-up apart. Null when nothing was ever drafted. */
  draftUsage: { intro: DraftUsageView; followUp: DraftUsageView } | null;
  /** The same outcomes split by voice card on/off. Null when nothing was ever drafted. */
  voiceUsage: VoiceUsageView | null;
  /**
   * Intro outcomes by first-touch format arm (`standard` / `brief`), present
   * only once a draft was written under a `firstTouchFormat` setting.
   */
  formatUsage?: Record<string, DraftUsageView> | null;
}

export interface PackView {
  id: string;
  label: string;
  /** One-line buyer summary for the picker. Absent on packs written before this existed. */
  summary?: string;
  /** Full reasoning, including why these channels. Shown behind a disclosure. */
  buyerBrief: string;
  icpOneLiner: string;
  /** Trigger names this pack touches. */
  triggers: string[];
  /** Founder-voice keys left blank by the pack (e.g. `yourEdge`, `yourClaim`). */
  requires: string[];
}

export interface PackApplyTriggerResult {
  name: string;
  enabled: boolean;
  ready: boolean;
  /** Human-readable reason when `ready === false`; null otherwise. */
  notReadyReason: string | null;
}

export interface PackApplyResult {
  id: string;
  applied: PackApplyTriggerResult[];
  /** Trigger names in the pack that aren't in the registry: patch skipped, apply still succeeds. */
  skipped: Array<{ name: string; reason: string }>;
  /** The pack's proposed icpOneLiner. Never written to config.json; the founder accepts it separately. */
  proposedIcpOneLiner: string;
}

export interface DeriveIcpResult {
  proposedIcp: string;
  sourceUrl: string;
  costUsd: number;
}

export interface DeriveBriefResult {
  proposedBrief: string;
  /** Sources actually read (post-normalization); failed URLs are listed in `skipped`. */
  sourceUrls: string[];
  /** Sources that could not be read, with the reason: surfaced, not silent. */
  skipped: Array<{ url: string; reason: string }>;
  costUsd: number;
}

export interface RunTriggerResult {
  name: string;
  fired: boolean;
  /**
   * True when the run was kicked off fire-and-forget: work is still in
   * progress on the server. `result` and `error` will be null; poll
   * `GET /api/triggers` for `lastRunSummary` to see the outcome.
   */
  pending: boolean;
  result: {
    source: string;
    candidates: number;
    droppedIcp: number;
    droppedDuplicate: number;
    droppedEnrichment: number;
    /** Person-level ICP gate drops. Only finders that adopted the gate set it. */
    droppedRole?: number;
    enqueued: number;
    costUsd: number;
    halted?: string;
  } | null;
  error: string | null;
}

export interface StrategistMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StrategistRequest {
  messages: StrategistMessage[];
}

/** Server-Sent Events frame contract for /api/strategist/stream. */
export type StrategistFrame =
  | { kind: "thinking" }
  | { kind: "delta"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface OutcomeRequest {
  email: string;
  outcome: "meeting_booked" | "sql_qualified" | "deal_won" | "deal_lost" | "ghosted";
  playName?: string;
  amountUsd?: number;
  notes?: string;
}

export interface RunPlayRequest {
  dryRun: boolean;
  /** Free-form per-play target rows; the server validates per-play shape. */
  targets: unknown[];
  /**
   * Optional parallel array of `target_queue.dedupe_key` values, one per
   * `targets[i]`. When present and length-matched, the SSE endpoint persists
   * each generated draft back to the matching queue row (`last_draft_json`).
   * Manual /run entries omit this so the persist hook is skipped. The
   * /queue is the authoritative archive only for queue-originated runs.
   */
  dedupeKeys?: (string | null)[];
}

/** Server-Sent Events frame contract for /api/run/$playName. */
export type RunPlayEvent =
  | {
      kind: "verify";
      total: number;
      verified: number;
      dropped: Array<{ email: string; reason: string; index?: number }>;
    }
  | { kind: "stage"; stage: string }
  | { kind: "draft"; index: number; subject: string; body: string; flags: string[] }
  | { kind: "send"; index: number; receiptIds: number[] }
  | { kind: "error"; index: number; message: string }
  | { kind: "done"; total: number; sent: number }
  /**
   * Terminal frame for an aborted run. The client closed the SSE stream or
   * POST /api/run/:runId/cancel fired. Distinct from `error`: nothing failed,
   * the remaining targets simply never billed. `sent` counts what went out
   * before the abort point.
   */
  | { kind: "cancelled"; reason: string; total: number; sent: number }
  /** First frame the server emits: gives the UI the runId so it can resume on nav-back. */
  | { kind: "runStarted"; runId: number; startedAt: string };

/** Lifecycle status of a /run-page dispatch persisted in the `runs` table. */
export type RunStatus = "running" | "done" | "interrupted" | "cancelled";

/**
 * Snapshot of one /run-page dispatch: returned by GET /api/runs/:id so the UI
 * can rebuild the per-target progress view after navigate-away-and-back, AND
 * decide whether to keep polling (status === 'running') or stop (done /
 * interrupted / cancelled). `events` is the accumulated SSE stream (same shape
 * callers see live), so the client renderer can be source-shared.
 */
export interface RunRecord {
  id: number;
  playName: string;
  dryRun: boolean;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  targetCount: number;
  draftedCount: number;
  sentCount: number;
  errorCount: number;
  /** Original targets array as posted to /api/run/:playName. */
  targets: unknown[];
  /** Queue-origin keys parallel to targets; empty for manually entered runs. */
  dedupeKeys: Array<string | null>;
  /** All SSE events accumulated so far (or all of them, when status !== 'running'). */
  events: RunPlayEvent[];
  /** Emails that were actually sent: used by /cadences?sinceRun to filter. */
  prospectEmails: string[];
  /** Why a `cancelled` run ended (client disconnect vs explicit cancel). Null otherwise. */
  cancelReason: string | null;
}

/**
 * Result of `POST /api/run/:runId/cancel`. Always 200 for a run that exists:
 * cancelling one that already finished is a no-op, and the caller tells the
 * cases apart by the fields rather than by a status code.
 *
 * `cancelled`. This request is the one that flipped the row to 'cancelled'.
 * `aborted`. A live run in this process got the signal (false means the
 *               row was terminal already, or the run was orphaned by a process
 *               exit and only the ledger write applied).
 * `status`. The row's status after the call.
 */
export interface CancelRunResponse {
  runId: number;
  status: RunStatus;
  cancelled: boolean;
  aborted: boolean;
  reason: string | null;
}

/** POST /api/queue/import. A row handed over by another workspace on this machine. */
export interface ImportQueueRowRequest {
  playName: string;
  dedupeKey: string;
  source: string;
  /** Already stripped of workspace-specific keys by the sender; stripped again on receipt. */
  payload: Record<string, unknown>;
  movedFrom: { workspace: string; queueId: number };
}

export interface ImportQueueRowResult {
  queueId: number;
  /** True when the destination re-opened a row it already held (rejected/expired) instead of inserting. */
  reused: boolean;
}

/** POST /api/queue/:id/move {workspace}. The source side of a hand-over. */
export interface MoveQueueRowResult {
  ok: true;
  destination: { name: string; port: number; queueId: number; reused: boolean };
}

/** Workspace identity + roster served by GET /api/workspace. */
export interface WorkspaceInfo {
  current: { name: string; home: string; port: number };
  workspaces: Array<{
    name: string;
    home: string;
    port: number;
    isCurrent: boolean;
    isDefault: boolean;
    /** Live-probed server-side (~300ms /api/health ping). */
    running: boolean;
  }>;
}

/* ── Calendar meetings (issue #577) ──────────────────────────────────── */

export type MeetingOutcomeView = "held" | "no_show" | "cancelled" | "rescheduled";
export type MeetingMatchStatusView = "exact" | "suggested" | "ambiguous" | "dismissed" | null;

/** One `meetings` row, projected for the browser. */
export interface MeetingView {
  calendarId: string;
  eventId: string;
  summary: string | null;
  startsAt: string | null;
  endsAt: string | null;
  organizerEmail: string | null;
  externalAttendees: string[];
  prospectId: number | null;
  prospectName: string | null;
  prospectEmail: string | null;
  suggestedProspectId: number | null;
  suggestedProspectName: string | null;
  suggestedProspectEmail: string | null;
  matchStatus: MeetingMatchStatusView;
  /** The match method, rendered as a human sentence. Never the bare score. */
  matchReason: string | null;
  outcome: MeetingOutcomeView | null;
  outcomeNote: string | null;
}

/** GET /api/meetings: split into the two lists the dashboard renders. */
export interface MeetingsResult {
  /** Past, matched, no outcome recorded. The nudge list. */
  awaitingOutcome: MeetingView[];
  /** Suggested/ambiguous matches needing a founder confirm/dismiss. */
  needsReview: MeetingView[];
}

export interface LogMeetingOutcomeRequest {
  calendarId: string;
  eventId: string;
  outcome: MeetingOutcomeView;
  note?: string;
}

export interface ConfirmMeetingMatchRequest {
  calendarId: string;
  eventId: string;
  prospectId: number;
}

export interface DismissMeetingMatchRequest {
  calendarId: string;
  eventId: string;
}

/** One calendar in the /setup picker, with a 7-day event count. A founder cannot reliably say which calendar their bookings land on. */
export interface CalendarPickerEntry {
  id: string;
  summary: string;
  accessRole: string;
  recentEventCount: number;
}
export * from "./replies.ts";
export * from "./icp-proposals.ts";
export * from "./learning.ts";

/** CSV classification reserves a queue row before it is ready for review. */
export function isQueueImportInProgress(row: {
  status: string;
  source: string;
  notes: string | null;
}): boolean {
  return (
    row.status === "expired" &&
    row.source === "find:csv-import" &&
    row.notes === "CSV import: ICP classification in progress"
  );
}

export * from "./onboarding.ts";

/** GET /api/linkedin/invites: LinkedIn invites left today (workspace share and account). */
export interface LinkedInInviteQuotaView {
  connected: boolean;
  /** Workspace share per UTC day; null = no share configured. */
  perDay: number | null;
  /** Slots this workspace used today (sent + in flight). */
  used: number;
  left: number | null;
  /** Invites left on the LinkedIn account today; null when unknown. */
  accountLeft: number | null;
  /** Display line, e.g. "LinkedIn invites today: 4 of 12 left · account 9 left"; null when nothing is known. */
  text: string | null;
}
