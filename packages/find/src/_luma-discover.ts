import { logEvent } from "@oneshot-gtm/core";
import { buildLinkedinUrl, buildTwitterUrl } from "./_luma-auth.ts";
import type { LumaPublicAttendee } from "./_types.ts";

/**
 * Discover upcoming Luma events from each city page
 * (`https://luma.com/<city-slug>`). Its server-rendered `__NEXT_DATA__` blob
 * contains start_at timestamps for filtering before paid event reads.
 * City slugs work independently of caller IP, unlike `api.lu.ma/discover`.
 * The webSearch fallback tends to return older indexed events.
 *
 * The city page only renders ~20 events, so `fetchPlaceEvents` pages the
 * city's whole feed through api.lu.ma, and `fetchCalendarEvents` reads a named
 * calendar in full (a city's Tech Week lives on its own calendar).
 *
 * This undocumented surface uses recursive, shape-tolerant parsing, a spoofed
 * user agent, and a short timeout. Failures return null for webSearch fallback.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 oneshot-gtm/luma-events";
const NEXT_DATA_OPEN = '<script id="__NEXT_DATA__" type="application/json">';
const NEXT_DATA_CLOSE = "</script>";
const MAX_EVENTS = 60;
const MAX_NODES = 200_000; // walk guard for the (large) embedded JSON tree

export interface LumaDiscoveredEvent {
  /** Event url slug → `https://luma.com/<slug>`. */
  slug: string;
  name: string;
  startAtIso: string;
  city: string | null;
}

/**
 * Luma city slugs are irregular ("sf", not "sanfrancisco"), so map the common
 * hubs explicitly. An unmapped city returns null and the caller falls back to
 * webSearch. Trivially extensible: add the city-name → slug pair.
 */
const CITY_SLUGS: Record<string, string> = {
  "san francisco": "sf",
  sf: "sf",
  "sf bay area": "sf",
  "bay area": "sf",
  "new york": "nyc",
  "new york city": "nyc",
  nyc: "nyc",
  "los angeles": "la",
  la: "la",
  london: "london",
  paris: "paris",
  berlin: "berlin",
  amsterdam: "amsterdam",
  vienna: "vienna",
  // Luma's own page is the English slug; `wien` resolves but lists nothing.
  wien: "vienna",
  prague: "prague",
  praha: "prague",
  prag: "prague",
  singapore: "singapore",
  tokyo: "tokyo",
  bangalore: "bangalore",
  bengaluru: "bangalore",
  toronto: "toronto",
  seattle: "seattle",
  austin: "austin",
  boston: "boston",
  miami: "miami",
  chicago: "chicago",
  denver: "denver",
  washington: "dc",
  "washington dc": "dc",
  dc: "dc",
};

/** Resolve a founder-supplied city name to a Luma local-page slug, or null. */
export function cityToSlug(city: string): string | null {
  return CITY_SLUGS[city.trim().toLowerCase()] ?? null;
}

/**
 * Coarse, free topic gate on an event name. Returns true if the name contains
 * any word-boundary token derived from the founder's `topics`, so "AI Agents
 * Hackathon" passes for topic "AI agents" but "Evening Yoga" doesn't. Word
 * boundaries avoid substring false-hits (e.g. "ai" inside "Maizie"). Returns
 * true when `topics` is empty (no gate). Lenient by design: it only skips an
 * LLM relevance call on obvious non-matches; the event-level icpFilter is the
 * authority for everything that passes.
 */
// Light de-pluralization so a topic "AI agents" matches an event "… Agent …".
function stemWord(w: string): string {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}
function topicTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2)
    .map(stemWord);
}

export function eventNameMatchesTopics(name: string, topics: string[]): boolean {
  const tokens = new Set(topics.flatMap(topicTokens));
  if (tokens.size === 0) return true; // no topics configured → no gate
  const words = new Set(topicTokens(name));
  for (const tok of tokens) {
    if (words.has(tok)) return true;
  }
  return false;
}

/** Slice the `__NEXT_DATA__` JSON out of the page HTML and parse it. */
function parseNextData(html: string): unknown | null {
  const open = html.indexOf(NEXT_DATA_OPEN);
  if (open === -1) return null;
  const from = open + NEXT_DATA_OPEN.length;
  const end = html.indexOf(NEXT_DATA_CLOSE, from);
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(from, end));
  } catch {
    return null;
  }
}

/**
 * The city an event's `geo_address_info` names. Luma fills `city` for most
 * venues, but an organizer-typed ("manual") address carries only the
 * `address` string ("639 Howard St, San Francisco, CA"), and some payloads
 * carry `city_state` alone. Null when none of those yields a city.
 */
export function cityFromGeo(geo: unknown): string | null {
  if (!geo || typeof geo !== "object") return null;
  const g = geo as Record<string, unknown>;
  const field = (key: string): string | null => {
    const v = g[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const city = field("city");
  if (city) return city;
  const cityState = field("city_state")?.split(",")[0]?.trim();
  if (cityState) return cityState;
  const address = field("full_address") ?? field("address");
  if (!address) return null;
  // "<street>, <city>, <ST>[ <zip>][, USA]": the city sits before the state.
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length > 0 && /^(usa|us|united states)$/i.test(parts.at(-1)!)) parts.pop();
  if (parts.length >= 3 && /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(parts.at(-1)!)) {
    return parts.at(-2)!;
  }
  return null;
}

/**
 * Recursively collect event-shaped objects from the parsed tree. Matching on
 * the event's own fields (api_id `evt-`, plus a slug `url`, `name`, `start_at`)
 * rather than a fixed nesting path keeps this resilient to Next.js shape drift.
 * Deduped by api_id; the wrapper `entry` objects lack `start_at` so they're
 * skipped.
 */
function collectEvents(root: unknown): LumaDiscoveredEvent[] {
  const out: LumaDiscoveredEvent[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [root];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const o = node as Record<string, unknown>;

    const apiId = o["api_id"];
    const url = o["url"];
    const name = o["name"];
    const startAt = o["start_at"];
    if (
      typeof apiId === "string" &&
      apiId.startsWith("evt-") &&
      typeof url === "string" &&
      url.length > 0 &&
      !url.includes("/") && // the slug is bare; a full URL means this isn't the event node
      typeof name === "string" &&
      name.trim().length > 0 &&
      typeof startAt === "string" &&
      startAt.length > 0 &&
      !seen.has(apiId)
    ) {
      seen.add(apiId);
      out.push({
        slug: url,
        name: name.trim(),
        startAtIso: startAt,
        city: cityFromGeo(o["geo_address_info"]),
      });
    }

    for (const v of Object.values(o)) stack.push(v);
  }
  return out;
}

/**
 * Fetch `luma.com/<slug>` (a city page or a calendar page) and return its
 * parsed `__NEXT_DATA__`. Null on any failure (unknown slug, non-2xx, no
 * `__NEXT_DATA__`, parse error, network blip).
 */
async function fetchPageData(slug: string): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(`https://luma.com/${encodeURIComponent(slug)}`, {
      method: "GET",
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "luma-events.discover_fetch",
        slug,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
  if (!res.ok) {
    logEvent(
      "error.swallowed",
      { kind: "luma-events.discover_status", slug, status: res.status },
      "warn",
    );
    return null;
  }
  let html: string;
  try {
    html = await res.text();
  } catch {
    return null;
  }
  const data = parseNextData(html);
  if (data == null) {
    logEvent("error.swallowed", { kind: "luma-events.discover_no_nextdata", slug }, "warn");
    return null;
  }
  return data;
}

/**
 * Fetch a Luma city page and return its embedded events (all of them. The
 * caller applies the date window). Returns null on any failure (unknown slug,
 * non-2xx, no `__NEXT_DATA__`, parse error, network blip) so the caller falls
 * back to webSearch.
 */
export async function fetchCityEvents(citySlug: string): Promise<LumaDiscoveredEvent[] | null> {
  if (!citySlug) return null;
  const data = await fetchPageData(citySlug);
  if (data == null) return null;
  return collectEvents(data).slice(0, MAX_EVENTS);
}

// Paged discovery: a city's whole feed, and named calendars

const API_BASE = "https://api.lu.ma";
const PAGE_LIMIT = 50;
const MAX_PLACE_PAGES = 10;
const MAX_CALENDAR_PAGES = 20;

/**
 * Find the object in a parsed page whose `api_id` carries `prefix` and whose
 * `slug` is `slug`: the city's own `discplace-` record on a city page, the
 * calendar's own `cal-` record on a calendar page. Pages embed other calendars
 * and places too (featured, nearby), so the slug match is what picks the right
 * one.
 */
function findOwnRecord(
  root: unknown,
  prefix: "discplace-" | "cal-",
  slug: string,
): { apiId: string; name: string | null } | null {
  const want = slug.toLowerCase();
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const o = node as Record<string, unknown>;
    const apiId = o["api_id"];
    const ownSlug = o["slug"];
    if (
      typeof apiId === "string" &&
      apiId.startsWith(prefix) &&
      typeof ownSlug === "string" &&
      ownSlug.toLowerCase() === want
    ) {
      return { apiId, name: typeof o["name"] === "string" ? o["name"] : null };
    }
    for (const v of Object.values(o)) stack.push(v);
  }
  return null;
}

/** GET a JSON page from api.lu.ma. Null on any failure, logged under `kind`. */
async function fetchApiPage(
  path: string,
  params: Record<string, string>,
  kind: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${API_BASE}${path}?${new URLSearchParams(params).toString()}`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logEvent("error.swallowed", { kind, status: res.status }, "warn");
      return null;
    }
    const json = (await res.json()) as unknown;
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch (err) {
    logEvent(
      "error.swallowed",
      { kind, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

/**
 * Walk a cursor-paged api.lu.ma listing. `stop` sees each page's events and
 * returns true once the listing has moved past the window (listings are sorted
 * by start, so the rest of it is out of the window too). Returns the events
 * collected so far, or null when the FIRST page fails.
 */
async function pageEvents(
  path: string,
  params: Record<string, string>,
  maxPages: number,
  kind: string,
  stop: (page: LumaDiscoveredEvent[]) => boolean,
): Promise<LumaDiscoveredEvent[] | null> {
  const out: LumaDiscoveredEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const json = await fetchApiPage(
      path,
      {
        ...params,
        pagination_limit: String(PAGE_LIMIT),
        ...(cursor ? { pagination_cursor: cursor } : {}),
      },
      kind,
    );
    if (!json) return page === 0 ? null : out;
    const events = collectEvents(json["entries"] ?? []);
    out.push(...events);
    const next = json["next_cursor"];
    if (stop(events) || json["has_more"] !== true || typeof next !== "string" || !next) break;
    cursor = next;
    // The cap is a guard, not a window: say so when it, and not the window
    // edge or the end of the listing, is what stopped the walk.
    if (page === maxPages - 1) {
      logEvent(
        "luma-events.page_cap",
        { kind, pages: maxPages, events: out.length, ...params },
        "warn",
      );
    }
  }
  return out;
}

function dedupeBySlug(events: LumaDiscoveredEvent[]): LumaDiscoveredEvent[] {
  const seen = new Set<string>();
  return events.filter((ev) => (seen.has(ev.slug) ? false : (seen.add(ev.slug), true)));
}

const startMs = (ev: LumaDiscoveredEvent): number => new Date(ev.startAtIso).getTime();

/**
 * A city's upcoming events through `toMs`, past the city page's ~20-event cap.
 * The city page carries the city's own `discplace-` id, and
 * `api.lu.ma/discover/get-paginated-events?discover_place_api_id=` pages that
 * city's feed sorted by start. (`place_api_id` without the `discover_` prefix
 * is ignored and geolocates by caller IP; this one is honoured.) Anything that
 * goes wrong past the city page falls back to the city page's own events, so
 * this is never worse than `fetchCityEvents`. Null only when the city page
 * itself fails.
 */
export async function fetchPlaceEvents(
  citySlug: string,
  window: { toMs: number },
): Promise<LumaDiscoveredEvent[] | null> {
  if (!citySlug) return null;
  const data = await fetchPageData(citySlug);
  if (data == null) return null;
  const pageEventsOnCityPage = collectEvents(data).slice(0, MAX_EVENTS);
  const place = findOwnRecord(data, "discplace-", citySlug);
  if (!place) return pageEventsOnCityPage;
  const paged = await pageEvents(
    "/discover/get-paginated-events",
    { discover_place_api_id: place.apiId },
    MAX_PLACE_PAGES,
    "luma-events.discover_place",
    (page) => page.some((ev) => startMs(ev) > window.toMs),
  );
  if (!paged || paged.length === 0) return pageEventsOnCityPage;
  return dedupeBySlug([...paged, ...pageEventsOnCityPage]);
}

/**
 * Parse a founder-supplied calendar reference: a `cal-` id, a bare slug
 * (`sftw`), or a `luma.com/<slug>` / `lu.ma/<slug>` URL. Null when blank or
 * unparseable.
 */
export function parseCalendarRef(ref: string): { apiId: string } | { slug: string } | null {
  const raw = ref.trim();
  if (!raw) return null;
  if (/^cal-[A-Za-z0-9]+$/.test(raw)) return { apiId: raw };
  let candidate = raw;
  if (/^(https?:\/\/)?(www\.)?(luma\.com|lu\.ma)\//i.test(raw)) {
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const segments = u.pathname.split("/").filter((s) => s.length > 0);
      if (segments.length !== 1) return null;
      candidate = segments[0]!;
    } catch {
      return null;
    }
  }
  if (/^cal-[A-Za-z0-9]+$/.test(candidate)) return { apiId: candidate };
  return /^[A-Za-z0-9_-]+$/.test(candidate) ? { slug: candidate } : null;
}

export interface LumaCalendarEvents {
  calendarApiId: string;
  calendarName: string | null;
  events: LumaDiscoveredEvent[];
}

/**
 * Every event on a Luma calendar that starts in [fromMs, toMs]. Themed weeks
 * (a city's Tech Week) live on their own calendar with hundreds of events, few
 * of which ever reach the city page. `api.lu.ma/calendar/get-items` pages the
 * calendar: `period=future` soonest first (it includes events in progress),
 * `period=past` newest first, read only when `fromMs` is in the past. Null
 * when the calendar can't be resolved or its first future page fails.
 */
export async function fetchCalendarEvents(
  ref: string,
  window: { fromMs: number; toMs: number },
): Promise<LumaCalendarEvents | null> {
  const parsed = parseCalendarRef(ref);
  if (!parsed) return null;
  let calendarApiId: string;
  let calendarName: string | null = null;
  if ("apiId" in parsed) {
    calendarApiId = parsed.apiId;
  } else {
    const data = await fetchPageData(parsed.slug);
    if (data == null) return null;
    const own = findOwnRecord(data, "cal-", parsed.slug);
    if (!own) {
      logEvent(
        "error.swallowed",
        { kind: "luma-events.calendar_unresolved", slug: parsed.slug },
        "warn",
      );
      return null;
    }
    calendarApiId = own.apiId;
    calendarName = own.name;
  }

  const future = await pageEvents(
    "/calendar/get-items",
    { calendar_api_id: calendarApiId, period: "future" },
    MAX_CALENDAR_PAGES,
    "luma-events.calendar_items",
    (page) => page.some((ev) => startMs(ev) > window.toMs),
  );
  if (!future) return null;
  const past =
    window.fromMs < Date.now()
      ? ((await pageEvents(
          "/calendar/get-items",
          { calendar_api_id: calendarApiId, period: "past" },
          MAX_CALENDAR_PAGES,
          "luma-events.calendar_items",
          (page) => page.some((ev) => startMs(ev) < window.fromMs),
        )) ?? [])
      : [];

  // In start order: the walk that collects them is unordered.
  const events = dedupeBySlug([...past, ...future])
    .filter((ev) => {
      const ms = startMs(ev);
      return Number.isFinite(ms) && ms >= window.fromMs && ms <= window.toMs;
    })
    .toSorted((a, b) => startMs(a) - startMs(b));
  return { calendarApiId, calendarName, events };
}

// Per-event structured details (api.lu.ma/url)

const MAX_DETAIL_ATTENDEES = 30;
// Cap the raw description we keep off the api.lu.ma payload. Matches the
// luma-event-extract prompt's ~500-char guidance so both discovery paths feed
// the draft a comparably-sized blurb; the draft prompt slices defensively too.
const MAX_DETAIL_DESCRIPTION = 500;

export interface LumaEventDetails {
  eventTitle: string | null;
  eventDateIso: string | null;
  /**
   * IANA zone Luma stamps on the event itself (e.g. "America/Los_Angeles").
   * The most authoritative input to the date/time rendering chain. It beats
   * the city lookup and the install zone. Null when the payload omits it.
   */
  eventTimezone: string | null;
  eventCity: string | null;
  /** Plain-text event description, capped at MAX_DETAIL_DESCRIPTION. Null when absent. */
  eventDescription: string | null;
  /** Hosts (role "Host", listed first) + featured guests (role "Guest"). */
  attendees: LumaPublicAttendee[];
}

/**
 * Flatten a Luma `description_mirror` (a ProseMirror/TipTap rich-text doc:
 * `{ type, content: [...] }`) to plain text by concatenating every `text` leaf.
 * Drops zero-width spaces Luma sprinkles in, then collapses whitespace so the
 * result is one clean line (the draft input block is newline-delimited).
 * Returns "" for anything that isn't a doc with text leaves.
 */
function flattenProseMirror(node: unknown): string {
  const parts: string[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const v of n) visit(v);
      return;
    }
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (o["type"] === "text" && typeof o["text"] === "string") parts.push(o["text"]);
    for (const v of Object.values(o)) visit(v);
  };
  visit(node);
  return parts
    .join(" ")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Person shape shared by `hosts` and `featured_guests` in the /url payload. */
interface RawUrlPerson {
  name?: string | null;
  username?: string | null;
  website?: string | null;
  linkedin_handle?: string | null;
  twitter_handle?: string | null;
  bio_short?: string | null;
}

function projectUrlPerson(raw: RawUrlPerson, role: "Host" | "Guest"): LumaPublicAttendee | null {
  const name = (raw.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    profileUrl: raw.username ? `https://luma.com/user/${raw.username}` : null,
    websiteUrl: raw.website ?? null,
    linkedinUrl: buildLinkedinUrl(raw.linkedin_handle),
    twitterUrl: buildTwitterUrl(raw.twitter_handle),
    bio: raw.bio_short ?? null,
    role,
  };
}

/**
 * Fetch one event's structured details from `api.lu.ma/url?url=<slug>`. The
 * same anonymous JSON the event page renders from. Unlike the webRead + LLM
 * extract (which only sees names in the rendered text), this carries each
 * person's `linkedin_handle` / `website`, which is exactly what the contact
 * resolution in Phase 3 needs. `hosts` is present even when the guest list is
 * hidden; `featured_guests` (~10) appears when the host shows "Who's Coming".
 * Returns null on any failure so the caller falls back to webRead + LLM.
 */
export async function fetchEventDetails(slug: string): Promise<LumaEventDetails | null> {
  if (!slug) return null;
  let res: Response;
  try {
    res = await fetch(`https://api.lu.ma/url?url=${encodeURIComponent(slug)}`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "luma-events.details_fetch",
        slug,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
  if (!res.ok) {
    logEvent(
      "error.swallowed",
      { kind: "luma-events.details_status", slug, status: res.status },
      "warn",
    );
    return null;
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    logEvent("error.swallowed", { kind: "luma-events.details_parse", slug }, "warn");
    return null;
  }

  // Shape-tolerant walk: take the first event node (api_id `evt-` + start_at)
  // and the first non-empty `hosts` / `featured_guests` arrays anywhere in the
  // payload, rather than relying on a fixed nesting path.
  let eventTitle: string | null = null;
  let eventDateIso: string | null = null;
  let eventTimezone: string | null = null;
  let eventCity: string | null = null;
  let eventDescription: string | null = null;
  let hosts: RawUrlPerson[] | null = null;
  let guests: RawUrlPerson[] | null = null;
  const stack: unknown[] = [data];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop();
    visited++;
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const o = node as Record<string, unknown>;
    if (
      eventTitle == null &&
      typeof o["api_id"] === "string" &&
      (o["api_id"] as string).startsWith("evt-") &&
      typeof o["start_at"] === "string" &&
      typeof o["name"] === "string"
    ) {
      eventTitle = (o["name"] as string).trim() || null;
      eventDateIso = (o["start_at"] as string) || null;
      // `start_at` is an INSTANT (offset-bearing); `timezone` is the zone the
      // host set, i.e. the one the attendee reads the event in. Without it we
      // would be back to converting 7:30pm Wednesday in SF into Thursday.
      const tz = o["timezone"];
      if (typeof tz === "string" && tz.trim().length > 0) eventTimezone = tz.trim();
      eventCity = cityFromGeo(o["geo_address_info"]);
    }
    // The event blurb is NOT on the event node. It sits on the wrapping
    // `data` object as `description_mirror` (a ProseMirror doc). Capture the
    // first one found (the page's primary event; `data` is walked early), and
    // fall back to the calendar/category `description_short` / `description`
    // strings when an event has no body of its own.
    if (eventDescription == null) {
      const mirror = o["description_mirror"];
      if (mirror && typeof mirror === "object") {
        const flat = flattenProseMirror(mirror);
        if (flat) eventDescription = flat.slice(0, MAX_DETAIL_DESCRIPTION);
      }
    }
    if (eventDescription == null) {
      for (const key of ["description_short", "description"]) {
        const v = o[key];
        if (typeof v === "string" && v.trim()) {
          eventDescription = v.trim().replace(/\s+/g, " ").slice(0, MAX_DETAIL_DESCRIPTION);
          break;
        }
      }
    }
    if (hosts == null && Array.isArray(o["hosts"]) && o["hosts"].length > 0) {
      hosts = o["hosts"] as RawUrlPerson[];
    }
    if (guests == null && Array.isArray(o["featured_guests"]) && o["featured_guests"].length > 0) {
      guests = o["featured_guests"] as RawUrlPerson[];
    }
    // Never descend into the description: an organizer can embed a card for
    // ANOTHER event in it, a full `evt-` node with its own name and date, and
    // the walk would take that event for this one.
    for (const [key, v] of Object.entries(o)) {
      if (key !== "description_mirror") stack.push(v);
    }
  }

  // Hosts first (canonical name casing + the better targets), then guests;
  // dedupe by lowercased name (a host can also appear as a featured guest).
  const byName = new Map<string, LumaPublicAttendee>();
  for (const [list, role] of [
    [hosts ?? [], "Host"],
    [guests ?? [], "Guest"],
  ] as const) {
    for (const raw of list) {
      const a = projectUrlPerson(raw, role);
      if (!a) continue;
      const key = a.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, a);
      if (byName.size >= MAX_DETAIL_ATTENDEES) break;
    }
  }

  const attendees = [...byName.values()];
  if (!eventTitle && attendees.length === 0) {
    logEvent("error.swallowed", { kind: "luma-events.details_shape", slug }, "warn");
    return null;
  }
  return { eventTitle, eventDateIso, eventTimezone, eventCity, eventDescription, attendees };
}
