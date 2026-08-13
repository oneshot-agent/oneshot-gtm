import type { InboxEmail, InboxListResult } from "@oneshot-agent/sdk";
import { parallelMap } from "./parallel.ts";
import type { AuthVerdict, BounceKind, GmailPlacement } from "./types.ts";

/**
 * Gmail / Google Workspace send + reply path. Plain-fetch OAuth2 + Gmail REST
 * — no googleapis dependency. Credentials come from three secrets minted by
 * `bun run cli -- gmail auth`: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 * GMAIL_REFRESH_TOKEN (stored in ~/.oneshot-gtm/.env, applied to process.env
 * by config.ts on import).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_AUTH_HINT = "run: bun run cli -- gmail auth";

export const GMAIL_OAUTH_SCOPES =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";

/** Google consent URL for the loopback OAuth flow (CLI command and /setup button share it). */
export function gmailConsentUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GMAIL_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
  })}`;
}

/** Exchange an authorization code for a refresh token. Throws with an actionable message on any failure. */
export async function exchangeGmailAuthCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.refresh_token) {
    const detail = data.error
      ? `${data.error}${data.error_description ? ` — ${data.error_description}` : ""}`
      : `http ${res.status}`;
    const hint =
      res.ok && !data.refresh_token
        ? " (no refresh_token returned — revoke prior access at myaccount.google.com/permissions and retry)"
        : "";
    throw new Error(`Gmail token exchange failed: ${detail}${hint}`);
  }
  return data.refresh_token;
}

export function missingGmailSecrets(): string[] {
  return ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"].filter(
    (k) => !(process.env[k] ?? "").trim(),
  );
}

/**
 * One authorized Gmail account in the rotation pool. `id` keys the token /
 * profile caches; `refreshToken` comes from the gmail-tokens.json store (or
 * the legacy GMAIL_REFRESH_TOKEN secret). Omitted account = legacy
 * single-account mode reading the env secret directly.
 */
export interface GmailAccount {
  id: string;
  refreshToken: string;
}

const LEGACY_CACHE_KEY = "__legacy_env__";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const profileCache = new Map<string, { emailAddress: string }>();

/** Test-only: clears the memoized access tokens + profiles (all accounts). */
export function _resetGmailCache(): void {
  tokenCache.clear();
  profileCache.clear();
}

export async function getGmailAccessToken(account?: GmailAccount): Promise<string> {
  const cacheKey = account?.id ?? LEGACY_CACHE_KEY;
  const cached = tokenCache.get(cacheKey);
  // 60s skew so a token that expires mid-send is refreshed up front.
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const refreshToken = account?.refreshToken ?? (process.env["GMAIL_REFRESH_TOKEN"] ?? "").trim();
  const missing = account
    ? missingGmailSecrets().filter((k) => k !== "GMAIL_REFRESH_TOKEN")
    : missingGmailSecrets();
  if (missing.length > 0 || !refreshToken) {
    const what = [...missing, ...(refreshToken ? [] : ["refresh token"])].join(", ");
    throw new Error(`Gmail credentials missing (${what}) — ${GMAIL_AUTH_HINT}`);
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env["GMAIL_CLIENT_ID"]!,
      client_secret: process.env["GMAIL_CLIENT_SECRET"]!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      throw new Error(
        `Gmail auth expired or revoked${account ? ` for ${account.id}` : ""} — ${GMAIL_AUTH_HINT}`,
      );
    }
    throw new Error(`Gmail token refresh failed (${res.status}): ${data.error ?? "unknown"}`);
  }
  const entry = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  tokenCache.set(cacheKey, entry);
  return entry.token;
}

async function gmailFetch(
  path: string,
  init?: RequestInit,
  account?: GmailAccount,
): Promise<Response> {
  const token = await getGmailAccessToken(account);
  return fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
}

async function gmailJson<T>(path: string, init?: RequestInit, account?: GmailAccount): Promise<T> {
  const res = await gmailFetch(path, init, account);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 401) {
      throw new Error(`Gmail auth rejected (401) — ${GMAIL_AUTH_HINT}`);
    }
    throw new Error(`Gmail API ${path.split("?")[0]} failed (${res.status}): ${body}`);
  }
  return (await res.json()) as T;
}

/** Header values must be single-line; strips CR/LF to block header injection. */
function headerValue(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 B-encoding for non-ASCII header text (subject, display name). */
function encodeHeaderText(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export interface RawMessageInput {
  to: string;
  fromEmail: string;
  fromName?: string | null;
  subject: string;
  htmlBody: string;
  /** RFC 2822 Message-ID of the email being replied to → In-Reply-To header. */
  inReplyTo?: string;
  /** Prior Message-IDs of the conversation → References header (recipient-side threading). */
  references?: string[];
}

/** Build the base64url-encoded RFC 2822 message Gmail's `messages.send` expects. */
export function buildRawMessage(input: RawMessageInput): string {
  const name = headerValue(input.fromName ?? "");
  const from = name
    ? `"${encodeHeaderText(name).replace(/"/g, "")}" <${headerValue(input.fromEmail)}>`
    : headerValue(input.fromEmail);
  const lines = [
    `From: ${from}`,
    `To: ${headerValue(input.to)}`,
    `Subject: ${encodeHeaderText(headerValue(input.subject))}`,
  ];
  if (input.inReplyTo) lines.push(`In-Reply-To: ${headerValue(input.inReplyTo)}`);
  if (input.references?.length) {
    lines.push(`References: ${headerValue(input.references.join(" "))}`);
  }
  lines.push(
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.htmlBody,
  );
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export interface GmailSendResult {
  id: string;
  threadId: string;
}

export async function sendGmailMessage(
  input: RawMessageInput,
  account?: GmailAccount,
  /** Gmail thread to attach the send to (threads our copy in the sender's mailbox). */
  threadId?: string,
): Promise<GmailSendResult> {
  return gmailJson<GmailSendResult>(
    "/messages/send",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // threadId is a field of the Message resource (not a query param).
      body: JSON.stringify({ raw: buildRawMessage(input), ...(threadId ? { threadId } : {}) }),
    },
    account,
  );
}

export async function getGmailProfile(account?: GmailAccount): Promise<{ emailAddress: string }> {
  const cacheKey = account?.id ?? LEGACY_CACHE_KEY;
  const cached = profileCache.get(cacheKey);
  if (cached) return cached;
  const profile = await gmailJson<{ emailAddress: string }>("/profile", undefined, account);
  profileCache.set(cacheKey, profile);
  return profile;
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  internalDate: string;
  payload?: GmailPayloadPart;
}

export interface GmailPayloadPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

function header(msg: GmailMessageMeta, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function extractPlainText(part: GmailPayloadPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const text = extractPlainText(child);
    if (text) return text;
  }
  return "";
}

/**
 * Inbox replies, mapped to the OneShot InboxListResult contract so
 * advanceCadence (stop-on-reply) and the /inbox route work unchanged.
 * `-from:me` excludes the founder's own sends at the query level — the
 * Gmail-mode equivalent of the OneShot path's self-domain filter.
 */
export async function listGmailReplies(
  opts?: {
    since?: string;
    limit?: number;
  },
  account?: GmailAccount,
): Promise<InboxListResult> {
  const sinceClause = opts?.since
    ? `after:${Math.floor(new Date(opts.since).getTime() / 1000)}`
    : "newer_than:30d";
  const params = new URLSearchParams({
    q: `in:inbox -from:me ${sinceClause}`,
    maxResults: String(opts?.limit ?? 50),
  });
  const list = await gmailJson<{ messages?: Array<{ id: string }> }>(
    `/messages?${params}`,
    undefined,
    account,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  const emails = await parallelMap(
    ids,
    4,
    async (id): Promise<InboxEmail & { message_id?: string }> => {
      const msg = await gmailJson<GmailMessageMeta>(
        `/messages/${id}?format=full`,
        undefined,
        account,
      );
      // RFC 2822 Message-ID — needed as In-Reply-To/References on a threaded reply.
      const messageId = header(msg, "Message-ID");
      return {
        id: msg.id,
        from: header(msg, "From"),
        subject: header(msg, "Subject"),
        received_at: new Date(Number(msg.internalDate)).toISOString(),
        thread_id: msg.threadId,
        body: extractPlainText(msg.payload),
        ...(messageId ? { message_id: messageId } : {}),
      };
    },
  );
  return { emails, count: emails.length, has_more: false, agent_id: "gmail" };
}

/* ── Bounce (DSN) harvesting ─────────────────────────────────────────────────
 * Delivery Status Notifications are the only first-party deliverability signal
 * available without a second mailbox: the receiving server tells us, in the
 * sender's own inbox, that a message was refused and why. Parsed here rather
 * than in the reply path because (a) DSNs would otherwise compete with genuine
 * replies for the 50-message poll window, and (b) fetching them deliberately
 * lets us read the structured RFC 3464 report instead of regexing localized
 * human-readable prose.
 */

/** Matches an RFC 3463 enhanced status code ("5.1.1"). */
const ENHANCED_STATUS_RE = /\b([45]\.\d{1,3}\.\d{1,3})\b/;
/** Matches a bare 3-digit SMTP reply code, for servers that omit the enhanced one. */
const SMTP_CODE_RE = /\b([45]\d\d)\b/;
/**
 * Diagnostics that mean "we refused this message" rather than "this address
 * doesn't exist". Catches servers that reject on policy with a plain 550 and
 * no 5.7.x enhanced code, which would otherwise be miscounted as a dead
 * address (and wrongly suppress a perfectly valid prospect).
 */
const POLICY_DIAGNOSTIC_RE =
  /\b(spam|blocked|blocklist|blacklist|policy|reputation|unsolicited|bulk|rejected due to|spamhaus|barracuda|greylist)/i;
/** DSN envelope senders — never the failed recipient, so excluded when scraping prose. */
const DAEMON_ADDRESS_RE = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i;
const EMAIL_RE = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Severity for a delivery failure. `statusCode` is the enhanced RFC 3463 code
 * when the DSN provided one; `diagnostic` is the remote server's text. Policy
 * rejections are separated from address failures because only the latter
 * justifies suppressing the address — see BounceKind.
 */
export function classifyBounce(statusCode: string | null, diagnostic: string | null): BounceKind {
  const code = statusCode ?? diagnostic?.match(ENHANCED_STATUS_RE)?.[1] ?? null;
  const policy = diagnostic != null && POLICY_DIAGNOSTIC_RE.test(diagnostic);
  if (code) {
    if (code.startsWith("4.")) return "soft";
    if (code.startsWith("5.7.")) return "block";
    if (code.startsWith("5.")) return policy ? "block" : "hard";
  }
  // No enhanced code — fall back to the bare SMTP reply class.
  const smtp = diagnostic?.match(SMTP_CODE_RE)?.[1];
  if (smtp?.startsWith("4")) return "soft";
  if (smtp?.startsWith("5")) return policy ? "block" : "hard";
  // Unparseable severity: treat as transient. Guessing `hard` here would
  // suppress a live address on the strength of an unrecognized message.
  return "soft";
}

/** Depth-first search for the first part of a given MIME type. */
function findPart(
  part: GmailPayloadPart | undefined,
  mimeType: string,
): GmailPayloadPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Unfold RFC 5322 continuation lines (a line beginning with whitespace belongs
 * to the previous one). Diagnostic-Code routinely wraps across several lines,
 * and reading only the first would truncate the SMTP response mid-sentence.
 */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length > 0) out[out.length - 1] += ` ${raw.trim()}`;
    else out.push(raw);
  }
  return out;
}

function fieldValue(lines: string[], name: string): string | null {
  const prefix = `${name.toLowerCase()}:`;
  for (const line of lines) {
    if (line.toLowerCase().startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

/** "rfc822; jane@x.com" / "<jane@x.com>" → "jane@x.com". */
function stripAddressType(value: string): string {
  const afterType = value.includes(";") ? value.slice(value.indexOf(";") + 1) : value;
  return afterType.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

export interface ParsedBounce {
  /** The address that failed (Final-Recipient), lowercased. */
  recipient: string;
  kind: BounceKind;
  statusCode: string | null;
  diagnostic: string | null;
}

/**
 * Pull every failed recipient out of a DSN. Returns [] for ordinary mail, which
 * is what makes a deliberately broad Gmail query safe — the parser, not the
 * query, decides what counts as a bounce.
 *
 * Prefers the structured `message/delivery-status` report (locale-independent,
 * one block per recipient). Falls back to scraping the human-readable part for
 * senders that don't emit a conforming report.
 */
export function parseBounce(msg: GmailMessageMeta): ParsedBounce[] {
  const report = findPart(msg.payload, "message/delivery-status");
  if (report?.body?.data) {
    const text = Buffer.from(report.body.data, "base64url").toString("utf8");
    const out: ParsedBounce[] = [];
    // Per-message fields come first, then one block per recipient, blank-line
    // separated. Only blocks naming a recipient describe a delivery failure.
    for (const block of text.split(/\r?\n\s*\r?\n/)) {
      const lines = unfold(block);
      const finalRecipient =
        fieldValue(lines, "Final-Recipient") ?? fieldValue(lines, "Original-Recipient");
      if (!finalRecipient) continue;
      const recipient = stripAddressType(finalRecipient);
      if (!recipient.includes("@")) continue;
      const status = fieldValue(lines, "Status");
      const statusCode = status?.match(ENHANCED_STATUS_RE)?.[1] ?? null;
      const diagnostic = fieldValue(lines, "Diagnostic-Code");
      // `action: delivered/relayed/expanded` blocks are successes riding along
      // in a multi-recipient report — not failures.
      const action = fieldValue(lines, "Action")?.toLowerCase() ?? "";
      if (action && !action.startsWith("failed") && !action.startsWith("delayed")) continue;
      // A 2.x.x status is a SUCCESS report. MTAs that emit these without an
      // Action field would otherwise be recorded as bounces — harmless in
      // effect (they classify soft) but they'd inflate the failure counts the
      // doctor check reports.
      if (status?.trim().startsWith("2.")) continue;
      out.push({
        recipient,
        kind: classifyBounce(statusCode, diagnostic),
        statusCode,
        diagnostic: diagnostic?.slice(0, 300) ?? null,
      });
    }
    if (out.length > 0) return out;
  }

  // Fallback: no conforming report. Gate it on the message actually being a
  // delivery report first — prose-scraping is loose enough that an ordinary
  // email mentioning "550 users" next to an address would otherwise parse as a
  // hard bounce and suppress a live prospect. A structured report needs no such
  // guard; its presence is proof on its own.
  const from = msg.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
  const subject =
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
  const looksLikeDsn =
    DAEMON_ADDRESS_RE.test(from) ||
    /(delivery (status notification|failure|has failed)|undelivered mail|returned to sender|address not found)/i.test(
      subject,
    );
  if (!looksLikeDsn) return [];

  // Scrape the prose for an address plus a status code. Prefer an address on a
  // line that also carries a code (that's the SMTP response line naming the
  // failed recipient) over a bare first match, which could be the quoted
  // original sender.
  const body = extractPlainText(msg.payload);
  if (!body) return [];
  const statusCode = body.match(ENHANCED_STATUS_RE)?.[1] ?? null;
  if (!statusCode && !SMTP_CODE_RE.test(body)) return [];
  let recipient: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const hasCode = ENHANCED_STATUS_RE.test(line) || SMTP_CODE_RE.test(line);
    for (const addr of line.match(EMAIL_RE) ?? []) {
      if (DAEMON_ADDRESS_RE.test(addr)) continue;
      recipient ??= addr.toLowerCase();
      if (hasCode) {
        recipient = addr.toLowerCase();
        break;
      }
    }
    if (recipient && hasCode) break;
  }
  if (!recipient) return [];
  const diagnostic = body.replace(/\s+/g, " ").trim().slice(0, 300);
  return [{ recipient, kind: classifyBounce(statusCode, diagnostic), statusCode, diagnostic }];
}

export interface GmailBounce extends ParsedBounce {
  /** Gmail id of the DSN message. With `recipient`, the idempotency key for re-sweeps. */
  messageId: string;
  bouncedAt: string;
}

/**
 * Delivery failures reported to this mailbox. The query is a coarse net (DSN
 * senders and subjects vary by MTA); `parseBounce` discards anything that isn't
 * actually a delivery report, so over-matching costs a wasted fetch, not a
 * false bounce. No `in:inbox` — a DSN the founder archived still counts — and
 * no `-from:me`, which would drop self-relayed reports.
 */
export async function listGmailBounces(
  opts?: { since?: string; limit?: number },
  account?: GmailAccount,
): Promise<GmailBounce[]> {
  const sinceClause = opts?.since
    ? `after:${Math.floor(new Date(opts.since).getTime() / 1000)}`
    : "newer_than:30d";
  const params = new URLSearchParams({
    q:
      `(from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification" ` +
      `OR subject:"Undelivered Mail Returned to Sender" OR subject:"Delivery Failure") ${sinceClause}`,
    maxResults: String(opts?.limit ?? 100),
  });
  const list = await gmailJson<{ messages?: Array<{ id: string }> }>(
    `/messages?${params}`,
    undefined,
    account,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  const perMessage = await parallelMap(ids, 4, async (id): Promise<GmailBounce[]> => {
    const msg = await gmailJson<GmailMessageMeta>(
      `/messages/${id}?format=full`,
      undefined,
      account,
    );
    const bouncedAt = new Date(Number(msg.internalDate)).toISOString();
    // Object.assign, not a spread: parseBounce just built these objects and
    // nothing else holds a reference, so mutating in place is safe and avoids
    // a fresh allocation per recipient.
    return parseBounce(msg).map((b) => Object.assign(b, { messageId: msg.id, bouncedAt }));
  });
  return perMessage.flat();
}

/* ── Inbox placement ─────────────────────────────────────────────────────────
 * What DSN harvesting structurally cannot tell you: a message can be accepted
 * without complaint and still be filtered into spam or buried in a tab. The
 * only way to know is to look in a real receiving mailbox — which requires a
 * SECOND authorized account, since a message you send to yourself is never
 * filtered.
 */

/** All values for a header that may legitimately appear more than once. */
function headerValues(msg: GmailMessageMeta, name: string): string[] {
  const lower = name.toLowerCase();
  return (msg.payload?.headers ?? [])
    .filter((h) => h.name.toLowerCase() === lower)
    .map((h) => h.value);
}

/**
 * Where Gmail filed the message, from its labelIds. Order matters: a message
 * in Promotions carries BOTH `INBOX` and `CATEGORY_PROMOTIONS`, so checking
 * `INBOX` first would report a tab-binned message as a clean inbox hit — the
 * exact failure this test exists to catch. SPAM is checked first because a
 * spammed message carries neither INBOX nor a category.
 */
export function classifyPlacement(labelIds: string[]): GmailPlacement {
  const labels = new Set(labelIds);
  if (labels.has("SPAM")) return "spam";
  if (labels.has("TRASH")) return "archived";
  if (labels.has("CATEGORY_PROMOTIONS")) return "promotions";
  for (const tab of ["CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]) {
    if (labels.has(tab)) return "tab";
  }
  // CATEGORY_PERSONAL is the primary tab, not a demotion — INBOX decides.
  if (labels.has("INBOX")) return "inbox";
  return "archived";
}

export interface AuthResults {
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
}

const VERDICTS: AuthVerdict[] = ["pass", "fail", "softfail", "neutral", "none"];

/**
 * SPF/DKIM/DMARC as judged by the RECEIVING server, read off the delivered
 * message's `Authentication-Results` header. This is a verdict on the actual
 * message path — strictly better evidence than resolving DNS records ourselves,
 * and it needs no DNS tooling at all.
 *
 * Returns `unknown` per mechanism when the header is absent or silent on it,
 * which is normal for internal (same-Workspace) delivery that never crosses an
 * authenticating boundary.
 */
export function parseAuthResults(headers: string[]): AuthResults {
  const out: AuthResults = { spf: "unknown", dkim: "unknown", dmarc: "unknown" };
  for (const raw of headers) {
    const text = raw.toLowerCase();
    for (const mech of ["spf", "dkim", "dmarc"] as const) {
      if (out[mech] !== "unknown") continue;
      // The mechanism must start the token. `\b` alone is not enough: it
      // matches after a hyphen too, so "arc-dkim=pass" would be read as a
      // dkim verdict. Require the preceding char to be absent or neither a
      // word char nor a hyphen.
      const m = text.match(new RegExp(`(?:^|[^a-z0-9_-])${mech}=([a-z]+)`));
      const value = m?.[1];
      if (value && (VERDICTS as string[]).includes(value)) out[mech] = value as AuthVerdict;
    }
  }
  return out;
}

/** Both auth-results header spellings a receiving Gmail may use, newest evaluation first. */
export function authResultsFor(msg: GmailMessageMeta): AuthResults {
  return parseAuthResults([
    ...headerValues(msg, "Authentication-Results"),
    ...headerValues(msg, "ARC-Authentication-Results"),
  ]);
}

/** RFC 2822 Message-ID Gmail actually assigned to a message we sent (it rewrites any we supply). */
export async function getSentMessageId(
  gmailMessageId: string,
  account?: GmailAccount,
): Promise<string | null> {
  const msg = await gmailJson<GmailMessageMeta>(
    `/messages/${gmailMessageId}?format=metadata&metadataHeaders=Message-ID`,
    undefined,
    account,
  );
  return headerValues(msg, "Message-ID")[0] ?? null;
}

export interface PlacedMessage {
  id: string;
  labelIds: string[];
  placement: GmailPlacement;
  auth: AuthResults;
  receivedAt: string;
}

/**
 * Find a message in this mailbox by Gmail search and report where it landed.
 *
 * `in:anywhere` is load-bearing: Gmail's default search EXCLUDES spam and
 * trash, so without it the one outcome this test exists to detect — the
 * message was filtered as spam — would read identically to "never arrived".
 */
export async function findPlacedMessage(
  query: string,
  account?: GmailAccount,
): Promise<PlacedMessage | null> {
  const params = new URLSearchParams({ q: `in:anywhere ${query}`, maxResults: "5" });
  const list = await gmailJson<{ messages?: Array<{ id: string }> }>(
    `/messages?${params}`,
    undefined,
    account,
  );
  const id = list.messages?.[0]?.id;
  if (!id) return null;
  const msg = await gmailJson<GmailMessageMeta & { labelIds?: string[] }>(
    `/messages/${id}?format=metadata&metadataHeaders=Authentication-Results&metadataHeaders=ARC-Authentication-Results&metadataHeaders=Subject`,
    undefined,
    account,
  );
  const labelIds = msg.labelIds ?? [];
  return {
    id: msg.id,
    labelIds,
    placement: classifyPlacement(labelIds),
    auth: authResultsFor(msg),
    receivedAt: new Date(Number(msg.internalDate)).toISOString(),
  };
}

/** Gmail's `rfc822msgid:` operator wants the id bare — angle brackets make it match nothing. */
export function rfc822MsgIdQuery(messageId: string): string {
  return `rfc822msgid:${messageId.trim().replace(/^<|>$/g, "")}`;
}
