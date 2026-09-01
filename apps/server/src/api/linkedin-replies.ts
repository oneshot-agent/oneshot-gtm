import { randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalLinkedInProfileKey, getLedger } from "@oneshot-gtm/core";
import type { LinkedInReplyResult, LinkedInReplyWebhookRequest } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

const SOURCE_RX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function linkedinReplyWebhookRoute(req: Request): Promise<Response> {
  const configured = process.env["LINKEDIN_REPLY_WEBHOOK_SECRET"]?.trim() ?? "";
  const supplied = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!configured || !safeEqual(configured, supplied)) {
    return jsonResponse({ error: "unauthorized" }, 401, req);
  }
  if (!isJson(req))
    return jsonResponse({ error: "content-type must be application/json" }, 400, req);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  const parsed = parseWebhook(raw);
  if (typeof parsed === "string") return jsonResponse({ error: parsed }, 400, req);

  const ledger = getLedger();
  const matched = ledger.resolveProspectForLinkedInReply(parsed);
  if (matched.status === "unmatched")
    return jsonResponse({ error: "prospect not found" }, 404, req);
  if (matched.status === "conflict") {
    return jsonResponse({ error: "email and LinkedIn URL identify different prospects" }, 409, req);
  }
  return jsonResponse(
    accepted(
      ledger.recordLinkedInReply({
        prospectId: matched.prospectId,
        source: parsed.source,
        externalEventId: parsed.eventId,
        occurredAt: parsed.occurredAt,
      }),
    ),
    200,
    req,
  );
}

export function markLinkedInReplyRoute(req: Request, params: Record<string, string>): Response {
  const prospectId = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(prospectId)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  if (!ledger.getProspectById(prospectId))
    return jsonResponse({ error: "prospect not found" }, 404, req);
  return jsonResponse(
    accepted(
      ledger.recordLinkedInReply({
        prospectId,
        source: "manual",
        externalEventId: randomUUID(),
        occurredAt: new Date().toISOString(),
      }),
    ),
    200,
    req,
  );
}

function accepted(result: Omit<LinkedInReplyResult, "accepted">): LinkedInReplyResult {
  return { accepted: true, ...result };
}

function parseWebhook(raw: unknown): LinkedInReplyWebhookRequest | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "JSON object body required";
  const value = raw as Record<string, unknown>;
  if (value["email"] !== undefined && typeof value["email"] !== "string") {
    return "email must be a string";
  }
  if (value["linkedinUrl"] !== undefined && typeof value["linkedinUrl"] !== "string") {
    return "linkedinUrl must be a string";
  }
  const source = stringValue(value["source"]);
  const eventId = stringValue(value["eventId"]);
  const occurredAt = stringValue(value["occurredAt"]);
  const email = optionalString(value["email"]);
  const linkedinUrl = optionalString(value["linkedinUrl"]);
  if (!source || !SOURCE_RX.test(source)) return "source must be a lowercase provider slug";
  if (!eventId || eventId.length > 200) return "eventId must be 1–200 characters";
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt)))
    return "occurredAt must be an ISO timestamp";
  if (Date.parse(occurredAt) > Date.now() + 5 * 60_000) return "occurredAt cannot be in the future";
  if (!email && !linkedinUrl) return "email or linkedinUrl required";
  if (email && !EMAIL_RX.test(email)) return "email must be valid";
  if (linkedinUrl && !canonicalLinkedInProfileKey(linkedinUrl)) {
    return "linkedinUrl must be a LinkedIn member profile URL";
  }
  return {
    source,
    eventId,
    occurredAt: new Date(occurredAt).toISOString(),
    ...(email ? { email } : {}),
    ...(linkedinUrl ? { linkedinUrl } : {}),
  };
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  return value === undefined ? null : stringValue(value);
}

function isJson(req: Request): boolean {
  return (
    (req.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]?.trim() ===
    "application/json"
  );
}
