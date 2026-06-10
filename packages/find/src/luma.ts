import {
  enrichProfile,
  getLedger,
  logEvent,
  parallelMap,
  webRead,
  webSearch,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { LumaEventsTarget } from "@oneshot-gtm/plays";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { resolveAndVerifyContact } from "./_contact.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
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

interface AttendeeWithEvent {
  attendee: LumaPublicAttendee;
  event: {
    url: string;
    title: string;
    dateIso: string;
    city: string;
  };
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
  enqueued: number;
  costUsd: number;
  halted?: string;
}> {
  const limit = opts.limit ?? 25;
  const sinceDays = opts.sinceDays ?? 14;
  const topics = (opts.topics ?? []).filter((t) => t.trim().length > 0);
  const cities = (opts.cities ?? []).filter((c) => c.trim().length > 0);
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
  const hits: SearchHit[] = [];
  const cap = limit * 3;
  const windowStart = Date.now() - 24 * 3600 * 1000;
  const windowEnd = Date.now() + sinceDays * 24 * 3600 * 1000;

  const pushHit = (url: string, title: string, description: string): void => {
    const canonical = url.split("?")[0]!.replace(/\/$/, "");
    if (seenUrls.has(canonical)) return;
    seenUrls.add(canonical);
    hits.push({ url: canonical, title, description });
  };

  // webSearch fallback for a single city — used when the city isn't a mapped
  // Luma hub or its page can't be parsed. This path surfaces search-INDEXED
  // (older) pages, which is why the date defense downstream still matters.
  const webSearchCity = async (city: string): Promise<void> => {
    for (const topic of topics) {
      if (hits.length >= cap) return;
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
          pushHit(hit.url, hit.title, hit.description);
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
    if (hits.length >= cap) break;
    const slug = cityToSlug(city);
    const discovered = slug ? await fetchCityEvents(slug) : null;
    if (discovered && discovered.length > 0) {
      let kept = 0;
      for (const ev of discovered) {
        if (hits.length >= cap) break;
        const ms = new Date(ev.startAtIso).getTime();
        if (!Number.isFinite(ms) || ms < windowStart || ms > windowEnd) continue;
        pushHit(`https://luma.com/${ev.slug}`, ev.name, "");
        kept++;
      }
      logEvent(
        "luma-events.discover_ok",
        { name: PLAY_NAME, city, slug, found: discovered.length, in_window: kept },
        "info",
      );
      if (kept > 0) continue;
    }
    await webSearchCity(city);
  }
  result.candidates = hits.length;

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
  const eventExtracts: Array<{ hit: SearchHit; extract: LumaEventExtract } | null> =
    await parallelMap(hits.slice(0, limit * 2), concurrency, async (hit) => {
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) return null;

      // Free keyword pre-filter: skip the LLM call for obvious off-topic names.
      if (topics.length > 0 && !eventNameMatchesTopics(hit.title, topics)) {
        logEvent("finder.skipped_off_topic", { name: PLAY_NAME, url: hit.url, title: hit.title });
        return null;
      }
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
            eventCity: details.eventCity,
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

  const attendeesWork: AttendeeWithEvent[] = [];
  for (const item of eventExtracts) {
    if (!item) continue;
    const { hit, extract } = item;
    const eventCtx = {
      url: hit.url,
      title: extract.eventTitle ?? hit.title,
      dateIso: extract.eventDateIso ?? "",
      city: extract.eventCity ?? "",
    };
    for (const attendee of extract.publicAttendees.slice(0, MAX_ATTENDEES_PER_EVENT)) {
      if (!attendee.name || attendee.name.trim().length === 0) continue;
      attendeesWork.push({ attendee, event: eventCtx });
    }
  }

  // Phase 3: per-attendee contact resolution. Sequential within event already
  // flattened; we still cap concurrency to 3 to bound SDK burst.
  for (const work of attendeesWork) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    // Per-attendee dedupe key = event URL + name (lowercased). Same person across
    // two events is fine to re-pitch with the new event's hook.
    const dedupeKey = `${work.event.url}#${work.attendee.name.toLowerCase()}`;
    if (ledger.isQueueDuplicate(PLAY_NAME, dedupeKey)) {
      result.droppedDuplicate++;
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    // No per-attendee ICP filter: the event cleared the event-level topic+ICP
    // gate in Phase 2, so its public attendees are in-scope. (Filtering bare
    // attendee names against the ICP rejected even on-topic people — Luma's
    // public attendee data is too thin to judge.)

    // Resolve a contact domain: linkedin first (richest data, often surfaces
    // the email directly so we can skip findEmail), then website. Without
    // either we can't run findEmail safely — skip.
    let companyDomain: string | null = null;
    let resolvedLinkedinUrl: string | null = isLinkedInProfileUrl(work.attendee.linkedinUrl)
      ? work.attendee.linkedinUrl
      : null;
    let resolvedCompany: string | null = null;
    // Email surfaced directly by enrichProfile (LinkedIn path). When present,
    // we can skip the findEmail call ($0.05 saved per candidate).
    let surfacedEmail: string | null = null;

    if (resolvedLinkedinUrl) {
      try {
        const enr = await enrichProfile(
          { linkedinUrl: resolvedLinkedinUrl, name: work.attendee.name },
          {
            playName: PLAY_NAME,
            decisionContext: { source: "finder", linkedinUrl: resolvedLinkedinUrl },
          },
        );
        result.costUsd += enr.result.cost ?? 0;
        // PersonResult shape: company (NAME) + company_domain (DOMAIN) at the
        // top level — NOT a nested object. Per @oneshot-agent/sdk@0.16.2 .d.ts.
        const profile = enr.result.profile;
        companyDomain = profile?.company_domain ?? null;
        resolvedCompany = profile?.company ?? null;
        // Prefer best_work_email when surfaced — it's the SDK's already-verified
        // pick. Fall back to the raw email field. Both can be undefined.
        surfacedEmail = profile?.best_work_email ?? profile?.email ?? null;
        // Cache the linkedin-keyed enrich by the SURFACED email so the second
        // SDK call later in this pipeline (enrichVerifiedContact, by email)
        // becomes a cache hit — eliminates double-enrich on this candidate.
        if (surfacedEmail) {
          try {
            getLedger().setCachedEnrichment(
              surfacedEmail.trim().toLowerCase(),
              JSON.stringify(enr.result),
            );
          } catch {
            // cache write is best-effort — finder's contract isn't cache hygiene.
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

    const contact = await resolveAndVerifyContact({
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
    });
    result.costUsd += contact.costUsd;
    if (!contact.ok) {
      if (contact.reason === "no-domain") {
        logEvent(
          "finder.skipped_no_contact_domain",
          { name: PLAY_NAME, attendeeName: work.attendee.name, eventUrl: work.event.url },
          "info",
        );
      }
      if (contact.reason === "duplicate") result.droppedDuplicate++;
      else result.droppedEnrichment++;
      continue;
    }
    const email = contact.email;

    const enr = await enrichVerifiedContact(email, {
      playName: PLAY_NAME,
      errKindPrefix: "luma-events",
    });
    result.costUsd += enr.costUsd;
    const phone = enr.phone;
    let linkedinUrl: string | null = resolvedLinkedinUrl ?? enr.linkedinUrl;
    if (!linkedinUrl) {
      linkedinUrl = await findLinkedInUrl({
        fullName: work.attendee.name,
        disambiguators: [work.event.title, work.event.city].filter((s) => s.length > 0),
        accumCost: (c) => {
          result.costUsd += c ?? 0;
        },
        errKindPrefix: "luma-events",
      });
    }

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
      eventCity: work.event.city,
      eventUrl: work.event.url,
      yourEdge,
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey,
      source: SOURCE,
      notes: `${work.attendee.name} ${work.attendee.role === "Host" ? "hosting" : "going to"} ${work.event.title}`,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

export function parseLumaEventExtract(raw: string): LumaEventExtract {
  const fallback: LumaEventExtract = {
    eventTitle: null,
    eventDateIso: null,
    eventCity: null,
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
