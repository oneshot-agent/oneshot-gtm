import { getLedger, logEvent } from "@oneshot-gtm/core";
import { isDuplicate } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistPending, registerPendingRetry } from "./_pending.ts";
import {
  agendaItemMatchesKeywords,
  cityToLegistarSlug,
  fetchBodyContact,
  fetchCityEvents,
  fetchEventItems,
  type LegistarEvent,
  type LegistarEventItem,
} from "./_civic-legistar.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "civic-agenda";
const SOURCE = "find:civic-agenda";
/**
 * Rough per-call LLM cost for the `icpFilter` classifier — same estimate
 * documented (but never applied) at job-change.ts's and show-hn.ts's call
 * sites. Those finders have a real downstream paid call to fall back on, but
 * this finder's only network call after icpFilter is the free, keyless
 * Legistar `OfficeRecords` contact lookup (see resolveAndEnqueueAgendaItem's
 * docstring) — icpFilter is the ONLY spend source here. Leaving it out of
 * `result.costUsd` left `opts.maxCostUsd` fully inert: costUsd never left 0,
 * so a configured cap could never halt a run regardless of how many paid
 * classifier calls it made.
 */
const ICP_FILTER_COST_ESTIMATE_USD = 0.001;

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
  const outcome = await fetchBodyContact(candidate.slug, candidate.event.eventBodyId);
  if (!outcome.ok) {
    // Genuine platform error (network/5xx/429) on the free Legistar contact
    // lookup — retryable, unlike a body that simply publishes no email.
    return "platform-error";
  }
  const contact = outcome.contact;
  if (!contact) {
    // The body really does publish no member email (or a non-retryable 4xx
    // like an unknown body id) — not a fetch failure. Treat as a drop, not
    // a retry: retrying a body with no email will never resolve, and a run
    // that persisted every silent body would grow the pending table forever.
    return "dropped";
  }
  // Cross-play + same-contact email dedupe, AFTER the contact is known:
  // two distinct agenda items from the same body (different item-level
  // dedupeKeys) resolve to the identical office-holder contact, so the
  // item-scoped `dedupeKey` alone can't catch the second one — same
  // reasoning as gov-solicitation.ts's `resolveAndEnqueueNotice`.
  if (isDuplicate({ playName: "civic-pilot", dedupeKey, prospectEmail: contact.email })) {
    return "duplicate";
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
    const events = await fetchCityEvents(slug, sinceDays, city);
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
  // Bounded to the first `limit` gated candidates: `limit` is a cap on
  // candidates CONSIDERED (and therefore on paid icpFilter calls), not on
  // successful enqueues — duplicates, rejections, contactless bodies, and
  // classifier failures don't consume it, so an unbounded `gated` array
  // could otherwise trigger icpFilter for every keyword match regardless of
  // how small `limit` is.
  for (const candidate of gated.slice(0, Math.max(0, limit))) {
    if (result.enqueued >= limit) break;
    const dedupeKey = dedupeKeyFor(candidate);
    if (
      ledger.isQueueDuplicate("civic-pilot", dedupeKey) ||
      ledger.isPendingResolution(PLAY_NAME, dedupeKey)
    ) {
      result.droppedDuplicate++;
      continue;
    }

    // Compare the PROSPECTIVE cost (current spend + this candidate's paid
    // icpFilter call, if one will actually happen) against the cap — not
    // just the spend accrued so far. icpFilter is the only cost source in
    // this finder, and it's free (no LLM call) when `icp` is null, so the
    // estimate is 0 in that case. Checking post-hoc spend alone would let a
    // single call through whenever `0 < maxCostUsd < ICP_FILTER_COST_ESTIMATE_USD`,
    // since costUsd is still 0 right up until this call runs.
    //
    // BELOW the duplicate check on purpose: a duplicate never reaches
    // icpFilter, so its prospective cost is zero. Guarding above it halted
    // the whole run on a candidate that would not have spent anything.
    if (
      opts.maxCostUsd != null &&
      result.costUsd + (icp ? ICP_FILTER_COST_ESTIMATE_USD : 0) > opts.maxCostUsd
    ) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }

    const filter = await icpFilter({
      icp,
      candidate: {
        title: candidate.item.title,
        summary: `${candidate.event.eventBodyName ?? "a city body"} in ${candidate.city}`,
      },
    });
    // icpFilter is a pass-through with no LLM call when no ICP is configured
    // (see _filter.ts) — only count spend once an ICP is actually set, or a
    // no-ICP dry sweep would falsely trip maxCostUsd.
    if (icp) result.costUsd += ICP_FILTER_COST_ESTIMATE_USD;
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
