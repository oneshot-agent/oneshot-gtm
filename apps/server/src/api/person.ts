import { getLedger, readPersonHalf, type ProspectRecord, type QueueRow } from "@oneshot-gtm/core";
import type { DossierRoleView, PersonView, QueueDossierView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { buildProspectTimeline } from "./_prospect-timeline.ts";
import { viewsForRows } from "./cadences.ts";
import { buildQueueDossier } from "./queue-dossier.ts";
import { contactFlags, deliveriesForEvents, resolveProspectId } from "./queue.ts";

function positiveId(raw: string | null): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parsePayload(row: QueueRow | null): unknown {
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null; // an unreadable payload has no dossier
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Fill what the row and the research cache left empty from the prospect's
 * own researched record (the person half of `dossier_json`): the same facts
 * the call brief and the follow-ups are written from, so the pane never says
 * "no research" about someone the brief knows, nor leaves out a bio the
 * brief was given. A person half is the record
 * `personRecordFromResearch` writes, or an older enrichment of the same shape.
 */
export function withProspectResearch(
  view: QueueDossierView,
  dossierJson: string | null | undefined,
): QueueDossierView {
  // Complete research can still lack a bio or a location: those are filled
  // too, while everything the research holds wins and its status stays.
  const half = readPersonHalf(dossierJson);
  if (!half || typeof half !== "object" || Array.isArray(half)) return view;
  const h = half as Record<string, unknown>;
  const orgs = Array.isArray(h["organizations"]) ? h["organizations"] : [];
  const experience: DossierRoleView[] = orgs.flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const r = o as Record<string, unknown>;
    const company = text(r["name"]);
    return company
      ? [
          {
            company,
            title: text(r["title"]),
            startDate: text(r["startDate"]),
            endDate: text(r["endDate"]),
            current: r["is_current"] === true || r["current"] === true,
          },
        ]
      : [];
  });
  const person = {
    ...view.person,
    title: view.person.title ?? text(h["title"]),
    company: view.person.company ?? text(h["company"]),
    location: view.person.location ?? text(h["location"]),
    summary: view.person.summary ?? text(h["summary"]),
    linkedinUrl: view.person.linkedinUrl ?? text(h["linkedinUrl"]),
  };
  const filled =
    person.summary !== view.person.summary ||
    person.location !== view.person.location ||
    (view.experience.length === 0 && experience.length > 0);
  if (!filled) return view;
  return {
    ...view,
    status: view.status === "none" ? "summary-only" : view.status,
    researchedAt: view.researchedAt ?? text(h["researchedAt"]),
    person,
    experience: view.experience.length > 0 ? view.experience : experience,
  };
}

/**
 * GET /api/person?prospect=ID or ?queue=ID. One person for every page that
 * opens one: who they are, the cached research, whether they may be
 * contacted, their cadences, and every touch with its body. Reads only:
 * nothing here buys research or calls a provider.
 */
export function personRoute(req: Request): Response {
  const params = new URL(req.url).searchParams;
  const rawProspect = params.get("prospect");
  const rawQueue = params.get("queue");
  if ((rawProspect == null) === (rawQueue == null))
    return jsonResponse({ error: "pass exactly one of prospect or queue" }, 400, req);
  const id = positiveId(rawProspect ?? rawQueue);
  if (id == null) return jsonResponse({ error: "bad id" }, 400, req);

  const ledger = getLedger();
  let row: QueueRow | null;
  let prospect: ProspectRecord | null;
  if (rawQueue != null) {
    row = ledger.getQueueRow(id);
    if (!row) return jsonResponse({ error: `row #${id} not found` }, 404, req);
    const prospectId = resolveProspectId(ledger, row);
    prospect = prospectId != null ? ledger.getProspectById(prospectId) : null;
  } else {
    prospect = ledger.getProspectById(id);
    if (!prospect) return jsonResponse({ error: `prospect #${id} not found` }, 404, req);
    row = ledger.getQueueRowForProspect(id);
  }

  const sequenceEvents = prospect ? ledger.listAllSequenceEventsForProspect(prospect.id) : [];
  const replies = prospect ? ledger.listInboxRepliesForProspect(prospect.id) : [];
  const channelEvents = prospect ? ledger.listChannelEventsForProspect(prospect.id) : [];
  // Rows linked by id and rows that name their email, as a row resolves to
  // a prospect; the opened row is added if neither matched it.
  const rows = prospect ? ledger.listQueueRowsForProspect(prospect.id, prospect.email) : [];
  if (row && !rows.some((r) => r.id === row.id)) rows.push(row);

  const body: PersonView = {
    prospect: prospect
      ? {
          id: prospect.id,
          name: prospect.name,
          email: prospect.email,
          title: prospect.title,
          company: prospect.company,
          linkedinUrl: prospect.linkedin_url,
          icpVerdict: prospect.icp_verdict,
          icpVerdictReason: prospect.icp_verdict_reason,
        }
      : null,
    queueId: row?.id ?? null,
    dossier: withProspectResearch(
      buildQueueDossier(
        parsePayload(row),
        prospect ? [{ url: prospect.linkedin_url, email: prospect.email }] : [],
      ),
      prospect?.dossier_json,
    ),
    flags: contactFlags(ledger, row, prospect, { replies, channelEvents, sequenceEvents }),
    cadences: prospect ? viewsForRows(ledger.listCadencesForProspect(prospect.id)) : [],
    touches: buildProspectTimeline({
      rows,
      sequenceEvents,
      replies,
      channelEvents,
      outcomes: prospect ? ledger.listDealOutcomesForProspect(prospect.id) : [],
      deliveries: deliveriesForEvents(ledger, sequenceEvents),
      calls: prospect ? ledger.listCallsForProspect(prospect.id) : [],
      withBodies: true,
    }),
  };
  return jsonResponse(body, 200, req);
}
