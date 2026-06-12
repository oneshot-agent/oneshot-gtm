export interface ReceiptRecord {
  id: number;
  play_name: string;
  call_type: string;
  cost_usd: number | null;
  signed_receipt: string | null;
  oneshot_request_id: string | null;
  /** Which EmailIdentity sent this (email.send receipts only); null pre-rotation. */
  sender_identity: string | null;
  created_at: string;
}

/**
 * One sending identity in the rotation pool. Either an OneShot wallet-owned
 * domain or a Gmail/Workspace account (refresh token lives in the chmod-600
 * gmail-tokens.json store, keyed by `id` — never in this config).
 */
export interface EmailIdentity {
  /** Stable key, e.g. "legacy-oneshot", "gmail:jn@freebutter.ai". Referenced by sender_assignments rows — never rename a live id. */
  id: string;
  provider: "oneshot" | "gmail";
  label?: string | null;
  /** OneShot only: wallet-owned From domain. */
  sendingDomain?: string | null;
  /** OneShot only: From localpart override (default: founder first name). */
  mailbox?: string | null;
  /** Gmail only: the account address (informational; the OAuth token decides the real From). */
  address?: string | null;
  /** Hard daily ceiling. Null = uncapped (only sensible for OneShot identities). */
  maxPerDay: number | null;
  /** Auto ramp from first send: cap(day) = start + floor(weeks)*increment, clamped to maxPerDay. Null = no ramp. */
  warmup: { startPerDay: number; incrementPerWeek: number } | null;
}

export interface ProspectRecord {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  linkedin_url: string | null;
  dossier_json: string | null;
  source: string | null;
  created_at: string;
}

export interface SequenceEventRecord {
  id: number;
  prospect_id: number;
  play_name: string;
  step_index: number;
  channel: "email" | "sms" | "voice" | "linkedin";
  status: "queued" | "sent" | "delivered" | "replied" | "bounced" | "failed";
  metadata_json: string | null;
  created_at: string;
}

export interface InterviewRecord {
  id: number;
  person: string;
  transcript_path: string | null;
  jtbd: string | null;
  pain_quotes_json: string | null;
  created_at: string;
}

export interface OneShotConfig {
  walletMode: "cdp" | "private-key";
  llmProvider: "openrouter" | "openai" | "anthropic";
  llmModel: string;
  telemetryEnabled: boolean;
  founderName: string | null;
  founderEmail: string | null;
  productOneLiner: string | null;
  /**
   * Brand/product domain appended to every generated email signature beneath
   * the founder's name (e.g. "yourcompany.com"). Bare domain, no scheme.
   * Null = no domain line (founderEmail can't stand in — it's often a personal
   * inbox).
   */
  productDomain: string | null;
  /**
   * Domain the founder's agent wallet OWNS, used as the email From domain
   * (sends as `<founder-first-name>@<sendingDomain>`). Distinct from
   * productDomain (signature display): the send domain must be wallet-owned or
   * the SDK 403s with `domain_not_owned`. Null = fall back to the SDK default
   * (which only works for whoever owns that demo domain).
   */
  sendingDomain: string | null;
  /**
   * Which transport sends email. "oneshot" (default) = OneShot SDK from a
   * wallet-owned sendingDomain; "gmail" = the founder's own Gmail / Google
   * Workspace account via OAuth (GMAIL_* secrets, `gmail auth` CLI). In gmail
   * mode the From address is the authenticated account (sendingDomain is
   * ignored) and replies are read from Gmail instead of the OneShot inbox.
   */
  emailProvider: "oneshot" | "gmail";
  /**
   * Sender rotation pool. Null = legacy single-identity mode: behave exactly
   * per `emailProvider` + `sendingDomain` (a synthetic identity is derived at
   * runtime). Once set, `emailProvider` is ignored — routing is per-prospect
   * sticky: the identity that sent the first touch sends every later email
   * to that prospect.
   */
  emailIdentities: EmailIdentity[] | null;
  /** Free-text ICP statement; the find layer's LLM filter uses it as a yes/no classifier. */
  icpOneLiner: string | null;
  /**
   * Per-play cadence timing overrides, keyed by play name. Each value is an
   * array of RELATIVE day offsets (one per follow-up step, in order) that
   * replaces the code-default offsets when its length matches the play's step
   * count. Null/absent = code defaults. Structure (which prompts fire,
   * breakup position) is NOT overridable — timing only.
   */
  cadenceOverrides: Record<string, number[]> | null;
  /** Founder's résumé / credentials — the founder-trust social-proof beat. */
  founderCredentials: string | null;
  /** Products you've shipped — the peer-founder social-proof beat. */
  productPortfolio: string | null;
  /** Notable partners / customers — the brand-recognition social-proof beat. */
  partners: string | null;
  /**
   * When true, the signature directive appends a literal "Sent from my iPhone"
   * line below the domain. Proof-of-human artifact: reads as if the founder
   * forgot to disable the default. Default false.
   */
  mobileSignature: boolean;
  /**
   * Anonymous per-install UUID. Generated by loadConfig() on first sight; never
   * exposed to the web layer or transmitted off-device today. Reserved for
   * opt-in distribution telemetry once that lands — having it now means
   * pre-launch installs aren't attribution-orphaned later.
   */
  clientId: string | null;
}

export type QueueStatus = "pending" | "approved" | "rejected" | "sent" | "expired";

export interface QueueRow {
  id: number;
  play_name: string;
  payload_json: string;
  dedupe_key: string;
  source: string;
  status: QueueStatus;
  found_at: string;
  reviewed_at: string | null;
  sent_at: string | null;
  notes: string | null;
  prospect_id: number | null;
  /**
   * Most-recent draft generated by the play for this row, persisted by the
   * SSE /api/run endpoint after dispatch. JSON envelope:
   * `{subject, body, flags, sent, receiptIds, dryRun, draftedAt}`. Null on
   * rows that have never been drafted (or pre-v6 rows).
   */
  last_draft_json: string | null;
  /** ISO timestamp of `last_draft_json`. Null when no draft persisted. */
  last_drafted_at: string | null;
  /**
   * ISO timestamp when a Send-draft is in flight. Survives server restart so
   * the `/queue` UI's spinner doesn't get stranded by a `bun --watch` reload
   * mid-SDK-call. Claimed atomically by `claimQueueSendingMarker` before the
   * send fires; cleared on success via `setQueueStatus('sent', …)`; cleared
   * on failure or stale by the cold-boot `sweepStaleQueueSends` sweep.
   */
  send_started_at: string | null;
}

export interface TriggerRow {
  name: string;
  last_polled_at: string | null;
  last_run_summary: string | null;
  enabled: number;
  config_json: string | null;
  /**
   * ISO timestamp set by `fireTriggerNow` before backgrounding the work and
   * cleared by `updateTriggerLastPoll` on completion. Survives server
   * restart so a watch-restart-killed run can be detected and swept by the
   * boot-time `sweepStaleRunningTriggers` call.
   */
  running_started_at: string | null;
}

