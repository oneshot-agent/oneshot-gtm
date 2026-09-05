export interface ReceiptRecord {
  id: number;
  play_name: string;
  call_type: string;
  cost_usd: number | null;
  signed_receipt: string | null;
  oneshot_request_id: string | null;
  /** Which EmailIdentity sent this (email.send receipts only); null pre-rotation. */
  sender_identity: string | null;
  /** Human-readable call reason, mirrored from the call-time SDK `memo`. */
  memo: string | null;
  /** JSON of the call-time `decisionContext` blob. */
  decision_context: string | null;
  /**
   * RoCS outcome value, JSON `{type, amount?, label?}`, set once a reply/deal
   * lands (tagOutcomeValue). Mirrors what we PATCH to OneShot via tagReceiptValue.
   */
  value_tag: string | null;
  value_tagged_at: string | null;
  /** Cadence correlation key (mirrors decisionContext.goalId); groups a cadence's receipts. */
  goal_id: string | null;
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
  provider: "oneshot" | "gmail" | "smartlead";
  label?: string | null;
  /** OneShot only: wallet-owned From domain. */
  sendingDomain?: string | null;
  /** OneShot only: From localpart override (default: founder first name). */
  mailbox?: string | null;
  /**
   * Gmail/Smartlead: the account address. For Gmail it is informational (the
   * OAuth token decides the real From); for Smartlead it is the literal
   * `fromEmail` the send API pins, so it must match a connected account.
   */
  address?: string | null;
  /** Hard daily ceiling. Null = uncapped (only sensible for OneShot identities). */
  maxPerDay: number | null;
  /** Auto ramp from first send: cap(day) = start + floor(weeks)*increment, clamped to maxPerDay. Null = no ramp. */
  warmup: { startPerDay: number; incrementPerWeek: number } | null;
}

/** One persisted inbound reply (inbox_replies, v21) — column-shaped row. */
export interface InboxReplyRecord {
  /** Provider email id (Gmail message id / OneShot id) — the idempotency key. */
  id: string;
  /** Same key as inbox_drafts / inbox_sent (thread_id, else email id). */
  thread_key: string;
  prospect_id: number;
  play_name: string | null;
  from_email: string;
  subject: string | null;
  body: string;
  received_at: string;
  source_identity_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  /** Reply classification (reply-classify.ts). NULL = pre-classifier row, read as 'human'. */
  kind: string | null;
  created_at: string;
}

/** Provider-neutral inbound engagement event. V1 records LinkedIn replies only. */
export interface ChannelEventRecord {
  id: number;
  source: string;
  external_event_id: string;
  prospect_id: number;
  channel: "linkedin";
  event_type: "reply";
  occurred_at: string;
  /** Message text when the channel supplied one; null for older rows. */
  body: string | null;
  created_at: string;
}

export interface ProspectRecord {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  /** Polymorphic social-profile column: profile-intro stores a LinkedIn, X or
   *  GitHub URL here, so consumers must validate before treating it as LinkedIn. */
  linkedin_url: string | null;
  dossier_json: string | null;
  source: string | null;
  /** The profile URL the finder originally sourced this person from. Unlike
   *  `linkedin_url` this is never repurposed, so it stays a usable key for
   *  re-enrichment. */
  source_profile_url: string | null;
  /** Job title at contact time, from the person-level ICP gate. NULL on rows
   *  contacted before the gate existed (pre 2026-08). */
  title: string | null;
  /** Person-level ICP verdict: 'pass' | 'reject' | 'unclear'. NULL = never
   *  judged. 'unclear' means the gate looked and had nothing to judge on —
   *  distinct from NULL, and PROVISIONAL: a re-audit re-judges unclear rows
   *  (so role text arriving later is used) while leaving pass/reject alone.
   *  Only 'reject' suppresses sending (packages/plays/src/_cadence.ts). */
  icp_verdict: string | null;
  /** Classifier's one-line reason for the verdict. */
  icp_verdict_reason: string | null;
  created_at: string;
}

export interface SequenceEventRecord {
  id: number;
  prospect_id: number;
  play_name: string;
  step_index: number;
  channel: "email" | "sms" | "voice" | "linkedin" | "x";
  status: "queued" | "sent" | "delivered" | "replied" | "bounced" | "failed" | "unsubscribed";
  metadata_json: string | null;
  created_at: string;
}

/**
 * Severity of a delivery failure, derived from the DSN's RFC 3463 status code.
 *  - `hard`  — permanent, address-level (5.1.1 no such user). Suppresses the
 *              address: re-sending can only ever fail again and costs money.
 *  - `block` — permanent, POLICY-level (5.7.x, spam/reputation rejection). The
 *              reputation signal. Kept distinct from `hard` because it's about
 *              the message or the sending domain, not the recipient — the same
 *              address may well accept mail tomorrow, so it never suppresses.
 *  - `soft`  — transient (4.x.x mailbox full, greylisted). Recorded for context
 *              only; no cadence or suppression effect.
 */
export type BounceKind = "hard" | "block" | "soft";

export interface BounceRecord {
  /** Provider message id of the DSN itself — PK, so re-sweeping is idempotent. */
  message_id: string;
  /** Identity whose mailbox received the DSN (= the identity that sent). Null pre-rotation. */
  identity_id: string | null;
  /** Canonical Final-Recipient — the address that failed, not the DSN sender. */
  recipient: string;
  kind: BounceKind;
  /** RFC 3463 status, e.g. "5.1.1". Null when only prose was parseable. */
  status_code: string | null;
  /** Truncated Diagnostic-Code / remote SMTP response. */
  diagnostic: string | null;
  /** Matched prospect, or null when the address isn't one of ours. */
  prospect_id: number | null;
  /** When the DSN arrived (provider timestamp). */
  bounced_at: string;
  created_at: string;
}

/**
 * Where a message actually landed in the receiving mailbox. This is the
 * question DSN harvesting cannot answer: a message can be accepted (no bounce)
 * and still be filtered into spam or buried in a tab, which for cold outreach
 * is indistinguishable from never arriving.
 */
export type GmailPlacement =
  | "inbox"
  /** Delivered but tab-binned (Promotions/Social/Updates/Forums) — effectively invisible for cold outreach. */
  | "promotions"
  | "tab"
  | "spam"
  /** Accepted but not in the inbox or any tab — filtered straight to a label/archive. */
  | "archived"
  /** Never showed up within the deadline. Inconclusive: silently dropped, or just slow. */
  | "not_delivered";

/** SPF/DKIM/DMARC verdict as reported by the RECEIVING server, not by a DNS lookup. */
export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "unknown";

export interface CanaryResultRecord {
  id: number;
  from_identity: string;
  to_identity: string;
  placement: GmailPlacement;
  /** Raw Gmail labelIds, JSON — kept so a placement call can be re-litigated later. */
  labels_json: string | null;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  subject: string | null;
  /** Which play's real copy was replayed, or null when a generic sample was used. */
  source_play: string | null;
  /** True when both identities share a domain — internal routing skips most filtering. */
  same_domain: number;
  /** Send → observed, in ms. Null when never observed. */
  latency_ms: number | null;
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
  /**
   * Default order of the /queue pending review list. "ranked" interleaves
   * finders with score-within-finder + exploration slots (see find/_rank.ts);
   * "newest" is the classic found_at DESC. Defaults to "newest": the
   * 2026-09-01 heuristic-v2 measurement (luma AUC 0.59-0.63, gap +1) is under
   * the Phase 2 acceptance bar for ranked-by-default. Per-request override:
   * GET /api/queue?order=. Optional so pre-existing config literals and older
   * config files stay valid; readers treat absent as "newest".
   */
  queueReviewOrder?: "ranked" | "newest";
  /** Founder's résumé / credentials — the founder-trust social-proof beat. */
  founderCredentials: string | null;
  /** Products you've shipped — the peer-founder social-proof beat. */
  productPortfolio: string | null;
  /** Notable partners / customers — the brand-recognition social-proof beat. */
  partners: string | null;
  /**
   * One true concession about the founder/product ("two people, no enterprise
   * logos yet") — the prompt's optional damaging-admission beat. It is the ONLY
   * material the model may draw an admission from; null means the beat is
   * skipped, never improvised.
   */
  founderAdmission: string | null;
  /**
   * Product knowledge the reply drafter may cite: concrete facts, architecture,
   * pricing model, and canonical links (docs pages, repo). Free text, founder-
   * edited on /setup (with a derive-from-sources helper). The reply prompt is
   * only allowed to include links that appear verbatim here — this field is
   * what makes a substantive, link-bearing reply possible without inventing
   * artifacts.
   */
  productBrief: string | null;
  /**
   * When true, the signature directive appends a literal "Sent from my iPhone"
   * line below the domain. Proof-of-human artifact: reads as if the founder
   * forgot to disable the default. Default false.
   */
  mobileSignature: boolean;
  /**
   * IANA zone (e.g. "America/Los_Angeles") this install's dates are rendered in
   * when nothing more specific is known. It is the LAST resort in the event
   * date/time chain (explicit zone on the event → the event's city → this);
   * null means fall back to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
   * See `timezone.ts`.
   */
  timezone: string | null;
  /**
   * Slack incoming-webhook URL for operational notifications (reply received,
   * bounce recorded, daily send summary). Null/empty = feature off. Delivery
   * is best-effort: failures are logged via logEvent and never block or fail
   * the triggering operation.
   */
  slackWebhookUrl: string | null;
  /**
   * Anonymous per-install UUID. Generated by loadConfig() on first sight; never
   * exposed to the web layer or transmitted off-device today. Reserved for
   * opt-in distribution telemetry once that lands — having it now means
   * pre-launch installs aren't attribution-orphaned later.
   */
  clientId: string | null;
  /**
   * Install-wide daily USD spend ceiling (issue #481). Per-run caps
   * (`maxCostUsd`/`maxSpendPerRun`) bound one finder or drain call; this
   * bounds the SUM across every automated paid call — every finder trigger
   * plus every automatic drain — over the local calendar day. Null =
   * unlimited (the historical behavior). Checked before each automated call
   * via a reservation against `receipts.cost_usd` summed since local
   * midnight; manual `/queue` sends (approve/reject/mark-sent/send-draft)
   * never consult it. Set from `config spend-ceiling <amount>` or `/setup`.
   */
  dailySpendCeilingUsd: number | null;
}

export type QueueStatus = "pending" | "approved" | "rejected" | "sent" | "expired";

/** Per-component sub-scores of a `ProspectPriority`. Each is a clamped integer 0..100. */
export interface ProspectPriorityComponents {
  personFit: number;
  accountFit: number;
  intentStrength: number;
  timingFreshness: number;
  signalConfidence: number;
  contactability: number;
}

/**
 * Versioned, explainable priority artifact computed at enqueue time from the
 * evidence already in the payload (issue #410, Phase 1). Shadow-mode only: it
 * is persisted and displayed but never drives ordering, approval, drain, or
 * send behavior. Missing evidence scores neutral, not zero; rows enqueued by
 * legacy/manual producers carry null. Hard gates (ICP, role, dedupe,
 * deliverability) are never rescued by a score.
 */
export interface ProspectPriority {
  /**
   * Mirrored union of shared-types' `PriorityVersion` (core can't import it —
   * web depends on shared-types alone; the find version-sync test guards the
   * two lists against drift).
   */
  version: "heuristic-v1" | "heuristic-v2";
  /** Weighted total, clamped integer 0..100. */
  total: number;
  components: ProspectPriorityComponents;
  /** Concise evidence strings, fixed order, no model chain-of-thought. */
  reasons: string[];
  /** The play/finder name the adapter scored under. */
  finder: string;
  /** ISO timestamp of scoring (injected clock — deterministic in tests). */
  scoredAt: string;
}

/** A reviewed queue row, projected into an ICP classifier example. */
export interface IcpDecisionExample {
  candidate: unknown;
  decision: boolean;
  reason: string | null;
}

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
  /**
   * Serialized `ProspectPriority` (shadow-mode score, v25) or null on rows
   * from manual/legacy producers, auto-rejections, and pre-v25 rows.
   */
  priority_json: string | null;
  /**
   * Decision provenance (v26): the decision itself, durable against expiry
   * and re-open — `status` alone is lossy history. NULL on undecided and
   * pre-v26-unbackfillable rows. See core/labels.ts.
   */
  decision: "approve" | "reject" | "auto_reject" | null;
  decided_at: string | null;
  /** 'human' (per-row click) | 'human_bulk' (approve-all batch) | 'machine'. */
  decided_by: "human" | "human_bulk" | "machine" | null;
}

/**
 * One sent queue row joined to its outcome evidence (Phase 3 of #410).
 * Produced by `Ledger.listSentOutcomeRows`; labeled by find/_outcomes.ts.
 */
export interface SentOutcomeRawRow {
  id: number;
  play_name: string;
  dedupe_key: string;
  priority_json: string | null;
  sent_at: string;
  decision: QueueRow["decision"];
  decided_by: QueueRow["decided_by"];
  /** prospect_id, falling back to an email join; NULL = unjoinable. */
  joined_prospect_id: number | null;
  payload_email: string | null;
  /** Earliest human-classified email reply (COALESCE(kind,'human')). */
  first_email_reply_at: string | null;
  /** Earliest LinkedIn reply (channel_events, never machine-classified). */
  first_channel_reply_at: string | null;
  /** Max deal_outcomes rank: 4 won / 3 qualified / 2 meeting; NULL = none. */
  deal_rank: number | null;
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
