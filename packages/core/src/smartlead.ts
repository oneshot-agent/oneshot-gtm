import { randomUUID } from "node:crypto";
import { withDeadline } from "./parallel.ts";

/**
 * Smartlead REST transport (send-only v1). Smartlead hosts + warms the
 * mailboxes; we send one-off emails through their API choosing the From
 * account by address. One workspace-wide API key (SMARTLEAD_API_KEY) — there
 * is no per-mailbox credential on our side.
 *
 * Security invariants:
 *  - Smartlead authenticates via an `api_key` QUERY PARAM. The key must never
 *    appear in thrown errors, logs, receipts, or telemetry — error messages
 *    are built from a pre-computed path with the query string stripped.
 *  - The accounts listing response includes base64 mailbox passwords. Rows are
 *    whitelist-destructured into SmartleadAccount at parse time; the raw
 *    objects never escape this module.
 */
const SMARTLEAD_API = "https://server.smartlead.ai/api/v1";
const SMARTLEAD_TIMEOUT_MS = 30_000;
const ACCOUNTS_PAGE_SIZE = 100;

/** Sanitized view of one Smartlead-connected mailbox. */
export interface SmartleadAccount {
  id: number;
  fromEmail: string;
  fromName: string | null;
  /** Smartlead's own per-mailbox daily send limit. */
  messagePerDay: number | null;
  dailySentCount: number;
  /** False = the SMTP connection is broken on Smartlead's side; sends will fail. */
  isSmtpSuccess: boolean;
  /** GMAIL | OUTLOOK | SMTP */
  type: string;
  /** ACTIVE | INACTIVE | PAUSED (null when Smartlead omits warmup details). */
  warmupStatus: string | null;
  /** e.g. "95%" */
  warmupReputation: string | null;
}

/** The stored workspace-wide key, or null when unset/blank. */
export function smartleadApiKey(): string | null {
  const key = process.env["SMARTLEAD_API_KEY"]?.trim();
  return key || null;
}

function resolveKey(apiKey?: string): string {
  const key = apiKey?.trim() || smartleadApiKey();
  if (!key) {
    throw new Error(
      "no Smartlead API key — set SMARTLEAD_API_KEY (bun run cli -- smartlead connect)",
    );
  }
  return key;
}

/**
 * Fetch JSON from the Smartlead API. `path` must be query-free; params are
 * appended via URLSearchParams with `api_key` LAST, and every error message
 * uses the bare path so the key can never leak through a throw.
 */
async function smartleadJson<T>(
  path: string,
  apiKey: string,
  params: Record<string, string> = {},
  init?: RequestInit,
): Promise<T> {
  const search = new URLSearchParams(params);
  search.set("api_key", apiKey);
  const res = await withDeadline(
    fetch(`${SMARTLEAD_API}${path}?${search}`, init),
    SMARTLEAD_TIMEOUT_MS,
    `Smartlead API ${path}`,
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Smartlead API ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Smartlead API ${path} returned non-JSON (${res.status})`);
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Whitelist-destructure one raw account row. The raw object carries mailbox
 * passwords (base64) — only the fields below may survive. Returns null for
 * rows without a usable id + from_email.
 */
function sanitizeAccount(raw: Record<string, unknown>): SmartleadAccount | null {
  const id = num(raw["id"]);
  const fromEmail = str(raw["from_email"])?.toLowerCase() ?? null;
  if (id == null || !fromEmail) return null;
  const warmup =
    raw["warmup_details"] && typeof raw["warmup_details"] === "object"
      ? (raw["warmup_details"] as Record<string, unknown>)
      : null;
  return {
    id,
    fromEmail,
    fromName: str(raw["from_name"]),
    messagePerDay: num(raw["message_per_day"]),
    dailySentCount: num(raw["daily_sent_count"]) ?? 0,
    isSmtpSuccess: raw["is_smtp_success"] !== false,
    type: str(raw["type"]) ?? "SMTP",
    warmupStatus: warmup ? str(warmup["status"]) : null,
    warmupReputation: warmup ? str(warmup["warmup_reputation"]) : null,
  };
}

/**
 * Every email account connected to the Smartlead workspace, sanitized.
 * Pages until a short page; a workspace with thousands of mailboxes is
 * clamped at 50 pages (5k accounts) as a runaway guard.
 */
export async function listSmartleadAccounts(apiKey?: string): Promise<SmartleadAccount[]> {
  const key = resolveKey(apiKey);
  const out: SmartleadAccount[] = [];
  for (let page = 0; page < 50; page++) {
    const rows = await smartleadJson<Record<string, unknown>[]>("/email-accounts/", key, {
      offset: String(page * ACCOUNTS_PAGE_SIZE),
      limit: String(ACCOUNTS_PAGE_SIZE),
    });
    if (!Array.isArray(rows)) {
      throw new Error("Smartlead API /email-accounts/ returned an unexpected shape");
    }
    for (const raw of rows) {
      const account = sanitizeAccount(raw);
      if (account) out.push(account);
    }
    if (rows.length < ACCOUNTS_PAGE_SIZE) break;
  }
  return out;
}

export interface SmartleadSendInput {
  to: string;
  subject: string;
  /** Pre-rendered HTML (Smartlead renders `body` as HTML). */
  htmlBody: string;
  /** The connected account to send as — must match a Smartlead from_email. */
  fromEmail: string;
  fromName?: string | null;
}

/**
 * One-off send via POST /send-email/initiate. Returns Smartlead's message id
 * for the ledger receipt (`oneshot_request_id`, which also dedupes re-records).
 * Smartlead documents no idempotency mechanism, so — like the Gmail path — a
 * timeout-then-retry can double-send. When the response carries no id we fall
 * back to a UUID: receipts stay unique, retry-dedupe is lost for that send.
 */
export async function sendViaSmartlead(
  input: SmartleadSendInput,
  apiKey?: string,
): Promise<{ messageId: string }> {
  const key = resolveKey(apiKey);
  const res = await smartleadJson<Record<string, unknown>>(
    "/send-email/initiate",
    key,
    {},
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: input.to,
        subject: input.subject,
        body: input.htmlBody,
        fromEmail: input.fromEmail,
        ...(input.fromName?.trim() ? { fromName: input.fromName.trim() } : {}),
      }),
    },
  );
  const data =
    res["data"] && typeof res["data"] === "object" ? (res["data"] as Record<string, unknown>) : res;
  const messageId =
    str(data["message_id"]) ?? str(data["messageId"]) ?? str(data["id"]) ?? str(res["message_id"]);
  return { messageId: messageId ?? `smartlead:${randomUUID()}` };
}
