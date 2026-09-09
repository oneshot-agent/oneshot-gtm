import { demoFixture, demoMode, getLedger, loadConfig } from "@oneshot-gtm/core";
import type {
  ConfirmMeetingMatchRequest,
  DismissMeetingMatchRequest,
  LogMeetingOutcomeRequest,
  MeetingMatchStatusView,
  MeetingsResult,
  MeetingView,
} from "@oneshot-gtm/shared-types";
import type { MeetingRecord } from "@oneshot-gtm/core";
import { jsonResponse } from "../server.ts";

/**
 * Read-only + outcome-capture surface for the calendar ingest half of issue
 * #577. The queue UI clones the /inbox `awaitingReply` pattern: computed
 * server-side, split into "past meetings needing an outcome" and "matches
 * needing a founder decision".
 */

/** The match method rendered as a sentence, never the bare number — per the card. */
function matchReasonSentence(row: MeetingRecord): string | null {
  switch (row.match_method) {
    case "name_domain":
      return "same company domain and name";
    case "domain":
      return "unique prospect at the same company domain";
    case "name":
      return "same full name at a different domain";
    case "description":
      return "email found in the event description";
    default:
      return row.match_status === "exact" ? "matched by email address" : null;
  }
}

function toView(
  row: MeetingRecord,
  prospectById: Map<number, { name: string | null; email: string | null }>,
): MeetingView {
  const prospect = row.prospect_id != null ? prospectById.get(row.prospect_id) : undefined;
  const suggested =
    row.suggested_prospect_id != null ? prospectById.get(row.suggested_prospect_id) : undefined;
  let externalAttendees: string[] = [];
  if (row.external_attendees_json) {
    try {
      const parsed = JSON.parse(row.external_attendees_json) as unknown;
      if (Array.isArray(parsed)) externalAttendees = parsed.filter((x) => typeof x === "string");
    } catch {
      // corrupt row — render with no attendee list rather than throwing the whole page.
    }
  }
  return {
    calendarId: row.calendar_id,
    eventId: row.event_id,
    summary: row.summary,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    organizerEmail: row.organizer_email,
    externalAttendees,
    prospectId: row.prospect_id,
    prospectName: prospect?.name ?? null,
    prospectEmail: prospect?.email ?? null,
    suggestedProspectId: row.suggested_prospect_id,
    suggestedProspectName: suggested?.name ?? null,
    suggestedProspectEmail: suggested?.email ?? null,
    matchStatus: row.match_status as MeetingMatchStatusView,
    matchReason: matchReasonSentence(row),
    outcome: row.outcome as MeetingView["outcome"],
    outcomeNote: row.outcome_note,
  };
}

export async function listMeetingsRoute(req: Request): Promise<Response> {
  if (demoMode()) {
    const fixture = demoFixture<MeetingsResult>("meetings.json");
    return jsonResponse(fixture ?? { awaitingOutcome: [], needsReview: [] }, 200, req);
  }
  const cfg = loadConfig();
  if (!cfg.calendarIdentityId) {
    return jsonResponse({ awaitingOutcome: [], needsReview: [] }, 200, req);
  }
  const ledger = getLedger();
  const awaiting = ledger.listPendingOutcomeMeetings();
  const review = ledger.listMeetingsForReview();

  const prospectIds = new Set<number>();
  for (const row of [...awaiting, ...review]) {
    if (row.prospect_id != null) prospectIds.add(row.prospect_id);
    if (row.suggested_prospect_id != null) prospectIds.add(row.suggested_prospect_id);
  }
  const prospectById = new Map<number, { name: string | null; email: string | null }>();
  for (const id of prospectIds) {
    const p = ledger.getProspectById(id);
    if (p) prospectById.set(id, { name: p.name, email: p.email });
  }

  const result: MeetingsResult = {
    awaitingOutcome: awaiting.map((r) => toView(r, prospectById)),
    needsReview: review.map((r) => toView(r, prospectById)),
  };
  return jsonResponse(result, 200, req);
}

const VALID_OUTCOMES = new Set(["held", "no_show", "cancelled", "rescheduled"]);

export async function logMeetingOutcomeRoute(req: Request): Promise<Response> {
  const body = (await req.json()) as LogMeetingOutcomeRequest;
  if (!body.calendarId || !body.eventId) {
    return jsonResponse({ error: "calendarId and eventId are required" }, 400, req);
  }
  if (!VALID_OUTCOMES.has(body.outcome)) {
    return jsonResponse({ error: `invalid outcome '${body.outcome}'` }, 400, req);
  }
  const ledger = getLedger();
  if (!ledger.getMeeting(body.calendarId, body.eventId)) {
    return jsonResponse({ error: "meeting not found" }, 404, req);
  }
  ledger.setMeetingOutcome({
    calendarId: body.calendarId,
    eventId: body.eventId,
    outcome: body.outcome,
    note: body.note?.trim() || null,
  });
  return jsonResponse({ ok: true }, 200, req);
}

export async function confirmMeetingMatchRoute(req: Request): Promise<Response> {
  const body = (await req.json()) as ConfirmMeetingMatchRequest;
  if (!body.calendarId || !body.eventId || typeof body.prospectId !== "number") {
    return jsonResponse({ error: "calendarId, eventId and prospectId are required" }, 400, req);
  }
  const ledger = getLedger();
  if (!ledger.getMeeting(body.calendarId, body.eventId)) {
    return jsonResponse({ error: "meeting not found" }, 404, req);
  }
  if (!ledger.getProspectById(body.prospectId)) {
    return jsonResponse({ error: "prospect not found" }, 404, req);
  }
  ledger.confirmMeetingMatch(body.calendarId, body.eventId, body.prospectId);
  return jsonResponse({ ok: true }, 200, req);
}

export async function dismissMeetingMatchRoute(req: Request): Promise<Response> {
  const body = (await req.json()) as DismissMeetingMatchRequest;
  if (!body.calendarId || !body.eventId) {
    return jsonResponse({ error: "calendarId and eventId are required" }, 400, req);
  }
  const ledger = getLedger();
  if (!ledger.getMeeting(body.calendarId, body.eventId)) {
    return jsonResponse({ error: "meeting not found" }, 404, req);
  }
  ledger.dismissMeetingMatch(body.calendarId, body.eventId);
  return jsonResponse({ ok: true }, 200, req);
}
