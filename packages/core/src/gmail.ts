import type { InboxEmail, InboxListResult } from "@oneshot-agent/sdk";
import { parallelMap } from "./parallel.ts";

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
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.htmlBody,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export interface GmailSendResult {
  id: string;
  threadId: string;
}

export async function sendGmailMessage(
  input: RawMessageInput,
  account?: GmailAccount,
): Promise<GmailSendResult> {
  return gmailJson<GmailSendResult>(
    "/messages/send",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: buildRawMessage(input) }),
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

interface GmailMessageMeta {
  id: string;
  threadId: string;
  internalDate: string;
  payload?: GmailPayloadPart;
}

interface GmailPayloadPart {
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
  const emails = await parallelMap(ids, 4, async (id): Promise<InboxEmail> => {
    const msg = await gmailJson<GmailMessageMeta>(`/messages/${id}?format=full`, undefined, account);
    return {
      id: msg.id,
      from: header(msg, "From"),
      subject: header(msg, "Subject"),
      received_at: new Date(Number(msg.internalDate)).toISOString(),
      thread_id: msg.threadId,
      body: extractPlainText(msg.payload),
    };
  });
  return { emails, count: emails.length, has_more: false, agent_id: "gmail" };
}
