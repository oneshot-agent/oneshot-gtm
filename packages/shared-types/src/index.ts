/**
 * Wire types shared between apps/cli, apps/server, and apps/web.
 * These are the API contracts for /api/* endpoints. Keep stable.
 */

export type CadenceStatus = "active" | "replied" | "breakup" | "completed";
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
  icpOneLiner?: string;
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
  /** For accelerator-batch: sender cohort + free offer text. */
  senderCohort?: string;
  freeForCohortOffer?: string;
}

/** Server-Sent Events frame contract for /api/run/$playName. */
export type RunPlayEvent =
  | { kind: "draft"; index: number; subject: string; body: string; flags: string[] }
  | { kind: "send"; index: number; receiptIds: number[] }
  | { kind: "error"; index: number; message: string }
  | { kind: "done"; total: number; sent: number };
