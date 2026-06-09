import {
  enrichProfile,
  getLedger,
  logEvent,
  parallelMap,
  webRead,
  webSearch,
} from "@oneshot-gtm/core";
import { safeFindEmail, safeVerifyEmail } from "./_sdk-safe.ts";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { LumaEventsTarget } from "@oneshot-gtm/plays";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import { fetchAuthedGuestList, mergeAttendees } from "./_luma-auth.ts";
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
      { hint: "set LUMA_SESSION_COOKIE in ~/.oneshot-gtm/.env to unlock the full guest list" },
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
  const seenUrls = new Set<string>();
  const hits: SearchHit[] = [];
  outer: for (const topic of topics) {
    for (const city of cities) {
      if (hits.length >= limit * 3) break outer;
      // Search engines don't reliably parse "next N days" — keep the query
      // tight (site + topic + city + "event" keyword). Forward-date filtering
      // is enforced downstream by the date defense after webRead + LLM extract.
      const query = `site:luma.com "${topic}" "${city}" event`;
      try {
        const search = await webSearch(
          { query, maxResults: Math.min(10, limit) },
          {
            playName: PLAY_NAME,
            decisionContext: { source: "finder", topic, city },
          },
        );
        result.costUsd += search.result.cost ?? 0;
        for (const hit of search.result.results ?? []) {
          if (!hit.url) continue;
          // Gate on the ORIGINAL URL — `looksLikeLumaEventUrl` inspects the
          // query string (`?k=t` / `?k=c` mark Luma's category + calendar
          // pages). Canonicalizing first would strip those markers and let
          // category pages through.
          if (!looksLikeLumaEventUrl(hit.url)) continue;
          const canonical = hit.url.split("?")[0]!.replace(/\/$/, "");
          if (seenUrls.has(canonical)) continue;
          seenUrls.add(canonical);
          hits.push({ url: canonical, title: hit.title, description: hit.description });
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
  }
  result.candidates = hits.length;

  // Phase 2: webRead + LLM extract per event, parallelized. Each event yields
  // 0..N attendees; flatten the result into a single per-attendee work list.
  const concurrency = 3;
  const eventExtracts: Array<{ hit: SearchHit; extract: LumaEventExtract } | null> =
    await parallelMap(hits.slice(0, limit * 2), concurrency, async (hit) => {
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) return null;
      try {
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
        const extract = parseLumaEventExtract(llm.content);
        if (!extract.eventTitle) {
          logEvent(
            "finder.skipped_non_event",
            { name: PLAY_NAME, url: hit.url },
            "info",
          );
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

    // ICP filter on attendee bio/role (use event title as a backup signal).
    const filter = await icpFilter({
      icp,
      candidate: {
        title: `${work.attendee.name} — ${work.attendee.bio ?? work.attendee.role ?? ""}`,
        url: work.attendee.profileUrl ?? work.event.url,
        summary: `Going to: ${work.event.title} in ${work.event.city}. ${work.attendee.bio ?? ""}`,
      },
    });
    if (filter.match === null) {
      // Transient classifier failure (Anthropic 5xx, timeout, rate limit) —
      // drop without persisting. A rejection would burn the dedupeKey for
      // every future watch tick since isQueueDuplicate ignores status.
      result.droppedEnrichment++;
      continue;
    }
    if (!filter.match) {
      result.droppedIcp++;
      ledger.enqueueTarget({
        playName: PLAY_NAME,
        payload: { ...work.attendee, event: work.event },
        dedupeKey,
        source: SOURCE,
        initialStatus: "rejected",
        notes: `auto: ICP — ${filter.reason}`,
      });
      continue;
    }

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

    let email: string;
    if (surfacedEmail) {
      // LinkedIn enrichment already gave us a usable email. Skip findEmail.
      email = surfacedEmail;
    } else {
      if (!companyDomain) {
        result.droppedEnrichment++;
        logEvent(
          "finder.skipped_no_contact_domain",
          { name: PLAY_NAME, attendeeName: work.attendee.name, eventUrl: work.event.url },
          "info",
        );
        continue;
      }
      const skip = shouldSkipFindEmail({
        fullName: work.attendee.name,
        companyDomain,
      });
      if (!skip.ok) {
        result.droppedEnrichment++;
        logEvent("finder.skipped_findemail", { name: PLAY_NAME, reason: skip.reason }, "info");
        continue;
      }
      const found = await safeFindEmail(
        { fullName: work.attendee.name, companyDomain },
        {
          playName: PLAY_NAME,
          decisionContext: {
            source: "finder",
            attendeeName: work.attendee.name,
            companyDomain,
            eventUrl: work.event.url,
          },
        },
      );
      result.costUsd += found.result.cost ?? 0;
      if (!found.result.found || !found.result.email) {
        result.droppedEnrichment++;
        continue;
      }
      email = found.result.email;
    }

    if (isDuplicate({ playName: PLAY_NAME, dedupeKey, prospectEmail: email })) {
      result.droppedDuplicate++;
      continue;
    }

    const verified = await safeVerifyEmail(
      { email },
      {
        playName: PLAY_NAME,
        decisionContext: { source: "finder", prospectEmail: email },
      },
    );
    result.costUsd += verified.result.cost ?? 0;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      continue;
    }

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
      notes: `${work.attendee.name} going to ${work.event.title} — ${filter.reason}`,
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
