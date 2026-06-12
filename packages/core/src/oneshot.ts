import {
  OneShot,
  type BrowserResult,
  type DeepResearchPersonResult,
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
import { getLedger } from "./ledger.ts";
import { loadConfig, oneshotEnvReady } from "./config.ts";
import { logEvent } from "./events.ts";
import { getGmailProfile, listGmailReplies, sendGmailMessage } from "./gmail.ts";
import { gmailAccountFor, resolveIdentities } from "./identities.ts";
import { parallelMap } from "./parallel.ts";
import { resolveSenderIdentity } from "./send-routing.ts";
import type { EmailIdentity } from "./types.ts";

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
 * Derive the From localpart from the founder's name (first token, lowercased,
 * non-alphanumerics stripped) so sends read e.g. `jerry@yourdomain`. Falls back
 * to `agent` when the name yields nothing usable. ("Jane Doe" → "jane".)
 */
function fromLocalpart(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  const clean = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean.length > 0 ? clean : "agent";
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  // The send domain MUST be one the wallet owns, or OneShot 403s
  // (`domain_not_owned`). The SDK's typed email() defaults from_domain to its
  // own demo domain — so an unset sendingDomain is the current broken state.
  const fromDomain = input.fromDomain ?? identity.sendingDomain ?? cfg.sendingDomain ?? null;

  const opts: Parameters<OneShot["email"]>[0] = {
    to: input.to,
    subject: input.subject,
    body: toHtmlBody(input.body),
    ...buildAuditOpts(ctx, "email.send"),
  };
  if (fromDomain) {
    // sendingDomain must be wallet-owned (else OneShot 403s `domain_not_owned`,
    // since the SDK otherwise defaults to its demo domain). Send from
    // <first-name>@<domain> with the founder's name as the display name.
    // from_mailbox (localpart) + from_name (display name) are native fields in
    // SDK ≥0.16.2 — from_name ships as a separate field, so the bare
    // from_address still passes the server's strict email validation.
    opts.from_domain = fromDomain;
    opts.from_mailbox = identity.mailbox?.trim() || fromLocalpart(cfg.founderName);
    const name = (cfg.founderName ?? "").trim();
    if (name) opts.from_name = name;
  }
  const result = await agent.email(opts);

  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
    callType: "email.send",
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
}): Promise<InboxListResult> {
  const identities = resolveIdentities(loadConfig());
  const sources: Array<{ label: string; fetch: () => Promise<InboxListResult> }> = [];
  if (identities.some((i) => i.provider === "oneshot")) {
    sources.push({ label: "oneshot", fetch: () => listOneShotInbox(opts) });
  }
  for (const identity of identities.filter((i) => i.provider === "gmail")) {
    sources.push({
      label: identity.id,
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

  if (sources.length === 1) return sources[0]!.fetch();

  const results = await parallelMap(sources, 3, async (source) => {
    try {
      return await source.fetch();
    } catch (err) {
      logEvent(
        "inbox.source_failed",
        { source: source.label, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      return null;
    }
  });
  const ok = results.filter((r): r is InboxListResult => r != null);
  if (ok.length === 0) {
    throw new Error("all inbox sources failed — check doctor for identity auth status");
  }
  const seen = new Set<string>();
  const emails = ok
    .flatMap((r) => r.emails)
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .toSorted((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0))
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
  const receiptId = getLedger().recordReceipt({
    playName: ctx.playName,
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
