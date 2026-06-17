/**
 * Wire types shared between apps/cli, apps/server, and apps/web.
 * These are the API contracts for /api/* endpoints. Keep stable.
 */

export type CadenceStatus = "active" | "replied" | "breakup" | "completed" | "paused";

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
export type StepChannel = "email" | "sms" | "voice" | "linkedin";

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
  overdue: number;
}

export interface CadencesResult {
  cadences: CadenceView[];
  counts: CadenceCounts;
}

export interface ReceiptView {
  id: number;
  playName: string;
  callType: string;
  costUsd: number | null;
  oneshotRequestId: string | null;
  createdAt: string;
}

export interface ReceiptDetail extends ReceiptView {
  signedReceipt: unknown | null;
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

export interface HomeMetrics {
  spendUsd7d: number;
  spendUsd30d: number;
  callsLast7d: number;
  sentLast7d: number;
  repliedLast7d: number;
  activeCadences: number;
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

export interface DoctorCheck {
  name: string;
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
   * New OneShot sending identities to add to the pool (a wallet-owned domain +
   * a mailbox local-part). `sendingDomain` must be one returned by the
   * provisioned-domain pool. Omit `maxPerDay` to take the cold-start warm-up
   * ramp; pass `null` to add uncapped.
   */
  addIdentities?: Array<{
    provider: "oneshot";
    sendingDomain: string;
    mailbox?: string;
    label?: string;
    maxPerDay?: number | null;
  }>;
  /** Identities to drop from the rotation pool. Existing prospect pins to a removed id will refuse to send until restored. */
  removeIdentityIds?: string[];
  icpOneLiner?: string;
  /** Founder background — résumé, prior companies, named roles. Founder-trust proof. */
  founderCredentials?: string;
  /** Products / projects you've shipped (free text, e.g. comma-separated). Peer-founder proof. */
  productPortfolio?: string;
  /** Notable partners / customers (free text, brand names). Brand-recognition proof. */
  partners?: string;
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
      | "GMAIL_REFRESH_TOKEN",
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

/** One sender identity as shown on /setup: pool entry + today's usage. */
export interface SenderIdentityView {
  id: string;
  provider: "oneshot" | "gmail";
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
 * guest-list signal is old enough to want confirmation before sending.
 */
export const SOFT_REVIEW_FLAGS: readonly string[] = ["stale-event"];

/**
 * The subset of a draft's flags that genuinely block sending (everything except
 * the founder-overridable soft-review flags). Empty → the draft is sendable.
 * Shared by the server send gate and the queue UI's send button so the two
 * never disagree on whether a held draft can be force-sent.
 */
export function blockingFlags(flags: string[]): string[] {
  return flags.filter((f) => !SOFT_REVIEW_FLAGS.includes(f));
}

/** A single inbox email (reply to outreach), with prospect/play context when matched. */
export interface InboxReplyView {
  id: string;
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
  sourceProvider: "gmail" | "oneshot" | null;
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

export interface InboxResult {
  replies: InboxReplyView[];
  hasMore: boolean;
  /** Present when the inbox fetch failed; replies will be empty. */
  error?: string;
}

/** POST /api/inbox/draft-reply — generate an LLM reply draft for an inbound email. */
export interface InboxDraftReplyRequest {
  fromEmail: string;
  subject: string;
  body: string;
}

export interface InboxDraftReplyResult {
  body: string;
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
  /** First frame the server emits — gives the UI the runId so it can resume on nav-back. */
  | { kind: "runStarted"; runId: number; startedAt: string };

/** Lifecycle status of a /run-page dispatch persisted in the `runs` table. */
export type RunStatus = "running" | "done" | "interrupted";

/**
 * Snapshot of one /run-page dispatch — returned by GET /api/runs/:id so the UI
 * can rebuild the per-target progress view after navigate-away-and-back, AND
 * decide whether to keep polling (status === 'running') or stop (done /
 * interrupted). `events` is the accumulated SSE stream (same shape callers
 * see live), so the client renderer can be source-shared.
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
  /** All SSE events accumulated so far (or all of them, when status !== 'running'). */
  events: RunPlayEvent[];
  /** Emails that were actually sent — used by /cadences?sinceRun to filter. */
  prospectEmails: string[];
}
