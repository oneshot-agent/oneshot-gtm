import {
  OneShot,
  type BrowserResult,
  type DeepResearchPersonResult,
  type DomainPoolEntry,
  type DomainPoolStatusResult,
  type EmailResult,
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
import { logEvent } from "./events.ts";
import { getGmailProfile, listGmailReplies, sendGmailMessage } from "./gmail.ts";
import { gmailAccountFor, resolveIdentities } from "./identities.ts";
import { parallelMap, withDeadline } from "./parallel.ts";
import { isTransientToolError, resolveSenderIdentity } from "./send-routing.ts";
import type { EmailIdentity } from "./types.ts";

/** Re-exported so callers don't reach into the SDK for the domain-pool shape. */
export type { DomainPoolEntry, DomainPoolStatusResult } from "@oneshot-agent/sdk";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  /** OneShot provider only — ignored when config.emailProvider is "gmail" (Gmail always sends from the authenticated account). */
  fromDomain?: string;
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
 * The wallet's provisioned sending-domain pool (SDK 0.19+ `listDomains`), used
 * to validate a `sendingDomain` is wallet-owned BEFORE a live send 403s with
 * `domain_not_owned`, and to populate the domain picker in setup.
 *
 * Transient-tolerant by design: a brief OneShot/transport outage returns `[]`
 * ("couldn't enumerate") so it never blocks the founder from saving an identity
 * — callers must treat an empty list as "unknown", not "no domains owned".
 * Genuine auth failures (bad/absent wallet creds) DO propagate, since those are
 * a real config error the founder needs to see.
 */
export async function listSendingDomains(): Promise<DomainPoolEntry[]> {
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
 * Stable Idempotency-Key for a OneShot email send (SDK 0.19+, honored by
 * email.send with a 24h replay window). Derived from the send's content so a
 * retry of the SAME logical email — a double-click, or a client retry after
 * the platform hung but actually sent — returns the original job instead of
 * charging + sending twice. A genuinely different body/subject hashes
 * differently, so it gets its own key (the server 422s same-key-different-body).
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

export async function sendEmail(input: SendEmailInput, ctx: CallContext) {
  // Sender rotation: resolve the sticky per-prospect identity BEFORE any
  // network call. Throws SendDeferredError when every identity is at its
  // daily cap — callers leave the work queued for tomorrow.
  const identity = resolveSenderIdentity(input.to);
  if (identity.provider === "gmail") {
    return sendEmailViaGmail(input, ctx, identity);
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
 * Reply to an inbound email from the identity whose mailbox received it.
 * Deliberately NOT routed through sender rotation (resolveSenderIdentity): a
 * reply must keep the thread's From address, and replies to engaged humans
 * shouldn't be deferred by warmup caps. Receipts use callType "email.reply",
 * which also keeps them out of per-identity cap counting (email.send only).
 * Both transports thread for real: Gmail via threadId + In-Reply-To/References
 * on the raw message; OneShot via `reply_to_email_id` (SDK 0.19+ — the
 * platform resolves the threading headers + thread_id server-side). The
 * OneShot send also carries an idempotency key so a retry can't double-send.
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
    return { result, receiptId };
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

export async function getBalance(
  tokenAddress?: string,
): Promise<{ balance: string; raw: unknown }> {
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
  limit?: number;
}): Promise<InboxListResult> {
  const agent = await getAgent();
  const out: { since?: string; limit?: number; include_body?: boolean } = { include_body: true };
  if (opts?.since) out.since = opts.since;
  if (opts?.limit) out.limit = opts.limit;
  return agent.inboxList(out);
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
};

export interface AnnotatedInboxListResult extends InboxListResult {
  emails: AnnotatedInboxEmail[];
}

function annotateInboxResult(r: InboxListResult, identityId: string): AnnotatedInboxListResult {
  return { ...r, emails: r.emails.map((e) => ({ ...e, source_identity_id: identityId })) };
}

/**
 * Replies across the WHOLE sender pool: the OneShot inbox (once, if any
 * oneshot identity exists) merged with every authorized Gmail account.
 * Stop-on-reply must see a reply no matter which identity sent the thread.
 * With multiple sources each is fetched under its own try/catch — one
 * revoked Gmail token must not blind reply detection for everything else.
 * A single source keeps legacy throw semantics (the /inbox route maps a
 * throw to its "couldn't reach the inbox" state).
 */
export async function listInbox(opts?: {
  since?: string;
  limit?: number;
}): Promise<AnnotatedInboxListResult> {
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
    return annotateInboxResult(
      await withDeadline(only.fetch(), INBOX_SOURCE_TIMEOUT_MS, `inbox source '${only.label}'`),
      only.identityId,
    );
  }

  const results = await parallelMap(sources, 3, async (source) => {
    try {
      return annotateInboxResult(
        await withDeadline(
          source.fetch(),
          INBOX_SOURCE_TIMEOUT_MS,
          `inbox source '${source.label}'`,
        ),
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
  const seen = new Set<string>();
  const emails = ok
    .flatMap((r) => r.emails)
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .toSorted((a, b) =>
      a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0,
    )
    .slice(0, opts?.limit ?? 50);
  return {
    emails,
    count: emails.length,
    has_more: ok.some((r) => r.has_more),
    agent_id: ok.map((r) => r.agent_id).join("+"),
  };
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
 * Tag a cadence's value once its outcome (reply / meeting / deal) is known.
 * Resolves the cadence correlation key from (prospect, play), records the value
 * to OneShot in ONE call via `tagReceiptValue({goalId})` (SDK 0.22 fans it out
 * across the goal's receipts, recorded once so it can't double-count), and
 * mirrors the tag onto the local receipts for the /receipts UI. Best-effort —
 * any failure is logged and swallowed so it never breaks the triggering flow.
 *
 * A precedence/dedup guard skips an identical re-tag (avoids a duplicate platform
 * outcome) and never downgrades a higher-value tag (e.g. a reply detected AFTER a
 * deal is logged must not overwrite `revenue` with `engagement`).
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
