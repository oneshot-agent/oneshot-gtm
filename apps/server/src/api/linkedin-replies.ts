import { createHash } from "node:crypto";
import { getLedger } from "@oneshot-gtm/core";
import type { LinkedInReplyResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

export async function markLinkedInReplyRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  if (!isDashboardOrigin(req)) return jsonResponse({ error: "forbidden origin" }, 403, req);
  const prospectId = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(prospectId)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  if (!ledger.getProspectById(prospectId))
    return jsonResponse({ error: "prospect not found" }, 404, req);

  // The message text, when the founder pasted one. Optional and best-effort:
  // an empty or absent body must still record the reply and stop the cadence.
  let body: string | null = null;
  if (isJson(req)) {
    try {
      const raw = (await req.json()) as Record<string, unknown> | null;
      const supplied = raw ? optionalString(raw["body"]) : null;
      if (supplied && supplied.length > MAX_BODY_CHARS) {
        return jsonResponse({ error: `body must be under ${MAX_BODY_CHARS} characters` }, 400, req);
      }
      body = supplied;
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400, req);
    }
  }

  const occurredAt = new Date().toISOString();
  return jsonResponse(
    accepted(
      ledger.recordLinkedInReply({
        prospectId,
        source: "manual",
        externalEventId: manualEventId(prospectId, body),
        occurredAt,
        body,
      }),
    ),
    200,
    req,
  );
}

/** Longest message we will store. LinkedIn DMs cap far below this. */
const MAX_BODY_CHARS = 8000;

/**
 * A stable id for a hand-marked reply, so `UNIQUE(source, external_event_id)`
 * can actually dedupe.
 *
 * This used to be `randomUUID()`, so every click minted a new row and the
 * dedupe never fired once — prospect 586 carries two "replied" events 47
 * seconds apart from one double-submit.
 *
 * Deliberately keyed on `(prospectId, body)` with NO timestamp. Bucketing the
 * clock was the obvious fix and it does not work: those two rows land at
 * 20:51:13 and 20:52:00, either side of a minute boundary, and any fixed
 * bucket has an edge a double-click can straddle. Identity is the right key
 * anyway — marking "this person replied, and here is what they said" twice is
 * one event however far apart the clicks are, and the useful effect (stopping
 * live cadences) is idempotent. A genuine second reply with different text
 * gets a different key and records normally.
 */
function manualEventId(prospectId: number, body: string | null): string {
  return createHash("sha256")
    .update(`${prospectId}|${body ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

function isDashboardOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const allowed = new Set([new URL(req.url).origin]);
  const vite = process.env["VITE_DEV_SERVER_URL"];
  if (vite) {
    try {
      allowed.add(new URL(vite).origin);
    } catch {
      // Invalid dev configuration grants no extra origin.
    }
  }
  return allowed.has(origin);
}

function accepted(result: Omit<LinkedInReplyResult, "accepted">): LinkedInReplyResult {
  return { accepted: true, ...result };
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
