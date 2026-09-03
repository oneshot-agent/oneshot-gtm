import {
  OneShot,
  type BrowserResult,
  type DeepResearchPersonResult,
  type DomainPoolEntry,
  type DomainPoolStatusResult,
  type EmailResult,
  type EnrichCompanyResult,
  type EnrichProfileResult,
  type FindEmailResult,
  type InboxEmail,
  type InboxListResult,
  type ResearchResult,
  type SmsSendResult,
  type VerifyEmailResult,
  type VoiceCallResult,
  type WebReadResult,
  type WebSearchResult,
} from "@oneshot-agent/sdk";
import { createHash } from "node:crypto";
import { getLedger } from "./ledger.ts";
import { loadConfig, oneshotEnvReady } from "./config.ts";
import { demoFixture, demoMode } from "./demo.ts";
import { claimContactTouch, describeTouch, recordContactTouch } from "./shared-db.ts";
import { htmlToText } from "./html-text.ts";
import { logEvent } from "./events.ts";
import {
  type GmailBounce,
  getGmailProfile,
  listGmailBounces,
  listGmailReplies,
  sendGmailMessage,
} from "./gmail.ts";
import { gmailAccountFor, resolveIdentities } from "./identities.ts";
import { sendViaSmartlead, smartleadApiKey } from "./smartlead.ts";
import { parallelMap, withDeadline } from "./parallel.ts";
import {
  isTransientToolError,
  RecentlyContactedError,
  resolveSenderIdentity,
  SuppressedRecipientError,
} from "./send-routing.ts";
import type { EmailIdentity } from "./types.ts";

/** Re-exported so callers don't reach into the SDK for the domain-pool shape. */
export type { DomainPoolEntry, DomainPoolStatusResult } from "@oneshot-agent/sdk";

/** Re-exported so callers don't reach into the SDK for the company-enrich result shape. */
export type { CompanyResult, EnrichCompanyResult } from "@oneshot-agent/sdk";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  /** OneShot provider only — ignored when config.emailProvider is "gmail" (Gmail always sends from the authenticated account). */
  fromDomain?: string;
  /**
   * Send even if ANOTHER workspace emailed this recipient inside the hold
   * window. Only the manual queue send sets this — the founder has seen the
   * `contacted-elsewhere` flag and is choosing to send anyway.
   */
  allowContactedElsewhere?: boolean;
}

export interface ResearchInput {
  topic: string;
  depth?: "quick" | "deep";
}

export interface EnrichInput {
  email?: string;
  linkedinUrl?: string;
  name?: string;
  companyDomain?: string;
}

export interface CallContext {
  playName: string;
  /**
   * Short human-readable reason for this tool call. Lands on the signed
   * receipt's `memo` field via SDK 0.16.2+. SDK truncates at 1000 chars and
   * warns (not errors) when omitted on a paid call. Defaults to
   * `"{playName} {callType}"` when unset.
   */
  memo?: string;
  /**
   * Machine-readable decision rationale. Merged with `{playName, callType}`
   * defaults; caller-supplied keys win. Lands on the receipt's
   * `decisionContext` for supervisor-agent / external auditor consumption.
   */
  decisionContext?: Record<string, unknown>;
}

/**
 * Build the `{memo, decisionContext}` audit blob the SDK 0.16.2+ accepts as
 * top-level fields on every paid tool's option bag. Sensible defaults (playName
 * + callType) so even call sites that don't enrich still emit a usable audit
 * trail; callers that DO enrich override / extend via `ctx.decisionContext`.
 */
export function buildAuditOpts(
  ctx: CallContext,
  callType: string,
): { memo: string; decisionContext: Record<string, unknown> } {
  return {
    memo: ctx.memo ?? `${ctx.playName} ${callType}`,
    decisionContext: { playName: ctx.playName, callType, ...ctx.decisionContext },
  };
}

/**
 * Record a receipt for a billable call, persisting the SAME memo/decisionContext
 * we send to OneShot (buildAuditOpts) so the local row matches the platform
 * receipt. Every wrapper below funnels through this instead of calling
 * `getLedger().recordReceipt` directly.
 */
function recordCallReceipt(args: {
  ctx: CallContext;
  callType: string;
  signedReceipt?: unknown;
  costUsd?: number;
  oneshotRequestId?: string;
  senderIdentity?: string;
}): number {
  const audit = buildAuditOpts(args.ctx, args.callType);
  return getLedger().recordReceipt({
    playName: args.ctx.playName,
    callType: args.callType,
    signedReceipt: args.signedReceipt,
    costUsd: args.costUsd,
    oneshotRequestId: args.oneshotRequestId,
    senderIdentity: args.senderIdentity,
    memo: audit.memo,
    decisionContext: audit.decisionContext,
  });
}

/**
 * Stable correlation key for a (prospect, play) cadence. Set as
 * `decisionContext.goalId` on every send so OneShot groups the whole sequence's
 * spend, and tagged once on outcome via `tagReceiptValue({ goalId })`. Hashed so
 * no raw email leaks into the id; deterministic so the same cadence always maps
 * to the same goal.
 */
export function cadenceGoalId(playName: string, email: string): string {
  const canon = email.trim().toLowerCase();
  return `goal_${createHash("sha256").update(`${playName}:${canon}`).digest("hex").slice(0, 24)}`;
}

let agentSingleton: OneShot | null = null;

async function initAgent(): Promise<OneShot> {
  if (!oneshotEnvReady()) {
    throw new Error(
      "Agent wallet credentials missing. Set CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET, or AGENT_PRIVATE_KEY. Run `oneshot-gtm doctor` for details.",
    );
  }
  if (process.env["AGENT_PRIVATE_KEY"]) {
    return new OneShot({ privateKey: process.env["AGENT_PRIVATE_KEY"] });
  }
  return await OneShot.create({ cdp: true });
}

async function getAgent(): Promise<OneShot> {
  if (!agentSingleton) agentSingleton = await initAgent();
  return agentSingleton;
}

/**
 * The wallet's provisioned sending-domain pool — validates a `sendingDomain`
 * is wallet-owned before a live send 403s. Transient outages return `[]`:
 * callers must treat an empty list as "unknown", not "no domains owned".
 * Genuine auth failures DO propagate (a real config error).
 */
export async function listSendingDomains(): Promise<DomainPoolEntry[]> {
  // Demo mode: read-only fixture, before any agent construction (see demo.ts).
  if (demoMode()) {
    const fixture = demoFixture<DomainPoolEntry[]>("domains.json");
    if (fixture) return fixture;
  }
  try {
    const agent = await getAgent();
    const result = await agent.listDomains();
    return result.domains ?? [];
  } catch (err) {
    if (isTransientToolError(err)) {
      logEvent(
        "domains.list_transient_failure",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      return [];
    }
    throw err;
  }
}

/**
 * Resume a paused sending domain in the wallet's pool (SDK `resumeDomain`).
 * Unlike `listSendingDomains`, errors PROPAGATE — this is an explicit operator
 * action, so a transient/auth failure must be surfaced (and retried), never
 * swallowed into a false "done". Returns the domain's new pool status.
 */
export async function resumeSendingDomain(domain: string): Promise<DomainPoolStatusResult> {
  const agent = await getAgent();
  const result = await agent.resumeDomain(domain.trim().toLowerCase());
  logEvent("domains.resume", { domain: domain.trim().toLowerCase(), status: result.pool_status });
  return result;
}

/** Pause a sending domain in the wallet's pool (SDK `pauseDomain`). Errors propagate (see resumeSendingDomain). */
export async function pauseSendingDomain(domain: string): Promise<DomainPoolStatusResult> {
  const agent = await getAgent();
  const result = await agent.pauseDomain(domain.trim().toLowerCase());
  logEvent("domains.pause", { domain: domain.trim().toLowerCase(), status: result.pool_status });
  return result;
}

/**
 * Derive the From localpart from the founder's name (first token, lowercased,
 * non-alphanumerics stripped) so sends read e.g. `jerry@yourdomain`. Falls back
 * to `agent` when the name yields nothing usable. ("Jane Doe" → "jane".)
 */
export function fromLocalpart(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean.length > 0 ? clean : "agent";
}

/**
 * Stable Idempotency-Key for a OneShot email send (24h replay window),
 * derived from content: a retry of the SAME logical email returns the
 * original job instead of charging + sending twice; a different body/subject
 * hashes to its own key (the server 422s same-key-different-body).
 */
function emailIdempotencyKey(parts: Array<string>): string {
  // NUL separator: it can't appear in an email address, identity id, subject,
  // or body, so distinct field splits can't realign to the same joined string
  // (e.g. ["a","b c"] vs ["a b","c"] both → "a b c" under a space separator).
  return createHash("sha256")
    .update(parts.join(String.fromCharCode(0)))
    .digest("hex")
    .slice(0, 40);
}

/**
 * OneShot renders the email `body` as HTML, so plain-text newlines collapse
 * into one run-on paragraph. Escape HTML metacharacters and turn newlines into
 * <br> so paragraphs + the signature lines render the way the draft intended.
 */
export function toHtmlBody(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br>\n");
}

/**
 * Gmail-path send. Same return contract as the OneShot path: callers consume
 * `receiptId` plus `result.cost` / `result.request_id`. Receipts are recorded
 * with cost 0 (Gmail sends are free) and the Gmail message id as request id,
 * so /receipts and spend rollups stay truthful.
 */
async function sendEmailViaGmail(input: SendEmailInput, ctx: CallContext, identity: EmailIdentity) {
  const cfg = loadConfig();
  const account = gmailAccountFor(identity);
  // Hard stop, never fall through to the legacy env token: that token may
  // belong to a DIFFERENT account, and sending through it would switch the
  // thread's From address mid-conversation.
  if (!account) {
    throw new Error(
      `no Gmail refresh token stored for sender identity '${identity.id}' — re-authorize it (bun run cli -- gmail auth)`,
    );
  }
  const { emailAddress } = await getGmailProfile(account);
  const sent = await sendGmailMessage(
    {
      to: input.to,
      fromEmail: emailAddress,
      fromName: cfg.founderName,
      subject: input.subject,
      htmlBody: toHtmlBody(input.body),
    },
    account,
  );
  const result: EmailResult = {
    status: "sent",
    request_id: sent.id,
    cost: 0,
    email: { id: sent.id, provider_message_id: sent.id, status: "sent" },
  };
  const receiptId = recordCallReceipt({
    ctx,
    callType: "email.send",
    signedReceipt: {
      provider: "gmail",
      message_id: sent.id,
      thread_id: sent.threadId,
      from: emailAddress,
      to: input.to,
      subject: input.subject,
      memo: ctx.memo ?? `${ctx.playName} email.send`,
    },
    costUsd: 0,
    oneshotRequestId: sent.id,
    senderIdentity: identity.id,
  });
  return { result, receiptId };
}

/**
 * Smartlead-path send. Same contract as Gmail: cost 0, Smartlead's message id
 * as request id. No idempotency mechanism — a timeout-then-retry can
 * double-send; OneShot is the only transport with a true idempotency key.
 */
async function sendEmailViaSmartlead(
  input: SendEmailInput,
  ctx: CallContext,
  identity: EmailIdentity,
) {
  const cfg = loadConfig();
  const fromEmail = identity.address?.trim().toLowerCase();
  if (!fromEmail) {
    throw new Error(
      `no address on Smartlead sender identity '${identity.id}' — re-add it (bun run cli -- smartlead connect)`,
    );
  }
  if (!smartleadApiKey()) {
    throw new Error("SMARTLEAD_API_KEY not set — store it with: bun run cli -- smartlead connect");
  }
  const sent = await sendViaSmartlead({
    to: input.to,
    subject: input.subject,
    htmlBody: toHtmlBody(input.body),
    fromEmail,
    fromName: cfg.founderName,
  });
  const result: EmailResult = {
    status: "sent",
    request_id: sent.messageId,
    cost: 0,
    email: { id: sent.messageId, provider_message_id: sent.messageId, status: "sent" },
  };
  const receiptId = recordCallReceipt({
    ctx,
    callType: "email.send",
    signedReceipt: {
      provider: "smartlead",
      message_id: sent.messageId,
      from: fromEmail,
      to: input.to,
      subject: input.subject,
      memo: ctx.memo ?? `${ctx.playName} email.send`,
    },
    costUsd: 0,
    oneshotRequestId: sent.messageId,
    senderIdentity: identity.id,
  });
  return { result, receiptId };
}

async function dispatchEmail(input: SendEmailInput, ctx: CallContext) {
  // Suppression backstop, ahead of everything else: a previously hard-bounced
  // address can only fail again, and the send is billed before dispatch. Every
  // caller funnels through here (plays, cadence, queue), so this is the one
  // place that guarantees it. `replyEmail` is deliberately NOT gated — a manual
  // inbox reply goes to someone who just emailed us, so they demonstrably exist.
  const suppression = getLedger().suppressionFor(input.to);
  if (suppression) {
    throw new SuppressedRecipientError(
      `${input.to} hard-bounced${suppression.status_code ? ` (${suppression.status_code})` : ""} on ${suppression.bounced_at.slice(0, 10)} — not sending`,
    );
  }
  // Same backstop for reply-stream verdicts: an unsubscribe or a dead-mailbox
  // autoresponder is as final as a hard bounce, and stopping one cadence isn't
  // enough — a later play could re-enroll the prospect and land here again.
  const contactStop = getLedger().contactSuppressionFor(input.to);
  if (contactStop) {
    const why =
      contactStop.kind === "unsubscribe" ? "asked not to be contacted" : "mailbox reported dead";
    throw new SuppressedRecipientError(
      `${input.to} ${why} (${contactStop.kind} reply on ${contactStop.received_at.slice(0, 10)}) — not sending`,
    );
  }
  if (ctx.playName === "breakup-revive") {
    const manualHold = getLedger().breakupReviveHoldFor(input.to);
    if (manualHold) {
      throw new SuppressedRecipientError(
        `${input.to} has a ${manualHold.reason} manual stop from ${manualHold.stopped_at.slice(0, 10)} — not reviving`,
      );
    }
  }
  // Sender rotation: resolve the sticky per-prospect identity BEFORE any
  // network call. Throws SendDeferredError when every identity is at its
  // daily cap — callers leave the work queued for tomorrow.
  const identity = resolveSenderIdentity(input.to);
  if (identity.provider === "gmail") {
    return sendEmailViaGmail(input, ctx, identity);
  }
  if (identity.provider === "smartlead") {
    return sendEmailViaSmartlead(input, ctx, identity);
  }
  // Explicit guard: a provider this branch doesn't know must NEVER fall
  // through to the paid OneShot SDK path below.
  if (identity.provider !== "oneshot") {
    throw new Error(`unknown email provider '${identity.provider}' for identity '${identity.id}'`);
  }
  const agent = await getAgent();
  const cfg = loadConfig();
  // Pinning from_domain (+ from_mailbox below) opts this send OUT of the
  // platform's domain rotation: the named domain auto-provisions if unknown and
  // sends as-is (the worker only requires status='verified'; there's no
  // domain_not_owned 403). The trade-off is that pinned sends BYPASS the
  // server's warm-up gating — the per-identity client cap is the only throttle.
  // An unset domain falls back to the SDK's shared demo domain.
  const fromDomain = input.fromDomain ?? identity.sendingDomain ?? cfg.sendingDomain ?? null;

  const opts: Parameters<OneShot["email"]>[0] = {
    to: input.to,
    subject: input.subject,
    body: toHtmlBody(input.body),
    // Dedupes a retry after the platform hangs-but-sends (the 2026-06 incident)
    // or a double-fire from the queue/cadence layer. Keyed on content so two
    // distinct emails to the same prospect don't collide.
    idempotencyKey: emailIdempotencyKey([identity.id, input.to, input.subject, input.body]),
    ...buildAuditOpts(ctx, "email.send"),
  };
  if (fromDomain) {
    // Send from <mailbox-or-first-name>@<domain> with the founder's name as the
    // display name. from_mailbox (localpart) + from_name (display name) are native fields in
    // SDK ≥0.16.2 — from_name ships as a separate field, so the bare
    // from_address still passes the server's strict email validation.
    opts.from_domain = fromDomain;
    opts.from_mailbox = identity.mailbox?.trim() || fromLocalpart(cfg.founderName);
    const name = (cfg.founderName ?? "").trim();
    if (name) opts.from_name = name;
  }
  const result = await agent.email(opts);

  const receiptId = recordCallReceipt({
    ctx,
    callType: "email.send",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
    senderIdentity: identity.id,
  });
  return { result, receiptId };
}

/**
 * Every outbound email funnels through here. Order matters: 1. hard-bounce
 * suppression (permanent, never overridable); 2. the ATOMIC cross-workspace
 * claim, before any routing or network; 3. dispatch, then confirm (success)
 * or release (failure) — a failed send never counts as a touch. `replyEmail`
 * is deliberately not gated; it only records its touch.
 */
export async function sendEmail(input: SendEmailInput, ctx: CallContext) {
  const claim = claimContactTouch({
    email: input.to,
    playName: ctx.playName,
    override: input.allowContactedElsewhere === true,
  });
  if (claim.held) {
    throw new RecentlyContactedError(`${input.to} was ${describeTouch(claim.held)} — held`);
  }
  try {
    const out = await dispatchEmail(input, ctx);
    claim.finish(true);
    return out;
  } catch (err) {
    claim.finish(false);
    throw err;
  }
}

export interface ReplyEmailInput {
  /** Sender identity that RECEIVED the inbound email; the reply goes out from it. */
  identityId: string;
  to: string;
  /** Inbound subject — normalized to "Re: …" here (idempotent). */
  subject: string;
  body: string;
  /** Gmail only: thread to attach the reply to (sender-side threading). */
  threadId?: string;
  /** Gmail only: RFC 2822 Message-ID of the inbound email (In-Reply-To/References). */
  inReplyTo?: string;
  /**
   * OneShot only: id of the inbound OneShot inbox email (from inboxList). The
   * platform resolves In-Reply-To/References/thread_id and can derive
   * to/subject from it (SDK 0.19+).
   */
  replyToEmailId?: string;
}

/** "Re: " prefix, idempotent and case-insensitive ("RE: x" passes through). */
export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Reply to an inbound email from the identity whose mailbox received it —
 * deliberately NOT sender-rotated: a reply must keep the thread's From
 * address and must not be deferred by warmup caps (callType "email.reply"
 * stays out of per-identity cap counting). Both transports thread for real
 * (Gmail: threadId + In-Reply-To/References; OneShot: reply_to_email_id),
 * and the OneShot send carries an idempotency key.
 */
export async function replyEmail(input: ReplyEmailInput, ctx: CallContext) {
  const cfg = loadConfig();
  const identity = resolveIdentities(cfg).find((i) => i.id === input.identityId);
  if (!identity) {
    throw new Error(
      `unknown sender identity '${input.identityId}' — it may have been removed from the pool`,
    );
  }
  const subject = replySubject(input.subject);

  if (identity.provider === "gmail") {
    const account = gmailAccountFor(identity);
    if (!account) {
      throw new Error(
        `no Gmail refresh token stored for sender identity '${identity.id}' — re-authorize it (bun run cli -- gmail auth)`,
      );
    }
    const { emailAddress } = await getGmailProfile(account);
    const sent = await sendGmailMessage(
      {
        to: input.to,
        fromEmail: emailAddress,
        fromName: cfg.founderName,
        subject,
        htmlBody: toHtmlBody(input.body),
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: [input.inReplyTo] } : {}),
      },
      account,
      input.threadId,
    );
    const result: EmailResult = {
      status: "sent",
      request_id: sent.id,
      cost: 0,
      email: { id: sent.id, provider_message_id: sent.id, status: "sent" },
    };
    const receiptId = recordCallReceipt({
      ctx,
      callType: "email.reply",
      signedReceipt: {
        provider: "gmail",
        message_id: sent.id,
        thread_id: sent.threadId,
        from: emailAddress,
        to: input.to,
        subject,
        memo: ctx.memo ?? `${ctx.playName} email.reply`,
      },
      costUsd: 0,
      oneshotRequestId: sent.id,
      senderIdentity: identity.id,
    });
    recordContactTouch(input.to, ctx.playName);
    return { result, receiptId };
  }

  // Send-only v1: Smartlead identities produce no inbox rows, so no UI path
  // reaches here — this guard exists so a future inbox source can't silently
  // route a "reply" through the paid OneShot wallet from the wrong domain.
  if (identity.provider === "smartlead") {
    throw new Error(
      `replies from Smartlead identity '${identity.id}' aren't supported yet — reply in Smartlead's own inbox`,
    );
  }
  if (identity.provider !== "oneshot") {
    throw new Error(`unknown email provider '${identity.provider}' for identity '${identity.id}'`);
  }

  const agent = await getAgent();
  const fromDomain = identity.sendingDomain ?? cfg.sendingDomain ?? null;
  const opts: Parameters<OneShot["email"]>[0] = {
    to: input.to,
    subject,
    body: toHtmlBody(input.body),
    idempotencyKey: emailIdempotencyKey([
      identity.id,
      input.to,
      input.body,
      input.replyToEmailId ?? "",
    ]),
    ...buildAuditOpts(ctx, "email.reply"),
  };
  // Thread server-side when we know the inbound email id. We still pass
  // to/subject (the SDK forwards them); a missing id degrades to a fresh
  // "Re:" send, the pre-0.19 behavior.
  if (input.replyToEmailId) opts.reply_to_email_id = input.replyToEmailId;
  if (fromDomain) {
    opts.from_domain = fromDomain;
    opts.from_mailbox = identity.mailbox?.trim() || fromLocalpart(cfg.founderName);
    const name = (cfg.founderName ?? "").trim();
    if (name) opts.from_name = name;
  }
  const result = await agent.email(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "email.reply",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
    senderIdentity: identity.id,
  });
  recordContactTouch(input.to, ctx.playName);
  return { result, receiptId };
}

export async function deepResearch(input: ResearchInput, ctx: CallContext) {
  const agent = await getAgent();
  const result: ResearchResult = await agent.research({
    topic: input.topic,
    depth: input.depth ?? "quick",
    ...buildAuditOpts(ctx, "research.deep"),
  });
  const receiptId = recordCallReceipt({
    ctx,
    callType: "research.deep",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
  });
  return { result, receiptId };
}

export async function enrichProfile(input: EnrichInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["enrichProfile"]>[0] = {
    ...buildAuditOpts(ctx, "enrich.profile"),
  };
  if (input.email) opts.email = input.email;
  if (input.linkedinUrl) opts.linkedin_url = input.linkedinUrl;
  if (input.name) opts.name = input.name;
  if (input.companyDomain) opts.company_domain = input.companyDomain;

  const result: EnrichProfileResult = await agent.enrichProfile(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "enrich.profile",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
  });
  return { result, receiptId };
}

export interface DeepResearchPersonInput {
  /** A known email address — feeds dossier lookup. */
  email?: string;
  /** Any social URL (LinkedIn, Twitter, GitHub) the engine can chase. */
  socialMediaUrl?: string;
  /** Best-guess full name. */
  name?: string;
  /** Best-guess company name (free text — can be a domain or a brand). */
  company?: string;
}

/**
 * Multi-source person dossier: emails (work + personal + alts), phones,
 * org history, social profiles. Higher cost (~$0.05) and 2–5 min async vs.
 * findEmail's seconds-and-half-a-cent — use when you don't have a
 * `companyDomain` to feed findEmail (e.g. GitHub repo owners with no
 * resolvable company), not as a default first-pass.
 */
export async function deepResearchPerson(input: DeepResearchPersonInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["deepResearchPerson"]>[0] = {
    ...buildAuditOpts(ctx, "research.person"),
  };
  if (input.email) opts.email = input.email;
  if (input.socialMediaUrl) opts.social_media_url = input.socialMediaUrl;
  if (input.name) opts.name = input.name;
  if (input.company) opts.company = input.company;

  const result: DeepResearchPersonResult = await agent.deepResearchPerson(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "research.person",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
  });
  return { result, receiptId };
}

export interface FindEmailInput {
  /** Pass either fullName, OR firstName + lastName. companyDomain is required. */
  fullName?: string;
  firstName?: string;
  lastName?: string;
  companyDomain: string;
}

export async function findEmail(input: FindEmailInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["findEmail"]>[0] = {
    company_domain: input.companyDomain,
    ...buildAuditOpts(ctx, "email.find"),
  };
  if (input.fullName) opts.full_name = input.fullName;
  if (input.firstName) opts.first_name = input.firstName;
  if (input.lastName) opts.last_name = input.lastName;
  const result: FindEmailResult = await agent.findEmail(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "email.find",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
  });
  return { result, receiptId };
}

export interface VerifyEmailInput {
  email: string;
}

export async function verifyEmail(input: VerifyEmailInput, ctx: CallContext) {
  const agent = await getAgent();
  const result: VerifyEmailResult = await agent.verifyEmail({
    email: input.email,
    ...buildAuditOpts(ctx, "email.verify"),
  });
  const receiptId = recordCallReceipt({
    ctx,
    callType: "email.verify",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
  });
  return { result, receiptId };
}

export interface EnrichCompanyInput {
  domain?: string;
  name?: string;
  linkedinUrl?: string;
  ticker?: string;
}

/**
 * Company enrichment from a domain, name, LinkedIn URL or stock ticker —
 * $0.005 per call. Used by `local-registry` (issue #459) to resolve a domain
 * for open-registry records that carry a business name/address but no email,
 * before falling through to the normal `resolveVerifyEnrichQualify` spine.
 */
export async function enrichCompany(input: EnrichCompanyInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["enrichCompany"]>[0] = {
    ...buildAuditOpts(ctx, "enrich.company"),
  };
  if (input.domain) opts.domain = input.domain;
  if (input.name) opts.name = input.name;
  if (input.linkedinUrl) opts.linkedin_url = input.linkedinUrl;
  if (input.ticker) opts.ticker = input.ticker;

  const result: EnrichCompanyResult = await agent.enrichCompany(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "enrich.company",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
  });
  return { result, receiptId };
}

export async function getBalance(
  tokenAddress?: string,
): Promise<{ balance: string; raw: unknown }> {
  if (demoMode()) {
    const fixture = demoFixture<{ balance: string; raw: unknown }>("balance.json");
    if (fixture) return fixture;
  }
  const agent = await getAgent();
  const raw = await agent.getBalance(tokenAddress);
  return { balance: raw, raw };
}

/**
 * Hard deadline for one inbox source. Without it a hung upstream (the OneShot
 * inbox endpoint has been observed stalling to Bun's ~300s default fetch
 * timeout) blocks the /inbox route and stop-on-reply for minutes. The
 * underlying request keeps running after the race loses — fine, we only need
 * the caller unblocked; the next poll gets a fresh attempt.
 */
const INBOX_SOURCE_TIMEOUT_MS = 15_000;

async function listOneShotInbox(opts?: {
  since?: string;
  until?: string;
  limit?: number;
}): Promise<InboxListResult> {
  const agent = await getAgent();
  const out: { since?: string; limit?: number; include_body?: boolean } = { include_body: true };
  if (opts?.since) out.since = opts.since;
  if (opts?.limit) out.limit = opts.limit;
  const res = await agent.inboxList(out);
  // The SDK has no upper bound, so `until` is applied client-side to the
  // newest `limit` rows the platform returns. That makes this source
  // un-pageable: a slice older than those rows comes back empty. Gmail pages
  // properly; the OneShot mailbox (one agent address, replies only) is small
  // enough that its newest page is its history. Revisit if the SDK grows a
  // `before`/cursor parameter.
  if (!opts?.until) return res;
  const until = opts.until;
  const emails = res.emails.filter((e) => e.received_at < until);
  return { ...res, emails, count: emails.length };
}

/**
 * InboxEmail plus local-only annotations: `message_id` (RFC 2822, Gmail
 * sources only — needed for In-Reply-To on a threaded reply) and
 * `source_identity_id` (which sender identity's mailbox received it — a reply
 * must go out from that same identity). Extends the SDK type, so existing
 * consumers (stop-on-reply reads `from` only) are unaffected.
 */
export type AnnotatedInboxEmail = InboxEmail & {
  message_id?: string;
  source_identity_id?: string;
  /** Header-level autoresponder verdict (Gmail sources only — RFC 3834 et al.). */
  auto_submitted?: boolean;
};

export interface AnnotatedInboxListResult extends InboxListResult {
  emails: AnnotatedInboxEmail[];
  /**
   * Sources that errored this fetch (multi-source only; a lone source throws).
   * The reply poll needs this: a partial result must not move its watermark,
   * or the failed mailbox's replies fall into a gap the next poll skips.
   */
  failed_sources?: string[];
}

/**
 * Ensure an inbound email has a readable `body`, falling back to a de-tagged
 * `body_html` (HTML-only mail is the normal shape for replies to our sends).
 * Applied in the annotate funnel so EVERY listInbox consumer benefits.
 * Exported for tests.
 */
export function fillInboxBody(e: InboxEmail): InboxEmail {
  if (e.body?.trim()) return e;
  const html = e.body_html ?? "";
  if (!html) return e;
  return { ...e, body: htmlToText(html) };
}

function annotateInboxResult(r: InboxListResult, identityId: string): AnnotatedInboxListResult {
  return {
    ...r,
    emails: r.emails.map((e) => ({ ...fillInboxBody(e), source_identity_id: identityId })),
  };
}

/**
 * Replies across the WHOLE sender pool (OneShot inbox + every Gmail account):
 * stop-on-reply must see a reply whichever identity sent the thread. Each
 * source has its own try/catch — one revoked token must not blind the rest —
 * but a single source keeps legacy throw semantics for the /inbox route.
 */
export async function listInbox(opts?: {
  since?: string;
  /** Exclusive upper bound on received_at — for paging a backfill in slices. */
  until?: string;
  limit?: number;
  /**
   * Per-source fetch deadline. Defaults to the 15s that keeps the /inbox route
   * and the 5-minute poll responsive; a deliberate backfill over months of
   * mail (hundreds of full-message fetches per mailbox) needs far longer.
   */
  deadlineMs?: number;
}): Promise<AnnotatedInboxListResult> {
  const deadlineMs = opts?.deadlineMs ?? INBOX_SOURCE_TIMEOUT_MS;
  if (demoMode()) {
    const fixture = demoFixture<AnnotatedInboxListResult>("inbox.json");
    if (fixture) return fixture;
  }
  const identities = resolveIdentities(loadConfig());
  const sources: Array<{
    label: string;
    identityId: string;
    fetch: () => Promise<InboxListResult>;
  }> = [];
  const oneshotIdentity = identities.find((i) => i.provider === "oneshot");
  if (oneshotIdentity) {
    sources.push({
      label: "oneshot",
      identityId: oneshotIdentity.id,
      fetch: () => listOneShotInbox(opts),
    });
  }
  for (const identity of identities.filter((i) => i.provider === "gmail")) {
    sources.push({
      label: identity.id,
      identityId: identity.id,
      fetch: () => {
        const account = gmailAccountFor(identity);
        if (!account) {
          // Reject (not fall back to the env token — possibly a different
          // account's inbox). Multi-source: logged + skipped; single-source:
          // propagates like any other inbox failure.
          return Promise.reject(
            new Error(
              `no Gmail refresh token stored for sender identity '${identity.id}' — re-authorize it (bun run cli -- gmail auth)`,
            ),
          );
        }
        return listGmailReplies(opts, account);
      },
    });
  }

  if (sources.length === 1) {
    const only = sources[0]!;
    const result = annotateInboxResult(
      await withDeadline(only.fetch(), deadlineMs, `inbox source '${only.label}'`),
      only.identityId,
    );
    // Same post-processing as the multi-source branch below — without it the
    // two branches disagree about count semantics (the single-source result
    // came back unsliced, so `count` meant "fetched" there and "window" here),
    // which is exactly the kind of drift that made the /inbox numbers lie.
    return mergeInboxWindow([result], opts?.limit);
  }

  const results = await parallelMap(sources, 3, async (source) => {
    try {
      return annotateInboxResult(
        await withDeadline(source.fetch(), deadlineMs, `inbox source '${source.label}'`),
        source.identityId,
      );
    } catch (err) {
      logEvent(
        "inbox.source_failed",
        { source: source.label, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      return null;
    }
  });
  const ok = results.filter((r): r is AnnotatedInboxListResult => r != null);
  if (ok.length === 0) {
    throw new Error("all inbox sources failed — check doctor for identity auth status");
  }
  const failed = sources.filter((_, i) => results[i] == null).map((s) => s.label);
  return {
    ...mergeInboxWindow(ok, opts?.limit),
    ...(failed.length ? { failed_sources: failed } : {}),
  };
}

/**
 * Targeted fetch of mail FROM the given addresses across every Gmail identity,
 * searched all-time — so a known replier's mail surfaces even when the broad
 * newest-N window is full of noise or the reply predates its recency cutoff.
 * Best-effort: per-source failures are logged and skipped, and the OneShot
 * inbox is not queried (it can't filter by sender; its small replies-only
 * mailbox is already covered by the main window). Returns [] in demo mode.
 */
export async function listRepliesFrom(
  addresses: string[],
  opts?: { limitPerSource?: number; deadlineMs?: number; maxPagesPerSource?: number },
): Promise<AnnotatedInboxEmail[]> {
  if (addresses.length === 0 || demoMode()) return [];
  const deadlineMs = opts?.deadlineMs ?? INBOX_SOURCE_TIMEOUT_MS;
  const limit = opts?.limitPerSource ?? 50;
  const maxPages = opts?.maxPagesPerSource ?? 5;
  const identities = resolveIdentities(loadConfig()).filter((i) => i.provider === "gmail");
  const results = await parallelMap(identities, 3, async (identity) => {
    try {
      const account = gmailAccountFor(identity);
      if (!account) return null;
      // Page backwards by `until` so a busy known-replier set isn't clipped at
      // one window (a from:() query is small; the page cap only bounds a
      // pathological mailbox). `until` is nudged +1s past the oldest so a
      // same-second sibling isn't skipped by Gmail's second-granularity
      // `before:`; the seen-set makes the overlap a no-op.
      const seen = new Set<string>();
      const collected: AnnotatedInboxEmail[] = [];
      let until: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const r = await withDeadline(
          listGmailReplies({ fromAnyOf: addresses, limit, ...(until ? { until } : {}) }, account),
          deadlineMs,
          `replies-from source '${identity.id}'`,
        );
        const annotated = annotateInboxResult(r, identity.id);
        const fresh = annotated.emails.filter((e) => !seen.has(e.id));
        for (const e of fresh) seen.add(e.id);
        collected.push(...fresh);
        if (!r.has_more || fresh.length === 0) break;
        const oldest = fresh.reduce(
          (m, e) => (e.received_at < m ? e.received_at : m),
          fresh[0]!.received_at,
        );
        until = new Date(new Date(oldest).getTime() + 1000).toISOString();
      }
      return collected;
    } catch (err) {
      logEvent(
        "inbox.replies_from_failed",
        { source: identity.id, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      return null;
    }
  });
  return results.filter((r): r is AnnotatedInboxEmail[] => r != null).flat();
}

/**
 * Dedupe, sort newest-first and clamp source results to the requested window,
 * with `has_more` true whenever the window is not the whole story — either a
 * source said so itself, or the clamp dropped rows. Shared by BOTH listInbox
 * branches so `count`/`has_more` mean the same thing regardless of how many
 * identities are configured.
 */
function mergeInboxWindow(
  results: AnnotatedInboxListResult[],
  limit?: number,
): AnnotatedInboxListResult {
  const max = limit ?? 50;
  const seen = new Set<string>();
  const all = results
    .flatMap((r) => r.emails)
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .toSorted((a, b) =>
      a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0,
    );
  const emails = all.slice(0, max);
  return {
    emails,
    count: emails.length,
    has_more: results.some((r) => r.has_more) || all.length > max,
    agent_id: results.map((r) => r.agent_id).join("+"),
  };
}

export interface IdentityBounce extends GmailBounce {
  /** Identity whose mailbox received the DSN — which is the identity that sent the message. */
  identityId: string;
}

/**
 * Delivery failures across the sender pool. Gmail identities only — a DSN
 * returns to the envelope sender, and OneShot's return path belongs to the
 * platform. The receiving mailbox IS the sending mailbox, so attribution
 * needs no join. Per-source try/catch, and unlike listInbox this NEVER
 * throws on total failure — it runs on a background sweep; report nothing
 * and retry next tick.
 */
export async function listBounces(opts?: {
  since?: string;
  limit?: number;
}): Promise<IdentityBounce[]> {
  const identities = resolveIdentities(loadConfig()).filter((i) => i.provider === "gmail");
  const results = await parallelMap(identities, 3, async (identity) => {
    const account = gmailAccountFor(identity);
    if (!account) {
      logEvent("bounce.source_skipped", { source: identity.id, reason: "no_token" }, "warn");
      return [];
    }
    try {
      const bounces = await withDeadline(
        listGmailBounces(opts, account),
        INBOX_SOURCE_TIMEOUT_MS,
        `bounce source '${identity.id}'`,
      );
      // Freshly parsed objects with no other holder — assign in place.
      return bounces.map((b) => Object.assign(b, { identityId: identity.id }));
    } catch (err) {
      logEvent(
        "bounce.source_failed",
        { source: identity.id, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      return [];
    }
  });
  return results.flat();
}

export interface BuildSiteInput {
  name: string;
  description: string;
  type?:
    | "saas"
    | "portfolio"
    | "agency"
    | "personal"
    | "product"
    | "funnel"
    | "restaurant"
    | "event";
  sections?: string[];
  leadCaptureEmail?: string;
  primaryColor?: string;
  tone?: "professional" | "playful" | "bold" | "minimal";
  domain?: string;
}

export async function buildSite(input: BuildSiteInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["build"]>[0] = {
    product: { name: input.name, description: input.description },
    ...buildAuditOpts(ctx, "build.website"),
  };
  if (input.type) opts.type = input.type;
  if (input.sections) opts.sections = input.sections;
  if (input.leadCaptureEmail) {
    opts.lead_capture = { enabled: true, inbox_email: input.leadCaptureEmail };
  }
  if (input.primaryColor || input.tone) {
    opts.brand = {};
    if (input.primaryColor) opts.brand.primary_color = input.primaryColor;
    if (input.tone) opts.brand.tone = input.tone;
  }
  if (input.domain) opts.domain = input.domain;

  const result = await agent.build(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "build.website",
    signedReceipt: result,
    costUsd: result.cost,
  });
  return { result, receiptId };
}

export interface SendSmsInput {
  to: string | string[];
  message: string;
  maxCost?: number;
}

export async function sendSms(input: SendSmsInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["sms"]>[0] = {
    to_number: input.to,
    message: input.message,
    ...buildAuditOpts(ctx, "sms.send"),
  };
  if (input.maxCost) opts.maxCost = input.maxCost;
  const result: SmsSendResult = await agent.sms(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "sms.send",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.details[0]?.message_sid ?? undefined,
  });
  return { result, receiptId };
}

export interface VoiceCallInput {
  objective: string;
  to: string | string[];
  callerPersona?: string;
  context?: string;
  maxDurationMinutes?: number;
  maxCost?: number;
}

export async function voiceCall(input: VoiceCallInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["voice"]>[0] = {
    objective: input.objective,
    target_number: input.to,
    ...buildAuditOpts(ctx, "voice.call"),
  };
  if (input.callerPersona) opts.caller_persona = input.callerPersona;
  if (input.context) opts.context = input.context;
  if (input.maxDurationMinutes) opts.max_duration_minutes = input.maxDurationMinutes;
  if (input.maxCost) opts.maxCost = input.maxCost;
  const result: VoiceCallResult = await agent.voice(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "voice.call",
    costUsd: result.cost,
    signedReceipt: result,
  });
  return { result, receiptId };
}

export interface WebSearchInput {
  query: string;
  maxResults?: number;
}

export async function webSearch(input: WebSearchInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["webSearch"]>[0] = {
    query: input.query,
    ...buildAuditOpts(ctx, "web.search"),
  };
  if (input.maxResults) opts.max_results = input.maxResults;
  const result: WebSearchResult = await agent.webSearch(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "web.search",
    signedReceipt: result,
    costUsd: result.cost,
  });
  return { result, receiptId };
}

export interface WebReadInput {
  url: string;
}

export async function webRead(input: WebReadInput, ctx: CallContext) {
  const agent = await getAgent();
  const result: WebReadResult = await agent.webRead({
    url: input.url,
    ...buildAuditOpts(ctx, "web.read"),
  });
  const receiptId = recordCallReceipt({
    ctx,
    callType: "web.read",
    signedReceipt: result,
    costUsd: result.cost,
    oneshotRequestId: result.request_id,
  });
  return { result, receiptId };
}

export interface BrowserTaskInput {
  task: string;
  startUrl?: string;
  allowedDomains?: string[];
  outputSchema?: Record<string, unknown>;
  profileId?: string;
  maxSteps?: number;
  maxCost?: number;
}

export async function browserTask(input: BrowserTaskInput, ctx: CallContext) {
  const agent = await getAgent();
  const opts: Parameters<OneShot["browser"]>[0] = {
    task: input.task,
    ...buildAuditOpts(ctx, "browser.task"),
  };
  if (input.startUrl) opts.start_url = input.startUrl;
  if (input.allowedDomains) opts.allowed_domains = input.allowedDomains;
  if (input.outputSchema) opts.output_schema = input.outputSchema;
  if (input.profileId) opts.profile_id = input.profileId;
  if (input.maxSteps) opts.max_steps = input.maxSteps;
  if (input.maxCost) opts.maxCost = input.maxCost;
  const result: BrowserResult = await agent.browser(opts);
  const receiptId = recordCallReceipt({
    ctx,
    callType: "browser.task",
    costUsd: result.cost,
    signedReceipt: result,
    oneshotRequestId: result.browser_task_id ?? undefined,
  });
  return { result, receiptId };
}

export type {
  BrowserResult,
  DeepResearchPersonResult,
  InboxEmail,
  InboxListResult,
  SmsSendResult,
  VoiceCallResult,
  WebReadResult,
  WebSearchResult,
};

export function receiptUrlForId(receiptId: number): string {
  return `local://receipt/${receiptId}`;
}

/** RoCS value tag — the shape OneShot's `tagReceiptValue` accepts. */
export type ValueTag = { type: string; amount?: number; label?: string };

/**
 * Funnel rank of a value-tag type, so a later outcome never *downgrades* a
 * receipt's value (e.g. a reply poll firing AFTER a deal is recorded must not
 * overwrite `revenue` with `engagement`). Unknown types rank 0.
 */
function valueTagRank(type: string): number {
  switch (type) {
    case "revenue":
      return 4;
    case "qualified":
      return 3;
    case "meeting":
      return 2;
    case "engagement":
      return 1;
    default:
      return 0;
  }
}

/**
 * Map a recorded deal outcome to a RoCS value tag, or null when there's no
 * positive value to attribute (deal_lost / ghosted are left untagged).
 */
export function outcomeToValueTag(
  outcome: "meeting_booked" | "sql_qualified" | "deal_won" | "deal_lost" | "ghosted",
  amountUsd?: number,
): ValueTag | null {
  switch (outcome) {
    case "meeting_booked":
      return { type: "meeting", label: "meeting booked" };
    case "sql_qualified":
      return { type: "qualified", label: "SQL qualified" };
    case "deal_won":
      return Number.isFinite(amountUsd)
        ? { type: "revenue", amount: amountUsd, label: "deal won" }
        : { type: "revenue", label: "deal won" };
    case "deal_lost":
    case "ghosted":
      return null;
  }
}

/** One cadence's RoCS rollup (spend vs value), keyed by its goalId. */
export interface CadenceRocsGoal {
  goalId: string;
  spend: number;
  value: number;
  pendingValue: number;
  rocs: number;
  receiptCount: number;
}

/**
 * Per-cadence RoCS from OneShot (`rocsByGoal`): spend (receipts grouped by
 * `decisionContext.goalId`) vs value (outcomes tagged via `tagReceiptValue({goalId})`).
 * Transient-tolerant — a brief outage returns `[]` rather than blocking the
 * Measure page; genuine auth errors propagate so misconfig is visible.
 */
export async function cadenceRocs(opts: { periodDays?: number } = {}): Promise<CadenceRocsGoal[]> {
  if (demoMode()) {
    // Keyed by period ("7"/"30"/"all") so the Measure range chips actually
    // change the numbers in a demo. A plain array (a fixture from an older
    // `demo seed`) is served as-is for every period.
    const fixture = demoFixture<CadenceRocsGoal[] | Record<string, CadenceRocsGoal[]>>(
      "rocs-by-goal.json",
    );
    if (Array.isArray(fixture)) return fixture;
    if (fixture) return fixture[String(opts.periodDays ?? "all")] ?? fixture["all"] ?? [];
  }
  try {
    const agent = await getAgent();
    const res = await agent.rocsByGoal(opts.periodDays != null ? { period: opts.periodDays } : {});
    return res.goals.map((g) => ({
      goalId: g.goal_id,
      spend: Number(g.spend),
      value: Number(g.value),
      pendingValue: Number(g.pending_value),
      rocs: g.rocs,
      receiptCount: g.receipt_count,
    }));
  } catch (err) {
    if (isTransientToolError(err)) {
      logEvent(
        "rocs_by_goal.transient_failure",
        { message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      return [];
    }
    throw err;
  }
}

/**
 * Tag a cadence's value once its outcome is known: one `tagReceiptValue({goalId})`
 * call fans out across the goal's receipts, mirrored locally for /receipts.
 * Best-effort — failures are logged and swallowed. The precedence/dedup guard
 * skips identical re-tags and never downgrades a higher-value tag (a late
 * reply must not overwrite `revenue` with `engagement`).
 */
export async function tagOutcomeValue(input: {
  prospectId: number;
  playName: string;
  valueTag: ValueTag;
}): Promise<{ tagged: boolean }> {
  const ledger = getLedger();
  const email = ledger.getProspectById(input.prospectId)?.email;
  const goalId = cadenceGoalId(input.playName, email ?? `pid:${input.prospectId}`);
  const tagJson = JSON.stringify(input.valueTag);

  // Precedence/dedup guard against the goal's current local tag.
  const existing = ledger.currentGoalValueTag(goalId);
  if (existing) {
    if (existing === tagJson) return { tagged: false };
    let existingType = "";
    try {
      existingType = (JSON.parse(existing) as ValueTag).type ?? "";
    } catch {
      existingType = "";
    }
    if (valueTagRank(existingType) > valueTagRank(input.valueTag.type)) return { tagged: false };
  }

  // Mirror locally first so the UI reflects the outcome even if the platform call
  // can't run (no wallet creds) or fails. No-op when no receipt carries this goal.
  const mirrored = ledger.setReceiptValueTagByGoal(goalId, tagJson);
  if (mirrored === 0) return { tagged: false };

  let agent: OneShot | null = null;
  try {
    agent = await getAgent();
  } catch (err) {
    logEvent(
      "receipt.value_tag.agent_unavailable",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return { tagged: false };
  }
  try {
    await agent.tagReceiptValue({ goalId }, input.valueTag);
    return { tagged: true };
  } catch (err) {
    logEvent(
      "receipt.value_tag.failed",
      { goal_id: goalId, message_120: ((err as Error).message ?? "").slice(0, 120) },
      isTransientToolError(err) ? "warn" : "error",
    );
    return { tagged: false };
  }
}
