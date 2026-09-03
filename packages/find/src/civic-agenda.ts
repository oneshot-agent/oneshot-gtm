import { getLedger, logEvent } from "@oneshot-gtm/core";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistPending, registerPendingRetry } from "./_pending.ts";
import {
  agendaItemMatchesKeywords,
  cityToLegistarSlug,
  fetchBodyContact,
  fetchCityEvents,
  fetchEventItems,
  type LegistarContact,
  type LegistarEvent,
  type LegistarEventItem,
} from "./_civic-legistar.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "civic-agenda";
const SOURCE = "find:civic-agenda";

export interface CivicAgendaFinderOpts extends RunOpts {
  /** City names mapped to Legistar clients (see `_civic-legistar.ts`). REQUIRED via readiness gate. */
  cities?: string[];
  /** Free keyword gate on agenda item titles, before any paid call. REQUIRED via readiness gate. */
  keywords?: string[];
  /** Forward-looking window in days. Default 30. */
  sinceDays?: number;
  /** Founder's one-line pitch, threaded to the play. REQUIRED via readiness gate. */
  yourEdge?: string;
}

interface AgendaCandidate {
  city: string;
  slug: string;
  event: LegistarEvent;
  item: LegistarEventItem;
}

interface CivicAgendaTarget {
  city: string;
  agendaItemTitle: string;
  meetingBody: string;
  meetingDate: string;
  meetingTime?: string;
  meetingUrl?: string;
  name: string;
  email: string;
  role?: string;
  phone?: string;
  yourEdge: string;
}

function dedupeKeyFor(candidate: AgendaCandidate): string {
  return `${candidate.slug}:${candidate.event.eventId}:${candidate.item.eventItemId}`;
}

/**
 * Resolve + enqueue one already keyword-and-ICP-gated agenda item. Shared by
 * the live run loop and the outage retry handler. The only network call is
 * the plain (keyless) Legistar `OfficeRecords` lookup — no OneShot SDK spend,
 * since the body itself publishes the contact.
 */
async function resolveAndEnqueueAgendaItem(
  candidate: AgendaCandidate,
  yourEdge: string,
): Promise<"enqueued" | "duplicate" | "dropped" | "platform-error"> {
  const ledger = getLedger();
  const dedupeKey = dedupeKeyFor(candidate);
  let contact: LegistarContact | null;
  try {
    contact = await fetchBodyContact(candidate.slug, candidate.event.eventBodyId);
  } catch {
    // fetchBodyContact never throws by contract, but a defensive catch here
    // still routes any surprise into the retryable path rather than a drop.
    return "platform-error";
  }
  if (!contact) {
    // Either the fetch genuinely failed (network/5xx — indistinguishable from
    // "no one on this body lists an email" by design; see _civic-legistar.ts)
    // or the body really does publish no member email. Treat as a drop, not
    // a retry: retrying a body with no email will never resolve, and a run
    // that persisted every silent body would grow the pending table forever.
    return "dropped";
  }
  const target: CivicAgendaTarget = {
    city: candidate.city,
    agendaItemTitle: candidate.item.title,
    meetingBody: candidate.event.eventBodyName ?? "",
    meetingDate: candidate.event.eventDateIso.slice(0, 10),
    ...(candidate.event.eventTime ? { meetingTime: candidate.event.eventTime } : {}),
    ...(candidate.event.eventInSiteUrl ? { meetingUrl: candidate.event.eventInSiteUrl } : {}),
    name: contact.fullName,
    email: contact.email,
    ...(contact.title ? { role: contact.title } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    yourEdge,
  };
  const id = enqueueScoredTarget(ledger, {
    playName: "civic-pilot",
    payload: target,
    dedupeKey,
    source: SOURCE,
    notes:
      `${candidate.city} — ${candidate.event.eventBodyName ?? "meeting"} — ${candidate.item.title}`.slice(
        0,
        300,
      ),
  });
  return id != null ? "enqueued" : "duplicate";
}

export async function runCivicAgendaFinder(opts: CivicAgendaFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const seenCities = new Set<string>();
  const cities = (opts.cities ?? [])
    .map((c) => c.trim())
    .filter((c) => {
      const key = c.toLowerCase();
      if (!c || seenCities.has(key)) return false;
      seenCities.add(key);
      return true;
    });
  const keywords = (opts.keywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
  const sinceDays = opts.sinceDays ?? 30;
  const yourEdge = (opts.yourEdge ?? "").trim();
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  if (cities.length === 0) {
    result.halted = "set `cities` (e.g. ['New York', 'Chicago'])";
    return result;
  }
  if (keywords.length === 0) {
    result.halted = "set `keywords` (agenda item titles must contain one to be considered)";
    return result;
  }

  logEvent("finder.start", {
    name: PLAY_NAME,
    cities: cities.length,
    since_days: sinceDays,
    limit,
  });

  // Phase 1: discover events per city, then agenda items per event —
  // FREE keyword gate on the title before anything else, per city so one
  // dead Legistar client doesn't starve the rest.
  const gated: AgendaCandidate[] = [];
  let anyCityResolved = false;
  for (const city of cities) {
    const slug = cityToLegistarSlug(city);
    if (!slug) {
      logEvent("finder.skipped_unmapped_city", { name: PLAY_NAME, city }, "info");
      continue;
    }
    const events = await fetchCityEvents(slug, sinceDays);
    if (events == null) continue;
    anyCityResolved = true;
    for (const event of events) {
      const items = await fetchEventItems(slug, event.eventId);
      if (!items) continue;
      for (const item of items) {
        result.candidates++;
        if (!agendaItemMatchesKeywords(item.title, keywords)) continue;
        gated.push({ city, slug, event, item });
      }
    }
  }

  if (!anyCityResolved) {
    result.halted = `Legistar fetch failed for every mapped city (${cities.join(", ")})`;
    logEvent("finder.done", {
      name: PLAY_NAME,
      candidates: result.candidates,
      halted: result.halted,
    });
    return result;
  }

  // Phase 2: one paid LLM relevance call per keyword-surviving title — the
  // same pre-spend discipline as luma.ts's event-level icpFilter gate.
  for (const candidate of gated) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }

    const dedupeKey = dedupeKeyFor(candidate);
    if (
      ledger.isQueueDuplicate("civic-pilot", dedupeKey) ||
      ledger.isPendingResolution(PLAY_NAME, dedupeKey)
    ) {
      result.droppedDuplicate++;
      continue;
    }

    const filter = await icpFilter({
      icp,
      candidate: {
        title: candidate.item.title,
        summary: `${candidate.event.eventBodyName ?? "a city body"} in ${candidate.city}`,
      },
    });
    if (filter.match === null) {
      // Transient classifier failure — drop without persisting (same
      // reasoning as every other finder's icpFilter call site).
      result.droppedEnrichment++;
      continue;
    }
    if (!filter.match) {
      result.droppedIcp++;
      if (!opts.dryRun) {
        ledger.enqueueTarget({
          playName: "civic-pilot",
          payload: {
            city: candidate.city,
            agendaItemTitle: candidate.item.title,
            meetingBody: candidate.event.eventBodyName,
          },
          dedupeKey,
          source: SOURCE,
          initialStatus: "rejected",
          notes: `auto: ICP — ${filter.reason}`,
        });
      }
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    const outcome = await resolveAndEnqueueAgendaItem(candidate, yourEdge);
    if (outcome === "enqueued") result.enqueued++;
    else if (outcome === "duplicate") result.droppedDuplicate++;
    else if (outcome === "platform-error") {
      // Backend outage on the free Legistar contact lookup — the meeting is
      // heard and gone, so a re-scan can't recover this item. Persist.
      persistPending({
        playName: PLAY_NAME,
        dedupeKey,
        source: SOURCE,
        raw: { candidate, yourEdge },
      });
      result.droppedEnrichment++;
    } else result.droppedEnrichment++;
  }

  logEvent("finder.done", {
    name: PLAY_NAME,
    candidates: result.candidates,
    enqueued: result.enqueued,
    dropped_icp: result.droppedIcp,
    dropped_dup: result.droppedDuplicate,
    dropped_enrich: result.droppedEnrichment,
    halted: result.halted ?? null,
  });
  return result;
}

// Outage retry: re-run the contact lookup + enqueue for a persisted agenda
// item. The meeting itself has aged out of "upcoming" by the time a retry
// fires, but the office-holder contact and the ICP verdict already reached —
// this is purely finishing a resolution the backend, not the source, failed.
registerPendingRetry(PLAY_NAME, async (raw) => {
  const { candidate, yourEdge } = raw as { candidate: AgendaCandidate; yourEdge: string };
  const outcome = await resolveAndEnqueueAgendaItem(candidate, yourEdge);
  return outcome === "enqueued"
    ? "enqueued"
    : outcome === "platform-error"
      ? "platform-error"
      : "dropped";
});
