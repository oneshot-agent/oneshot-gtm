import {
  enrichProfile,
  formatLocalEventTime,
  getLedger,
  logEvent,
  parallelMap,
  resolveEventZone,
  webRead,
  webSearch,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { LumaEventsTarget } from "@oneshot-gtm/plays";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { resolveVerifyEnrichQualify } from "./_contact.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { qualifyPreSpend } from "./_qualify.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import { persistPending, registerPendingRetry } from "./_pending.ts";
import { fetchAuthedGuestList, mergeAttendees } from "./_luma-auth.ts";
import {
  cityToSlug,
  eventNameMatchesTopics,
  fetchCityEvents,
  fetchEventDetails,
} from "./_luma-discover.ts";
import type { LumaEventExtract, LumaPublicAttendee, RunOpts } from "./_types.ts";

const PLAY_NAME = "luma-events";
const SOURCE = "find:luma-events";
/** Cap per-event LLM extract input — Luma event pages are usually under 8k chars. */
const READ_MARKDOWN_SLICE = 12000;
/** Sane upper bound — no event we care about has >30 public attendees. */
const MAX_ATTENDEES_PER_EVENT = 30;

export interface LumaFinderOpts extends RunOpts {
  /** Topic phrases to combine with cities (e.g. ["AI", "founders"]). REQUIRED via readiness gate. */
  topics?: string[];
  /** City names to scope each search (e.g. ["San Francisco", "New York"]). REQUIRED via readiness gate. */
  cities?: string[];
  /** Founder's one-line angle, threaded to the play. REQUIRED via readiness gate. */
  yourEdge?: string;
  /**
   * Forward-looking window in days. Events further out than this are dropped
   * (founder almost never wants to pitch a Q4 attendee in June).
   */
  sinceDays?: number;
}

interface SearchHit {
  url: string;
  title: string;
  description: string;
}

interface CitySearchHit extends SearchHit {
  discoveryCity: string;
}

interface AttendeeWithEvent {
  attendee: LumaPublicAttendee;
  discoveryCity: string;
  event: {
    url: string;
    title: string;
    dateIso: string;
    /** IANA zone the event page stated, when it stated one. */
    timezone: string | null;
    city: string;
    description: string;
  };
}

/** Fairly interleave buckets; sparse buckets surrender unused capacity. */
function roundRobin<T>(buckets: ReadonlyMap<string, readonly T[]>, cap: number): T[] {
  const out: T[] = [];
  const cursors = new Map<string, number>();
  let added = true;
  while (out.length < cap && added) {
    added = false;
    for (const [key, items] of buckets) {
      if (out.length >= cap) break;
      const cursor = cursors.get(key) ?? 0;
      const item = items[cursor];
      if (item === undefined) continue;
      out.push(item);
      cursors.set(key, cursor + 1);
      added = true;
    }
  }
  return out;
}

/**
 * Extract the single-segment slug from a Luma event URL. Returns null when
 * the URL isn't a single-event page. Used to address Luma's internal API
 * (`api.lu.ma/event/get-guest-list?event_api_id=<slug>`) when the founder
 * has set `LUMA_SESSION_COOKIE`.
 */
export function lumaEventSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^(www\.)?(luma\.com|lu\.ma)$/.test(u.hostname)) return null;
    const segments = u.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length !== 1) return null;
    return segments[0] ?? null;
  } catch {
    return null;
  }
}

export function looksLikeLumaEventUrl(url: string): boolean {
  // Accept luma.com/<slug> and lu.ma/<slug>. Reject calendar / category pages.
  try {
    const u = new URL(url);
    if (!/^(www\.)?(luma\.com|lu\.ma)$/.test(u.hostname)) return false;
    // Calendar pages: ?k=c; category/city: ?k=t or ?k=p. Real events have no
    // `k` query param and a single-path-segment slug.
    if (u.searchParams.has("k")) return false;
    const segments = u.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length !== 1) return false;
    // Reserved discovery paths.
    const reserved = new Set([
      "discover",
      "home",
      "events",
      "calendars",
      "create",
      "login",
      "signup",
      "user",
    ]);
    return !reserved.has(segments[0]!.toLowerCase());
  } catch {
    return false;
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Literal month-name tokens spanning [now, now + sinceDays] — e.g. "June 2026"
 * or "June 2026 July 2026" across a boundary. Appended to the discovery query
 * so search ranks upcoming Luma pages (which render the month) above stale
 * ones. A relative phrase like "next 7 days" is useless to an index that has
 * no notion of today; a literal month the event page actually shows is not.
 */
function upcomingMonths(sinceDays: number): string {
  const start = new Date(Date.now());
  const end = new Date(Date.now() + sinceDays * 24 * 3600 * 1000);
  // Walk by month index (not by adding days) so a multi-month window names
  // EVERY month it spans — June+July+August, not just the two endpoints.
  const endIdx = end.getFullYear() * 12 + end.getMonth();
  const months: string[] = [];
  for (let y = start.getFullYear(), m = start.getMonth(); y * 12 + m <= endIdx; ) {
    months.push(`${MONTHS[m]!} ${y}`);
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return months.join(" ");
}

export async function runLumaFinder(opts: LumaFinderOpts): Promise<{
  source: string;
  candidates: number;
  droppedIcp: number;
  droppedDuplicate: number;
  droppedEnrichment: number;
  droppedRole: number;
  enqueued: number;
  costUsd: number;
  halted?: string;
}> {
  const limit = opts.limit ?? 25;
  const sinceDays = opts.sinceDays ?? 14;
  const topics = (opts.topics ?? []).filter((t) => t.trim().length > 0);
  const seenCities = new Set<string>();
  const cities = (opts.cities ?? [])
    .map((raw) => raw.trim())
    .filter((city) => {
      const key = city.toLocaleLowerCase();
      if (!city || seenCities.has(key)) return false;
      seenCities.add(key);
      return true;
    });
  const yourEdge = (opts.yourEdge ?? "").trim();
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const extractSystem = loadPrompt("luma-event-extract");
  // Optional v2 auth mode. When unset, public-only path runs as before.
  const sessionCookie = (process.env["LUMA_SESSION_COOKIE"] ?? "").trim();
  if (!sessionCookie) {
    logEvent(
      "luma-events.cookie_unset",
      {
        hint: "optional LUMA_SESSION_COOKIE only unlocks full guest lists for events YOU host; hosts + featured guests are pulled publicly regardless",
      },
      "info",
    );
  }

  const result = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    droppedRole: 0,
    enqueued: 0,
    costUsd: 0,
    halted: undefined as string | undefined,
  };

  // Phase 1: discover event URLs via webSearch over each (topic × city) pair.
  // Bias toward UPCOMING events: a search index has no notion of "today", so a
  // relative phrase ("next 7 days") doesn't work — but Luma event pages render
  // the literal month + year, so naming the month(s) the forward window spans
  // (plus "upcoming") ranks future pages above last quarter's. The date defense
  // after extract still enforces the exact window.
  const windowMonths = upcomingMonths(sinceDays);
  const seenUrls = new Set<string>();
  const cityHits = new Map<string, CitySearchHit[]>(cities.map((city) => [city, []]));
  const discoveryStats = new Map(cities.map((city) => [city, { discovered: 0, inWindow: 0 }]));
  const cap = limit * 3;
  const windowStart = Date.now() - 24 * 3600 * 1000;
  const windowEnd = Date.now() + sinceDays * 24 * 3600 * 1000;

  const pushHit = (city: string, url: string, title: string, description: string): boolean => {
    const canonical = url.split("?")[0]!.replace(/\/$/, "");
    if (seenUrls.has(canonical)) return false;
    if (topics.length > 0 && !eventNameMatchesTopics(title, topics)) {
      logEvent("finder.skipped_off_topic", { name: PLAY_NAME, url: canonical, title, city });
      return false;
    }
    seenUrls.add(canonical);
    cityHits.get(city)!.push({ url: canonical, title, description, discoveryCity: city });
    return true;
  };

  // webSearch fallback for a single city — used when the city isn't a mapped
  // Luma hub or its page can't be parsed. This path surfaces search-INDEXED
  // (older) pages, which is why the date defense downstream still matters.
  const webSearchCity = async (city: string): Promise<void> => {
    for (const topic of topics) {
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) return;
      const query = `site:luma.com "${topic}" "${city}" upcoming event ${windowMonths}`;
      try {
        const search = await webSearch(
          { query, maxResults: Math.min(10, limit) },
          { playName: PLAY_NAME, decisionContext: { source: "finder", topic, city } },
        );
        result.costUsd += search.result.cost ?? 0;
        for (const hit of search.result.results ?? []) {
          if (!hit.url) continue;
          // Gate on the ORIGINAL URL — `looksLikeLumaEventUrl` inspects the
          // query string (`?k=t` / `?k=c` mark Luma's category + calendar
          // pages); canonicalizing first would strip those markers.
          if (!looksLikeLumaEventUrl(hit.url)) continue;
          discoveryStats.get(city)!.discovered++;
          pushHit(city, hit.url, hit.title, hit.description);
        }
      } catch (err) {
        logEvent(
          "error.swallowed",
          {
            kind: "luma-events.webSearch",
            topic,
            city,
            message_120: ((err as Error).message ?? "").slice(0, 120),
          },
          "warn",
        );
      }
    }
  };

  // Discovery-first: Luma's per-city page (`luma.com/<slug>`) lists UPCOMING
  // events directly with real start_at timestamps — geo-robust and free (a
  // plain fetch, no SDK spend). Window-filter here so Phase 2 only pays to read
  // genuinely-upcoming events. Fall back to webSearch per city when the city
  // isn't a mapped hub, the page won't parse, or nothing lands in the window.
  for (const city of cities) {
    const slug = cityToSlug(city);
    const discovered = slug ? await fetchCityEvents(slug) : null;
    if (discovered && discovered.length > 0) {
      const stats = discoveryStats.get(city)!;
      stats.discovered += discovered.length;
      let eligible = 0;
      for (const ev of discovered) {
        const ms = new Date(ev.startAtIso).getTime();
        if (!Number.isFinite(ms) || ms < windowStart || ms > windowEnd) continue;
        stats.inWindow++;
        if (pushHit(city, `https://luma.com/${ev.slug}`, ev.name, "")) eligible++;
      }
      logEvent(
        "luma-events.discover_ok",
        {
          name: PLAY_NAME,
          city,
          slug,
          found: discovered.length,
          in_window: stats.inWindow,
          eligible,
        },
        "info",
      );
      if (eligible > 0) continue;
    }
    await webSearchCity(city);
  }
  const hits = roundRobin(cityHits, cap);
  result.candidates = hits.length;

  logEvent(
    "luma-events.discovery_sampled",
    {
      name: PLAY_NAME,
      cap,
      total_selected: hits.length,
      by_city: Object.fromEntries(
        cities.map((city) => [
          city,
          {
            discovered: discoveryStats.get(city)?.discovered ?? 0,
            in_window: discoveryStats.get(city)?.inWindow ?? 0,
            eligible: cityHits.get(city)?.length ?? 0,
            selected: hits.filter((hit) => hit.discoveryCity === city).length,
          },
        ]),
      ),
    },
    "info",
  );

  // Event-level relevance criterion: one LLM call (below) weighs the founder's
  // ICP AND topics, on the event NAME, BEFORE any webRead — so we never pay to
  // read the dance-cardio / wine-tasting noise that city pages surface. This
  // replaces the old per-attendee ICP filter, which rejected even on-topic
  // attendees because Luma's public attendee data is too thin to judge.
  const relevanceCriteria = [
    icp,
    topics.length > 0 ? `Event must relate to: ${topics.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(". ");

  // Phase 2: topic/ICP gate → webRead + LLM extract per event, parallelized.
  // Each surviving event yields 0..N attendees; flatten into one work list.
  const concurrency = 3;
  const eventExtracts: Array<{ hit: CitySearchHit; extract: LumaEventExtract } | null> =
    await parallelMap(hits.slice(0, limit * 2), concurrency, async (hit) => {
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) return null;
      // Event-level relevance gate (topic + ICP in one call), on the name only.
      if (relevanceCriteria) {
        const ev = await icpFilter({
          icp: relevanceCriteria,
          candidate: { title: hit.title, url: hit.url },
        });
        if (ev.match === null) return null; // transient classifier failure → drop, no persist
        if (!ev.match) {
          result.droppedIcp++;
          logEvent(
            "finder.skipped_off_icp",
            {
              name: PLAY_NAME,
              url: hit.url,
              title: hit.title,
              reason_120: ev.reason.slice(0, 120),
            },
            "info",
          );
          return null;
        }
      }

      try {
        // Structured-first: the anonymous `api.lu.ma/url` JSON carries the
        // event meta AND each host/featured-guest's linkedin/website — exactly
        // what contact resolution needs and what the rendered page (webRead +
        // LLM extract) loses, since attendee cards only render names as text.
        // Free, so it replaces the paid webRead+extract whenever it succeeds;
        // any failure falls through to the webRead path below.
        let extract: LumaEventExtract;
        const eventSlug = lumaEventSlug(hit.url);
        const details = eventSlug ? await fetchEventDetails(eventSlug) : null;
        if (details && details.eventTitle && details.attendees.length > 0) {
          extract = {
            eventTitle: details.eventTitle,
            eventDateIso: details.eventDateIso,
            eventTimezone: details.eventTimezone,
            eventCity: details.eventCity,
            eventDescription: details.eventDescription,
            eventHasPassed: false, // the date defense below is the authority
            publicAttendees: details.attendees,
          };
          logEvent(
            "luma-events.details_ok",
            {
              name: PLAY_NAME,
              url: hit.url,
              attendees: details.attendees.length,
              with_linkedin: details.attendees.filter((a) => a.linkedinUrl).length,
            },
            "info",
          );
        } else {
          const read = await webRead(
            { url: hit.url },
            {
              playName: PLAY_NAME,
              decisionContext: { source: "finder", eventUrl: hit.url },
            },
          );
          result.costUsd += read.result.cost ?? 0;
          const payload: Record<string, unknown> = {
            url: hit.url,
            title: hit.title,
            description: hit.description,
            markdown: (read.result.markdown ?? "").slice(0, READ_MARKDOWN_SLICE),
          };
          const llm = await complete({
            messages: [
              { role: "system", content: extractSystem },
              { role: "user", content: JSON.stringify(payload) },
            ],
            temperature: 0.1,
            maxTokens: 1500,
          });
          extract = parseLumaEventExtract(llm.content);
        }
        if (!extract.eventTitle) {
          logEvent("finder.skipped_non_event", { name: PLAY_NAME, url: hit.url }, "info");
          return null;
        }
        if (extract.eventHasPassed) {
          logEvent(
            "finder.skipped_past_event",
            { name: PLAY_NAME, url: hit.url, eventTitle: extract.eventTitle },
            "info",
          );
          return null;
        }
        // Defense beyond LLM judgement: drop events with no parsable date OR
        // a date in the past. The play's date-humanizer needs a real ISO; an
        // empty `EVENT DATE` produces a worse hook than no email at all.
        if (!extract.eventDateIso) {
          logEvent(
            "finder.skipped_no_event_date",
            { name: PLAY_NAME, url: hit.url, eventTitle: extract.eventTitle },
            "info",
          );
          return null;
        }
        const eventMs = new Date(extract.eventDateIso).getTime();
        if (!Number.isFinite(eventMs) || eventMs < Date.now() - 24 * 3600 * 1000) {
          logEvent(
            "finder.skipped_past_event",
            {
              name: PLAY_NAME,
              url: hit.url,
              eventTitle: extract.eventTitle,
              eventDateIso: extract.eventDateIso,
              reason: "date defense",
            },
            "info",
          );
          return null;
        }
        // Forward-window cap: drop events that are too far out (founder rarely
        // wants to pitch a Q4 attendee in June). `sinceDays` is the cap.
        if (eventMs > Date.now() + sinceDays * 24 * 3600 * 1000) {
          logEvent(
            "finder.skipped_too_far_out",
            {
              name: PLAY_NAME,
              url: hit.url,
              eventTitle: extract.eventTitle,
              eventDateIso: extract.eventDateIso,
              sinceDays,
            },
            "info",
          );
          return null;
        }
        // v2 auth merge: when the founder's session cookie is set, fetch the
        // full guest list and merge it with the LLM-extracted public ones.
        // Auth wins on name collision (canonical source). Failures (no cookie,
        // expired, network blip, shape drift) return null — we keep the
        // public-only list. Gate the <2 check AFTER the merge so an
        // auth-unlocked event isn't dropped because the public extract was thin.
        if (sessionCookie) {
          const slug = lumaEventSlug(hit.url);
          if (slug) {
            const authed = await fetchAuthedGuestList(slug, sessionCookie);
            if (authed) {
              const before = extract.publicAttendees.length;
              const merged = mergeAttendees(extract.publicAttendees, authed);
              extract.publicAttendees = merged;
              logEvent(
                "finder.luma_auth.success",
                {
                  name: PLAY_NAME,
                  slug,
                  public_count: before,
                  authed_count: authed.length,
                  merged_count: merged.length,
                },
                "info",
              );
            }
          }
        }
        if (extract.publicAttendees.length < 2) {
          logEvent(
            "finder.skipped_no_public_guests",
            { name: PLAY_NAME, url: hit.url, eventTitle: extract.eventTitle },
            "info",
          );
          return null;
        }
        return { hit, extract };
      } catch (err) {
        logEvent(
          "error.swallowed",
          {
            kind: "luma-events.extract",
            url: hit.url,
            message_120: ((err as Error).message ?? "").slice(0, 120),
          },
          "warn",
        );
        return null;
      }
    });

  const attendeeEventBuckets = new Map(
    cities.map((city) => [city, new Map<string, AttendeeWithEvent[]>()]),
  );
  for (const item of eventExtracts) {
    if (!item) continue;
    const { hit, extract } = item;
    const eventCtx = {
      url: hit.url,
      title: extract.eventTitle ?? hit.title,
      dateIso: extract.eventDateIso ?? "",
      timezone: extract.eventTimezone ?? null,
      city: extract.eventCity ?? "",
      description: extract.eventDescription ?? "",
    };
    const eventAttendees: AttendeeWithEvent[] = [];
    for (const attendee of extract.publicAttendees.slice(0, MAX_ATTENDEES_PER_EVENT)) {
      if (!attendee.name || attendee.name.trim().length === 0) continue;
      eventAttendees.push({
        attendee,
        discoveryCity: hit.discoveryCity,
        event: eventCtx,
      });
    }
    attendeeEventBuckets.get(hit.discoveryCity)!.set(hit.url, eventAttendees);
  }
  const attendeeBuckets = new Map(
    cities.map((city) => {
      const eventBuckets = attendeeEventBuckets.get(city)!;
      const count = [...eventBuckets.values()].reduce((sum, bucket) => sum + bucket.length, 0);
      return [city, roundRobin(eventBuckets, count)] as const;
    }),
  );
  const attendeeCount = [...attendeeBuckets.values()].reduce(
    (sum, bucket) => sum + bucket.length,
    0,
  );
  const attendeesWork = roundRobin(attendeeBuckets, attendeeCount);
  logEvent(
    "luma-events.attendees_sampled",
    {
      name: PLAY_NAME,
      total: attendeesWork.length,
      by_city: Object.fromEntries(
        cities.map((city) => [city, attendeeBuckets.get(city)?.length ?? 0]),
      ),
    },
    "info",
  );

  // Phase 3: per-attendee contact resolution, concurrency 3 to bound SDK
  // burst. Soft halt via boxed flag (same pattern as _repo-pipeline): workers
  // check at the top of each iteration but several may pass before any flips
  // it — enrichment SPEND can overshoot by up to (concurrency-1) attendees.
  // The enqueue count itself stays exact via the synchronous re-check right
  // before enqueueTarget below.
  const phase3Halted = { value: false };
  const attemptsByCity = new Map(cities.map((city) => [city, 0]));
  await parallelMap(attendeesWork, 3, async (work) => {
    if (phase3Halted.value) return;
    if (result.enqueued >= limit) {
      phase3Halted.value = true;
      return;
    }
    attemptsByCity.set(work.discoveryCity, (attemptsByCity.get(work.discoveryCity) ?? 0) + 1);
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      phase3Halted.value = true;
      return;
    }
    // Per-attendee dedupe key = event URL + name (lowercased). Same person across
    // two events is fine to re-pitch with the new event's hook.
    const dedupeKey = `${work.event.url}#${work.attendee.name.toLowerCase()}`;
    if (
      ledger.isQueueDuplicate(PLAY_NAME, dedupeKey) ||
      ledger.isPendingResolution(PLAY_NAME, dedupeKey)
    ) {
      result.droppedDuplicate++;
      return;
    }

    if (opts.dryRun) {
      result.enqueued++;
      return;
    }

    // Person-level ICP gate, stage A — free, and before any spend.
    //
    // The event-level gate in Phase 2 proves the EVENT is on-topic; it says
    // nothing about the attendee. An audit found 23% of enqueued Luma
    // attendees were off-ICP — investors, marketers, designers, an events
    // coordinator — because "attended an AI hackathon" is not a job.
    //
    // `attendeeBio` was already on the payload and used only for email copy.
    // Judging it here rejects the clear misses (e.g. "GTM @AhaCreator")
    // before findEmail + verify + enrich are paid for. Ambiguous bios and the
    // ~31% with no bio fall through to stage B/C inside the spine.
    const preSpend = await qualifyPreSpend({
      icp,
      person: {
        name: work.attendee.name,
        roleText: work.attendee.bio ?? work.attendee.role ?? null,
        evidence: `attended ${work.event.title}`,
      },
    });
    if (preSpend.action === "reject") {
      result.droppedRole++;
      // Persist an auditable rejected row so the founder can see and override
      // the call — same pattern as the company-level ICP rejections.
      try {
        ledger.enqueueTarget({
          playName: PLAY_NAME,
          dedupeKey,
          payload: { name: work.attendee.name, eventUrl: work.event.url },
          source: SOURCE,
          initialStatus: "rejected",
          notes: `auto: role — ${preSpend.reason}`.slice(0, 300),
        });
      } catch {
        // Audit row is best-effort; the drop itself already happened.
      }
      return;
    }

    // Shared resolve→enqueue spine (also used by the outage retry handler).
    const outcome = await resolveAndEnqueueLumaAttendee(
      work,
      yourEdge,
      (c) => {
        result.costUsd += c;
      },
      () => result.enqueued >= limit,
      () => {
        result.enqueued++;
      },
      {
        icp,
        fillGaps: opts.qualifyFillGaps ?? true,
        onRoleReject: (reason) => {
          // Auditable rejected row, same pattern as the company-level ICP
          // rejections, so the founder can see and override the call.
          try {
            ledger.enqueueTarget({
              playName: PLAY_NAME,
              dedupeKey,
              payload: { name: work.attendee.name, eventUrl: work.event.url },
              source: SOURCE,
              initialStatus: "rejected",
              notes: `auto: role — ${reason}`.slice(0, 300),
            });
          } catch {
            // Audit row is best-effort; the drop itself already happened.
          }
        },
      },
    );
    if (outcome === "enqueued") {
      // counter already bumped synchronously via onEnqueued
    } else if (outcome === "capped") phase3Halted.value = true;
    else if (outcome === "duplicate") result.droppedDuplicate++;
    else if (outcome === "role-rejected") result.droppedRole++;
    else if (outcome === "platform-error") {
      // Backend outage: the event ages out of "upcoming", so a re-scan can't
      // recover this attendee — persist for retry once the platform recovers.
      persistPending({ playName: PLAY_NAME, dedupeKey, source: SOURCE, raw: { work, yourEdge } });
      result.droppedEnrichment++;
    } else result.droppedEnrichment++;
  });
  logEvent(
    "luma-events.attendees_attempted",
    {
      name: PLAY_NAME,
      total: [...attemptsByCity.values()].reduce((sum, count) => sum + count, 0),
      by_city: Object.fromEntries(attemptsByCity),
    },
    "info",
  );

  return result;
}

export function parseLumaEventExtract(raw: string): LumaEventExtract {
  const fallback: LumaEventExtract = {
    eventTitle: null,
    eventDateIso: null,
    eventTimezone: null,
    eventCity: null,
    eventDescription: null,
    eventHasPassed: false,
    publicAttendees: [],
  };
  const parsed = tryParseJsonObject<LumaEventExtract>(raw, fallback);
  // Defensive: ensure publicAttendees is an array; LLM may return null.
  if (!Array.isArray(parsed.publicAttendees)) {
    return { ...parsed, publicAttendees: [] };
  }
  return parsed;
}

/**
 * Resolve + enrich + enqueue one Luma attendee (host or guest) for an
 * already-gated event. Shared by the live run loop and the outage retry
 * handler. Depends only on `work` (attendee + event) and `yourEdge`, so it's
 * fully re-runnable from a persisted candidate. `costSink` accumulates spend
 * into the caller's running total (a no-op on retry). Returns a coarse outcome
 * the caller maps to counters / pending persistence.
 */
async function resolveAndEnqueueLumaAttendee(
  work: AttendeeWithEvent,
  yourEdge: string,
  costSink: (c: number) => void,
  /** Checked synchronously right before enqueue so the run's enqueue cap stays
   *  exact under concurrency (a worker may finish enrichment after the cap
   *  filled). Omitted on retry (no cap). */
  capReached?: () => boolean,
  /** Called synchronously immediately after a successful enqueue — the cap
   *  re-check, enqueue, and this increment run with no await between them, so
   *  the queue cap is exact. Omitted on retry. */
  onEnqueued?: () => void,
  /** Person-level ICP gate context. Omitted on retry -> gate runs pass-through. */
  gate?: {
    icp: string | null;
    /** Allow the paid stage-C lookup when the free title is still ambiguous. */
    fillGaps: boolean;
    /** Called with the classifier's reason when the person is rejected. */
    onRoleReject?: (reason: string) => void;
  },
): Promise<"enqueued" | "duplicate" | "dropped" | "platform-error" | "capped" | "role-rejected"> {
  const ledger = getLedger();
  const dedupeKey = `${work.event.url}#${work.attendee.name.toLowerCase()}`;
  try {
    // Resolve a contact domain: linkedin first (richest, often surfaces the
    // email so we can skip findEmail), then website.
    let companyDomain: string | null = null;
    const resolvedLinkedinUrl: string | null = isLinkedInProfileUrl(work.attendee.linkedinUrl)
      ? work.attendee.linkedinUrl
      : null;
    let resolvedCompany: string | null = null;
    let surfacedEmail: string | null = null;
    let profileTitle: string | null = null;

    if (resolvedLinkedinUrl) {
      try {
        const enr = await enrichProfile(
          { linkedinUrl: resolvedLinkedinUrl, name: work.attendee.name },
          {
            playName: PLAY_NAME,
            decisionContext: { source: "finder", linkedinUrl: resolvedLinkedinUrl },
          },
        );
        costSink(enr.result.cost ?? 0);
        const profile = enr.result.profile;
        companyDomain = profile?.company_domain ?? null;
        resolvedCompany = profile?.company ?? null;
        // Free title: this call is already paid for above.
        profileTitle = typeof profile?.title === "string" ? profile.title.trim() : null;
        surfacedEmail = profile?.best_work_email ?? profile?.email ?? null;
        if (surfacedEmail) {
          try {
            ledger.setCachedEnrichment(
              surfacedEmail.trim().toLowerCase(),
              JSON.stringify(enr.result),
            );
          } catch {
            // cache write is best-effort
          }
        }
      } catch (err) {
        logEvent(
          "error.swallowed",
          {
            kind: "luma-events.enrichProfile",
            message_120: ((err as Error).message ?? "").slice(0, 120),
          },
          "warn",
        );
      }
    }
    if (!companyDomain && work.attendee.websiteUrl) {
      companyDomain = urlDomain(work.attendee.websiteUrl);
    }

    // Contact resolution + enrichment + person-level ICP gate, in the spine
    // shared by every enqueueing finder (see `_contact.ts`). Keeping the gate
    // there rather than here is deliberate: it decides who gets emailed, so a
    // finder that quietly skipped it would reintroduce the off-ICP problem.
    const contact = await resolveVerifyEnrichQualify({
      playName: PLAY_NAME,
      fullName: work.attendee.name,
      knownEmail: surfacedEmail,
      companyDomain,
      isDuplicate: (email) => isDuplicate({ playName: PLAY_NAME, dedupeKey, prospectEmail: email }),
      decisionContext: {
        source: "finder",
        attendeeName: work.attendee.name,
        companyDomain,
        eventUrl: work.event.url,
      },
      errKindPrefix: "luma-events",
      icp: gate ? gate.icp : null,
      person: {
        name: work.attendee.name,
        company: resolvedCompany,
        roleText: work.attendee.bio ?? work.attendee.role ?? null,
        evidence: `attended ${work.event.title}`,
      },
      // Free title from the LinkedIn-keyed enrichProfile above.
      titleHint: profileTitle,
      linkedinUrlHint: resolvedLinkedinUrl,
      fillGaps: gate?.fillGaps ?? false,
    });
    costSink(contact.costUsd);
    if (!contact.ok) {
      if (contact.reason === "no-domain") {
        logEvent(
          "finder.skipped_no_contact_domain",
          { name: PLAY_NAME, attendeeName: work.attendee.name, eventUrl: work.event.url },
          "info",
        );
      }
      if (contact.reason === "role") {
        gate?.onRoleReject?.(contact.detail ?? "off-ICP role");
        return "role-rejected";
      }
      if (contact.reason === "platform-error") return "platform-error";
      if (contact.reason === "duplicate") return "duplicate";
      return "dropped";
    }
    const email = contact.email;
    const phone = contact.phone;
    let linkedinUrl: string | null = resolvedLinkedinUrl ?? contact.linkedinUrl;
    if (!linkedinUrl) {
      linkedinUrl = await findLinkedInUrl({
        fullName: work.attendee.name,
        disambiguators: [work.event.title, work.event.city].filter((s) => s.length > 0),
        accumCost: (c) => costSink(c ?? 0),
        errKindPrefix: "luma-events",
      });
    }

    // Resolve the event's zone ONCE, here, and carry the rendered string on the
    // candidate: explicit zone from the page → the event's city → the install
    // timezone. The draft prompt gets `eventDateLocal` and never the instant,
    // so the model has no timezone conversion left to get wrong.
    const eventZone = resolveEventZone({
      zone: work.event.timezone,
      city: work.event.city,
    });
    const eventDateLocal = formatLocalEventTime(work.event.dateIso, eventZone);

    const target: LumaEventsTarget = {
      name: work.attendee.name,
      email,
      ...(resolvedCompany ? { company: resolvedCompany } : {}),
      ...(work.attendee.bio || work.attendee.role
        ? { attendeeBio: work.attendee.bio ?? work.attendee.role ?? "" }
        : {}),
      ...(work.attendee.role ? { role: work.attendee.role } : {}),
      eventTitle: work.event.title,
      eventDate: work.event.dateIso,
      eventTimezone: eventZone,
      ...(eventDateLocal ? { eventDateLocal } : {}),
      eventCity: work.event.city,
      eventUrl: work.event.url,
      ...(work.event.description ? { eventDescription: work.event.description } : {}),
      yourEdge,
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
      ...(contact.title ? { title: contact.title } : {}),
      ...(work.attendee.profileUrl ? { sourceProfileUrl: work.attendee.profileUrl } : {}),
    };
    // Synchronous cap re-check right before enqueue — no await between here and
    // the caller's enqueued++, so the queue cap is exact even under concurrency.
    if (capReached?.()) return "capped";
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey,
      source: SOURCE,
      notes: `${work.attendee.name} ${work.attendee.role === "Host" ? "hosting" : "going to"} ${work.event.title}`,
    });
    if (id != null) {
      onEnqueued?.(); // synchronous with the cap check above — keeps the cap exact
      return "enqueued";
    }
    return "duplicate";
  } catch (err) {
    // SDK calls swallow their own failures; this catches anything else (e.g. a
    // ledger hiccup). Treat as a genuine drop, not a retryable platform error,
    // so it can't loop forever on a real bug.
    logEvent(
      "error.swallowed",
      {
        kind: "luma-events.attendee",
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return "dropped";
  }
}

// Outage retry: re-run the resolve→enqueue spine for a persisted attendee.
// The gate context is rebuilt from config rather than persisted with the row:
// a retry fired days later should be judged against the CURRENT ICP, and an
// attendee that queued before a gate recalibration must not dodge it.
registerPendingRetry(PLAY_NAME, async (raw) => {
  const { work, yourEdge } = raw as { work: AttendeeWithEvent; yourEdge: string };
  const ledger = getLedger();
  const dedupeKey = `${work.event.url}#${work.attendee.name.toLowerCase()}`;
  const outcome = await resolveAndEnqueueLumaAttendee(
    work,
    yourEdge,
    () => {},
    undefined,
    undefined,
    {
      icp: resolveIcp(),
      fillGaps: true,
      onRoleReject: (reason) => {
        try {
          ledger.enqueueTarget({
            playName: PLAY_NAME,
            dedupeKey,
            payload: { name: work.attendee.name, eventUrl: work.event.url },
            source: SOURCE,
            initialStatus: "rejected",
            notes: `auto: role — ${reason}`.slice(0, 300),
          });
        } catch {
          // audit row is best-effort
        }
      },
    },
  );
  return outcome === "enqueued"
    ? "enqueued"
    : outcome === "platform-error"
      ? "platform-error"
      : "dropped";
});
