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
  /** Stopped by a hard bounce — the address is dead and is suppressed from further sends. */
  | "bounced"
  /** Stopped by an explicit do-not-contact reply — the prospect is suppressed from further sends. */
  | "unsubscribed";

export interface CadenceNextStepDraft {
  subject: string;
  body: string;
  flags: string[];
  draftedAt: string;
}

export interface CadenceSentStep {
  /** 0 = initial send; 1..N = registered cadence follow-ups in order. */
  stepIndex: number;
  /** Step label from the play registry ("initial send", "value follow-up", "breakup", …). */
  label: string;
  subject: string;
  /** Null when this row was written before subject/body persistence landed (pre-v8). */
  body: string | null;
  /** ISO timestamp of when the email actually sent. */
  sentAt: string;
}
export type StepChannel = "email" | "sms" | "voice" | "linkedin" | "x";

export interface CadenceView {
  prospectId: number;
  prospectEmail: string | null;
  prospectName: string | null;
  prospectCompany: string | null;
  playName: string;
  status: CadenceStatus;
  currentStep: number;
  enrolledAt: string;
  nextDueAt: string | null;
  lastPolledAt: string | null;
  /** Persisted next-step preview (set by Preview, cleared on advance). */
  nextStepDraft: CadenceNextStepDraft | null;
  /** Label of the next step ("value follow-up", "breakup", …). Null when
   *  no next step exists (cadence is at or past the last step). */
  nextStepLabel: string | null;
  /** Whether the next step is the final breakup. Derived from the cadence
   *  engine's registered sequence — single source of truth. */
  nextStepIsBreakup: boolean;
  /** Total registered follow-up steps for this play (excludes day-0).
   *  The UI uses `followupCount + 1` for the step-progress dot count. */
  followupCount: number;
  /** Touches already sent for this cadence (step 0 + cadence follow-ups), oldest first.
   *  Empty array when the cadence has just been enrolled and nothing has fired yet. */
  priorSteps: CadenceSentStep[];
  /** True when a fire-and-forget background send is currently in flight for this
   *  cadence step (set by the API layer when /send-next or /send-batch kicks off,
   *  cleared as each row's SDK call resolves). Drives the "sending…" badge on
   *  /cadences and gates the row out of further Send actions until it completes. */
  isSending: boolean;
  /** Last send-failure message (incl. platform `ref:`) when the most recent send
   *  attempt failed and nothing has succeeded since; null otherwise. Drives the
   *  "send failed · retrying" row indicator so a row blocked upstream reads
   *  differently from one merely waiting on the founder. */
  lastSendError: string | null;
  /** ISO timestamp of `lastSendError`. */
  lastSendErrorAt: string | null;
}

/**
 * Status breakdown for the /cadences summary tiles. Always computed over the
 * full set (scoped only by a sinceRun deep-link), independent of the active/all
 * table toggle — so REPLIED/BREAKUP/COMPLETED never read 0 just because the
 * table is filtered to active rows. `overdue` counts active cadences past due.
 */
export interface CadenceCounts {
  active: number;
  replied: number;
  breakup: number;
  completed: number;
  paused: number;
  bounced: number;
  overdue: number;
}

export interface CadencesResult {
  cadences: CadenceView[];
  counts: CadenceCounts;
  /** Absent when the capacity computation failed — pages skip the figure. */
  sendsToday?: SendsToday;
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
}

/**
 * Per-cadence RoCS rollup (OneShot `rocsByGoal`) with local labels. `value` is
 * confirmed outcome value, `pendingValue` self-reported but unconfirmed; `rocs`
 * is value ÷ spend.
 */
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
 * Lightweight projection of a `runs` row for the home dashboard's "In flight"
 * strip. Slim shape — `targets` and `events` stay on the `RunRecord` returned
 * by `GET /api/runs/:id` where they're actually needed for the per-target
 * rendering. Avoids paying to serialize event arrays on every 30s home poll.
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
 * domain counts once). `cap: null` = at least one identity is uncapped —
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
  /** Absent when the capacity computation failed — pages skip the figure. */
  sendsToday?: SendsToday;
  /**
   * Runs currently `running` (in-flight). Capped at 5 for the home widget.
   * The `CurrentRunsStrip` on /home hides itself when this is empty.
   */
  currentRuns: RunSummary[];
}

export interface PlayDescriptor {
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
  /** Code-default cumulative days for the same steps — lets the UI offer "reset". */
  defaultDays: number[];
}

export type LlmProvider = "openrouter" | "openai" | "anthropic";
export type WalletMode = "cdp" | "private-key";
export type KeySource = "env" | "file" | null;

/** Section a doctor check renders under in the dashboard's grouped panel. */
export type DoctorGroup = "install" | "senders" | "deliverability" | "spend";

export interface DoctorCheck {
  name: string;
  /** Optional so stale clients tolerate its absence; the engine always sets it. */
  group?: DoctorGroup;
  severity: "ok" | "warn" | "fail";
  message: string;
  hint?: string;
}

export interface SetupRequest {
  founderName?: string;
  founderEmail?: string;
  productOneLiner?: string;
  productDomain?: string;
  sendingDomain?: string;
  /** Email transport: OneShot SDK (wallet-owned domain) or the founder's own Gmail/Workspace account. Legacy — ignored once the identities pool exists. */
  emailProvider?: "oneshot" | "gmail";
  /** Per-identity daily-cap edits ({ id, maxPerDay }). Null maxPerDay = uncapped. */
  identityUpdates?: Array<{ id: string; maxPerDay: number | null }>;
  /**
   * New sending identities to add to the pool. OneShot: a wallet-owned domain
   * (must be one returned by the provisioned-domain pool) + a mailbox
   * local-part. Smartlead: a connected account's address (from the accounts
   * listing), with `providerMessagePerDay` carrying Smartlead's own cap so the
   * default ceiling clamps to it. Omit `maxPerDay` to take the cold-start
   * warm-up ramp; pass `null` to add uncapped.
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
      }
  >;
  /** Identities to drop from the rotation pool. Existing prospect pins to a removed id will refuse to send until restored. */
  removeIdentityIds?: string[];
  icpOneLiner?: string;
  /** Founder background — résumé, prior companies, named roles. Founder-trust proof. */
  founderCredentials?: string;
  /** Products / projects you've shipped (free text, e.g. comma-separated). Peer-founder proof. */
  productPortfolio?: string;
  /** Notable partners / customers (free text, brand names). Brand-recognition proof. */
  partners?: string;
  /** One true concession ("two people, no enterprise logos yet") for the optional damaging-admission beat. */
  founderAdmission?: string;
  /** Product facts + canonical links replies may cite. Links absent from this brief are never sent. */
  productBrief?: string;
  /** When true, signature appends a literal "Sent from my iPhone" line. */
  mobileSignature?: boolean;
  llmProvider?: LlmProvider;
  llmModel?: string;
  telemetryEnabled?: boolean;
  walletMode?: WalletMode;
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
      | "TWITTERAPI_IO_KEY",
      string
    >
  >;
}

/**
 * One provisioned sending domain as seen by the browser — the wallet-owned
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

/** Result of POST /api/domains/{resume,pause} — the domain's new pool status. */
export interface DomainActionResult {
  domain: string;
  poolStatus: "active" | "paused";
}

/**
 * One Smartlead-connected mailbox as seen by the browser/CLI — sanitized
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
  /** This mailbox's own sends today. */
  sentToday: number;
  /**
   * Sends today across the whole cap-group this identity shares — i.e. every
   * mailbox on the same OneShot sending domain (reputation + the daily limit
   * are per-domain). Equals `sentToday` when the identity is the only mailbox
   * on its domain (and for Gmail, which is always per-account).
   */
  domainSentToday: number;
  /** The cap-group's effective ceiling today after the warm-up ramp (shared across the domain's mailboxes); null = uncapped. */
  capToday: number | null;
  /** True when synthesized from legacy single-provider config (not yet a persisted pool). */
  legacy: boolean;
}

export type QueueStatusView = "pending" | "approved" | "rejected" | "sent" | "expired";

export interface QueueRowView {
  id: number;
  playName: string;
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
}

/**
 * Manual "Add Prospect": paste a LinkedIn or X/Twitter profile URL (optionally
 * an email to use). The server researches the profile, has the LLM pick an
 * ICP-grounded angle + draft the intro, and lands it as a reviewable row in the
 * Queue under the `profile-intro` play.
 */
export interface AddProspectRequest {
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
export interface LastDraft {
  subject: string;
  body: string;
  flags: string[];
  sent: boolean;
  receiptIds: number[];
  dryRun: boolean;
  draftedAt: string;
  /** Enrichment SDK failed for this prospect — draft built from payload only. Non-blocking (send stays enabled). */
  enrichmentFailed?: boolean;
}

/**
 * Draft flags that HOLD a draft from auto-send but are deliberately overridable
 * by a founder on a manual "send this one" — they mean "needs a human glance,"
 * not "broken copy." Unlike lint flags (em-dash, rule-of-three, …) or dedup
 * outcomes (already-contacted), regenerating won't clear these and shouldn't:
 * the founder either sends as-is or rejects.
 *
 * Currently: `stale-event` — a luma-events event >14 days past, where the
 * guest-list signal is old enough to want confirmation before sending; and
 * `contacted-elsewhere` — another WORKSPACE (another product of yours) emailed
 * this person inside the 7-day hold window, so two motions don't stack in one
 * inbox. Sending as-is is the founder saying "I know, do it anyway."
 */
export const SOFT_REVIEW_FLAGS: readonly string[] = ["stale-event", "contacted-elsewhere"];

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
 * Plays the SSE `/api/run/:playName` endpoint can dispatch — i.e. the ones
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
];

/**
 * Parse a `?ids=1,2,3` queue-row pick (the "drain selected" path).
 *
 * Returns `undefined` only when the parameter is ABSENT. A present-but-unusable
 * value (`?ids=`, `?ids=abc`) returns `[]` — an explicit empty pick — because
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
 * by the /setup card and `config x-engine` — both sides must apply the same
 * rule: when the engine actually CHANGES, drop the `maxSpendPerRun` and
 * `knobs` overrides so the registry's per-engine defaults re-apply (carrying
 * twitterapi.io's $1 ceiling onto the X API buys ~100 user reads and stalls
 * the run). Explicit re-overrides stay possible via the /queue config editor.
 */
export function withXEngine(
  config: Record<string, unknown> | null | undefined,
  engine: XEngine,
): Record<string, unknown> {
  const out = { ...(config ?? {}) };
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

/** A single inbox email (reply to outreach), with prospect/play context when matched. */
export interface InboxReplyView {
  id: string;
  /** What this inbound actually is — only `human` counts as a reply anywhere. */
  kind: InboundReplyKind;
  /** Normalized sender address (lowercased, display-name stripped). */
  fromEmail: string;
  /** Raw From header as received (may include a display name). */
  fromRaw: string;
  subject: string;
  receivedAt: string;
  body: string;
  /** Sender identity whose mailbox received this email — the reply goes out from it. Null on legacy/unattributed rows. */
  sourceIdentityId: string | null;
  /** Provider of the receiving identity. Gmail replies thread properly; oneshot replies are best-effort fresh sends (paid, subject-threading only). */
  sourceProvider: "gmail" | "oneshot" | "smartlead" | null;
  /** Gmail thread id (gmail sources only) — passed back on send to thread the reply. */
  threadId: string | null;
  /** RFC 2822 Message-ID of the inbound email (gmail sources only) — In-Reply-To on the reply. */
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
  } | null;
}

/**
 * Stable key for an inbox thread, shared by the server (persistence) and the
 * web composer (send payload) so both sides agree. Gmail rows carry a
 * thread_id; OneShot rows fall back to the email id (best-effort — OneShot has
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
    }
  | {
      /** A manual reply the founder sent from /inbox (inbox_sent). */
      kind: "sent";
      at: string;
      subject: string | null;
      body: string;
    };

/** The full exchange with one prospect — ledger-backed, complete forever. */
export interface ConversationView {
  prospectId: number;
  name: string | null;
  company: string | null;
  email: string;
  playName: string | null;
  cadenceStatus: string | null;
  lastActivityAt: string;
  /** Saved (auto-saved) composer draft for the newest inbound's thread, if any. */
  draftBody: string | null;
  items: ConversationItem[];
}

export interface InboxResult {
  replies: InboxReplyView[];
  /** Threaded matched view: one entry per prospect with a recorded reply. */
  conversations?: ConversationView[];
  hasMore: boolean;
  /** Present when the inbox fetch failed; replies will be empty. */
  error?: string;
}

/** POST /api/inbox/draft-reply — generate an LLM reply draft for an inbound email. */
export interface InboxDraftReplyRequest {
  fromEmail: string;
  subject: string;
  body: string;
  /** Inbound email id + thread id, so the server can include this thread's prior sent replies. */
  id?: string;
  threadId?: string | null;
}

export interface InboxDraftReplyResult {
  body: string;
  /** Paid research spend this draft incurred (0 on cache hits / known prospects). */
  costUsd: number;
  /** True when the server ran paid research on the sender before drafting. */
  researched: boolean;
}

/** POST /api/inbox/draft — persist the in-progress draft for a thread (auto-save). */
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
}

/** POST /api/inbox/reply — send a (possibly edited) reply. */
export interface InboxSendReplyRequest {
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
  /** Absent when the capacity computation failed — pages skip the figure. */
  sendsToday?: SendsToday;
}

export interface DrainRequest {
  playName: string;
  limit: number;
  dryRun: boolean;
  /** For accelerator-batch: required cohort tag. */
  senderCohort?: string;
  freeForCohortOffer?: string;
}

export interface DrainResult {
  drained: number;
  sent: number;
  errors: Array<{ id: number; message: string }>;
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
  /** Sources that could not be read, with the reason — surfaced, not silent. */
  skipped: Array<{ url: string; reason: string }>;
  costUsd: number;
}

export interface RunTriggerResult {
  name: string;
  fired: boolean;
  /**
   * True when the run was kicked off fire-and-forget — work is still in
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
   * Manual /run entries omit this so the persist hook is skipped — the
   * /queue is the authoritative archive only for queue-originated runs.
   */
  dedupeKeys?: (string | null)[];
  /** For accelerator-batch: sender cohort + free offer text. */
  senderCohort?: string;
  freeForCohortOffer?: string;
}

/** Server-Sent Events frame contract for /api/run/$playName. */
export type RunPlayEvent =
  | {
      kind: "verify";
      total: number;
      verified: number;
      dropped: Array<{ email: string; reason: string }>;
    }
  | { kind: "stage"; stage: string }
  | { kind: "draft"; index: number; subject: string; body: string; flags: string[] }
  | { kind: "send"; index: number; receiptIds: number[] }
  | { kind: "error"; index: number; message: string }
  | { kind: "done"; total: number; sent: number }
  /**
   * Terminal frame for an aborted run — the client closed the SSE stream or
   * POST /api/run/:runId/cancel fired. Distinct from `error`: nothing failed,
   * the remaining targets simply never billed. `sent` counts what went out
   * before the abort point.
   */
  | { kind: "cancelled"; reason: string; total: number; sent: number }
  /** First frame the server emits — gives the UI the runId so it can resume on nav-back. */
  | { kind: "runStarted"; runId: number; startedAt: string };

/** Lifecycle status of a /run-page dispatch persisted in the `runs` table. */
export type RunStatus = "running" | "done" | "interrupted" | "cancelled";

/**
 * Snapshot of one /run-page dispatch — returned by GET /api/runs/:id so the UI
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
  /** Emails that were actually sent — used by /cadences?sinceRun to filter. */
  prospectEmails: string[];
  /** Why a `cancelled` run ended (client disconnect vs explicit cancel). Null otherwise. */
  cancelReason: string | null;
}

/**
 * Result of `POST /api/run/:runId/cancel`. Always 200 for a run that exists —
 * cancelling one that already finished is a no-op, and the caller tells the
 * cases apart by the fields rather than by a status code.
 *
 * `cancelled` — this request is the one that flipped the row to 'cancelled'.
 * `aborted`   — a live run in this process got the signal (false means the
 *               row was terminal already, or the run was orphaned by a process
 *               exit and only the ledger write applied).
 * `status`    — the row's status after the call.
 */
export interface CancelRunResponse {
  runId: number;
  status: RunStatus;
  cancelled: boolean;
  aborted: boolean;
  reason: string | null;
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
