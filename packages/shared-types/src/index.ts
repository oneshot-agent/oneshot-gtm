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

export interface HomeMetrics {
  spendUsd7d: number;
  spendUsd30d: number;
  callsLast7d: number;
  sentLast7d: number;
  repliedLast7d: number;
  activeCadences: number;
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
      | "AGENT_PRIVATE_KEY",
      string
    >
  >;
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
  /** Set when the sender matches a known prospect; null for unmatched mail. */
  matched: {
    name: string | null;
    company: string | null;
    playName: string | null;
    cadenceStatus: string | null;
  } | null;
}

export interface InboxResult {
  replies: InboxReplyView[];
  hasMore: boolean;
  /** Present when the inbox fetch failed; replies will be empty. */
  error?: string;
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
  | { kind: "done"; total: number; sent: number };
