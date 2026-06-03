import { getLedger, type QueueRow, type QueueStatus } from "@oneshot-gtm/core";
import { drainQueue } from "@oneshot-gtm/find";
import { enrollInCadence, sendDraftedEmail } from "@oneshot-gtm/plays";
import type {
  DrainRequest,
  DrainResult,
  LastDraft,
  QueueCounts,
  QueueRowView,
  RunPlayRequest,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { dispatchPlay } from "./_play-dispatch.ts";

function toView(row: QueueRow): QueueRowView {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = row.payload_json;
  }
  let lastDraft: LastDraft | null = null;
  if (row.last_draft_json) {
    try {
      const parsed = JSON.parse(row.last_draft_json) as Partial<LastDraft>;
      // Defensive shape check — older rows or future schema drift
      // shouldn't crash the queue listing.
      if (parsed && typeof parsed.subject === "string" && typeof parsed.body === "string") {
        lastDraft = {
          subject: parsed.subject,
          body: parsed.body,
          flags: Array.isArray(parsed.flags) ? parsed.flags : [],
          sent: parsed.sent === true,
          receiptIds: Array.isArray(parsed.receiptIds) ? parsed.receiptIds : [],
          dryRun: parsed.dryRun === true,
          draftedAt: typeof parsed.draftedAt === "string" ? parsed.draftedAt : "",
        };
      }
    } catch {
      lastDraft = null;
    }
  }
  return {
    id: row.id,
    playName: row.play_name,
    payload,
    dedupeKey: row.dedupe_key,
    source: row.source,
    status: row.status,
    foundAt: row.found_at,
    reviewedAt: row.reviewed_at,
    sentAt: row.sent_at,
    notes: row.notes,
    prospectId: row.prospect_id,
    lastDraft,
    lastDraftedAt: row.last_drafted_at,
  };
}

export function listQueueRoute(req: Request): Response {
  const url = new URL(req.url);
  const playName = url.searchParams.get("play") ?? undefined;
  const status = (url.searchParams.get("status") ?? undefined) as QueueStatus | undefined;
  const limit = Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200);
  const ledger = getLedger();
  const filterArgs: { playName?: string; status?: QueueStatus; limit?: number } = { limit };
  if (playName) filterArgs.playName = playName;
  if (status) filterArgs.status = status;
  const rows = ledger.listQueue(filterArgs);
  const counts: QueueCounts = ledger.queueCounts();
  return jsonResponse({ rows: rows.map(toView), counts }, 200, req);
}

export async function approveQueueRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  ledger.setQueueStatus({ id, status: "approved" });
  return jsonResponse({ ok: true }, 200, req);
}

export async function rejectQueueRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  let body: { reason?: string } = {};
  try {
    body = (await req.json()) as { reason?: string };
  } catch {
    // empty body is fine
  }
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  ledger.setQueueStatus(
    body.reason ? { id, status: "rejected", notes: body.reason } : { id, status: "rejected" },
  );
  return jsonResponse({ ok: true }, 200, req);
}

export async function approveAllRoute(req: Request): Promise<Response> {
  let body: { play?: string } = {};
  try {
    body = (await req.json()) as { play?: string };
  } catch {
    // empty body is fine
  }
  const ledger = getLedger();
  const n = ledger.approveAllPending(body.play ? { playName: body.play } : {});
  return jsonResponse({ approved: n }, 200, req);
}

export async function drainQueueRoute(req: Request): Promise<Response> {
  let body: DrainRequest;
  try {
    body = (await req.json()) as DrainRequest;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (!body.playName) return jsonResponse({ error: "playName required" }, 400, req);
  const result = await drainQueue({
    playName: body.playName,
    limit: body.limit ?? 10,
    dryRun: !!body.dryRun,
    ...(body.senderCohort ? { senderCohort: body.senderCohort } : {}),
    ...(body.freeForCohortOffer ? { freeForCohortOffer: body.freeForCohortOffer } : {}),
  });
  const view: DrainResult = {
    drained: result.drained,
    sent: result.sent,
    errors: result.errors,
  };
  return jsonResponse(view, 200, req);
}

/**
 * Re-draft a single queue row in PREVIEW mode and overwrite its persisted
 * draft. Always dry-run: enrichment is skipped and nothing is sent, even
 * when the fresh draft is lint-clean. Lets the founder re-roll a held or
 * unsatisfying draft from /queue without leaving the page or risking a
 * send. The new draft replaces `last_draft_json` so the UI shows it on the
 * next queue refetch.
 */
export async function regenerateDraftRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);

  let target: unknown;
  try {
    target = JSON.parse(row.payload_json);
  } catch {
    return jsonResponse({ error: "row payload is not valid JSON" }, 400, req);
  }

  // Carry through any per-play extras the payload happens to hold. Only
  // accelerator-batch needs senderCohort, which usually isn't on the row —
  // dispatchPlay then throws a clear error, surfaced here as a 400.
  const payloadObj = (target && typeof target === "object" ? target : {}) as Record<
    string,
    unknown
  >;
  const body: RunPlayRequest = {
    dryRun: true,
    targets: [target],
    ...(typeof payloadObj["senderCohort"] === "string"
      ? { senderCohort: payloadObj["senderCohort"] }
      : {}),
    ...(typeof payloadObj["freeForCohortOffer"] === "string"
      ? { freeForCohortOffer: payloadObj["freeForCohortOffer"] }
      : {}),
  };

  let drafted: Awaited<ReturnType<typeof dispatchPlay>>;
  try {
    drafted = await dispatchPlay(row.play_name, body);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 400, req);
  }
  const draft = drafted[0];
  if (!draft) return jsonResponse({ error: "no draft produced" }, 500, req);

  ledger.setQueueDraft({
    id,
    draft: {
      subject: draft.subject,
      body: draft.body,
      flags: draft.flags,
      sent: false,
      receiptIds: [],
      dryRun: true,
    },
  });

  const out: LastDraft = {
    subject: draft.subject,
    body: draft.body,
    flags: draft.flags,
    sent: false,
    receiptIds: [],
    dryRun: true,
    draftedAt: new Date().toISOString(),
  };
  return jsonResponse(out, 200, req);
}

/**
 * Send the row's already-reviewed draft VERBATIM — the persisted
 * `last_draft_json` subject/body, no LLM re-roll. This is the review-then-send
 * model: the founder regenerates until the draft is clean, then sends exactly
 * that. Routes through `sendDraftedEmail` (the canonical send: core sendEmail
 * applies HTML + from_name formatting, records the sequence event, upserts the
 * prospect), then enrolls the cadence and flips the row to `sent`. Requires a
 * clean (lint-flag-free), not-yet-sent draft.
 */
export async function sendDraftRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
  if (row.status === "sent") return jsonResponse({ error: "row already sent" }, 400, req);
  if (!row.last_draft_json) {
    return jsonResponse({ error: "no draft to send — regenerate a draft first" }, 400, req);
  }

  let parsed: Partial<LastDraft>;
  try {
    parsed = JSON.parse(row.last_draft_json) as Partial<LastDraft>;
  } catch {
    return jsonResponse({ error: "stored draft is not valid JSON" }, 400, req);
  }
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
  if (!subject || !body) {
    return jsonResponse({ error: "stored draft is empty — regenerate first" }, 400, req);
  }
  if (flags.length > 0) {
    return jsonResponse(
      { error: "draft has lint flags — regenerate to clear them before sending" },
      400,
      req,
    );
  }
  if (parsed.sent === true) return jsonResponse({ error: "draft already sent" }, 400, req);

  let payload: Record<string, unknown> = {};
  try {
    const p = JSON.parse(row.payload_json);
    if (p && typeof p === "object") payload = p as Record<string, unknown>;
  } catch {
    // fall through — handled by the missing-email check below
  }
  const str = (k: string): string | null => (typeof payload[k] === "string" ? payload[k] : null);
  const email = str("email") ?? str("founderEmail");
  if (!email) return jsonResponse({ error: "row has no recipient email" }, 400, req);

  let result: Awaited<ReturnType<typeof sendDraftedEmail>>;
  try {
    result = await sendDraftedEmail({
      playName: row.play_name,
      to: email,
      draft: { subject, body },
      flags: [],
      prospectMeta: {
        name: str("name") ?? str("founderName"),
        email,
        company: str("company"),
        linkedin_url: str("linkedinUrl"),
        phone: str("phone"),
        source: row.play_name,
      },
      dryRun: false,
    });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message ?? "send failed" }, 400, req);
  }
  if (!result.sent) return jsonResponse({ error: "send did not complete" }, 500, req);

  const prospect = ledger.findProspectByEmail(email);
  if (prospect) enrollInCadence({ prospectId: prospect.id, playName: row.play_name });
  ledger.setQueueStatus({ id, status: "sent" });
  ledger.setQueueDraft({
    id,
    draft: { subject, body, flags: [], sent: true, receiptIds: result.receiptIds, dryRun: false },
  });

  return jsonResponse({ sent: true, receiptIds: result.receiptIds }, 200, req);
}
