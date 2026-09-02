import { getLedger } from "@oneshot-gtm/core";
import { icpFilter, resolveIcp } from "@oneshot-gtm/find";
import type { ConciergeTarget, DemoNoShowTarget } from "@oneshot-gtm/plays";
import { jsonResponse } from "../server.ts";
import { verifyWebhook } from "./webhook-verifier.ts";

type WebhookKind = "cal-no-show" | "signup";

export async function calNoShowWebhookRoute(req: Request): Promise<Response> {
  return intakeWebhook(req, "cal-no-show");
}

export async function signupWebhookRoute(req: Request): Promise<Response> {
  return intakeWebhook(req, "signup");
}

async function intakeWebhook(req: Request, kind: WebhookKind): Promise<Response> {
  if (!isJsonRequest(req)) {
    return jsonResponse({ error: "content-type must be application/json" }, 400, req);
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }

  const verification = verifyWebhook(
    req.headers.get("x-webhook-signature"),
    body,
    process.env["WEBHOOK_SECRET"],
  );
  if (!verification.ok) return jsonResponse({ error: verification.error }, 401, req);

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }

  let payload: ConciergeTarget | DemoNoShowTarget;
  let company: string | null;
  let context: string;
  let eventIdentity: string;
  if (kind === "signup") {
    const parsed = parseSignup(raw);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, req);
    payload = parsed.value;
    company = null;
    context = payload.signupContext ?? "new signup";
    eventIdentity = payload.email;
  } else {
    const parsed = parseCalNoShow(raw);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, req);
    payload = parsed.value;
    company = payload.company;
    context = payload.whatTheyWanted ?? `missed demo at ${payload.missedAt}`;
    eventIdentity = `${payload.email}:${payload.missedAt}`;
  }
  const filter = await icpFilter({
    icp: await resolveIcp(),
    candidate: {
      title: company ? `${payload.name} at ${company}` : payload.name,
      summary: context,
      author: payload.name,
      url: payload.linkedinUrl ?? null,
    },
  });

  if (filter.match !== true) {
    return jsonResponse({ accepted: false, reason: filter.reason }, 200, req);
  }

  const playName = kind === "signup" ? "concierge" : "demo-no-show";
  const id = getLedger().enqueueTarget({
    playName,
    payload,
    dedupeKey: `webhook:${kind}:${eventIdentity.toLowerCase()}`,
    source: `webhook:${kind}`,
  });
  return jsonResponse({ accepted: true, queued: id !== null, id }, 202, req);
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseSignup(raw: unknown): ParseResult<ConciergeTarget> {
  if (!isRecord(raw)) return badPayload();
  const required = requireStrings(raw, ["name", "email", "phone"]);
  if (required) return { ok: false, error: required };
  if (!validEmail(raw["email"] as string)) return { ok: false, error: "email must be valid" };
  const optional = optionalStrings(raw, ["signupContext", "callWindow", "linkedinUrl"]);
  if (optional) return { ok: false, error: optional };
  return { ok: true, value: raw as unknown as ConciergeTarget };
}

function parseCalNoShow(raw: unknown): ParseResult<DemoNoShowTarget> {
  if (!isRecord(raw)) return badPayload();
  const required = requireStrings(raw, ["name", "email", "company", "missedAt", "rescheduleLink"]);
  if (required) return { ok: false, error: required };
  if (!validEmail(raw["email"] as string)) return { ok: false, error: "email must be valid" };
  const optional = optionalStrings(raw, ["phone", "whatTheyWanted", "linkedinUrl"]);
  if (optional) return { ok: false, error: optional };
  return { ok: true, value: raw as unknown as DemoNoShowTarget };
}

function isJsonRequest(req: Request): boolean {
  return (
    (req.headers.get("content-type") ?? "").toLowerCase().split(";", 1)[0]?.trim() ===
    "application/json"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireStrings(value: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      return `${field} (non-empty string) required`;
    }
  }
  return null;
}

function optionalStrings(value: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return `${field} must be a string`;
    }
  }
  return null;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function badPayload<T>(): ParseResult<T> {
  return { ok: false, error: "payload must be a JSON object" };
}
