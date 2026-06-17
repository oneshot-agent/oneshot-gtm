import { logEvent } from "@oneshot-gtm/core";
import { buildLinkedinUrl, buildTwitterUrl } from "./_luma-auth.ts";
import type { LumaPublicAttendee } from "./_types.ts";

/**
 * Primary discovery path for the luma-events finder. Instead of webSearch
 * (which surfaces search-INDEXED — i.e. older/established — Luma pages and so
 * reliably returns past events), this fetches Luma's per-city page directly.
 *
 * `https://luma.com/<city-slug>` server-renders the city's UPCOMING events into
 * a single `<script id="__NEXT_DATA__">` JSON blob. The city is selected by
 * slug (not by caller IP, unlike the `api.lu.ma/discover` endpoint), so it
 * works from any server. Each event carries a real `start_at` ISO timestamp,
 * so the caller can window-filter BEFORE spending on per-event reads.
 *
 * Undocumented surface: parsing is shape-tolerant (recursive collect) and every
 * failure mode returns null so the caller falls back to webSearch. Same posture
 * as `_luma-auth.ts`: spoofed UA, short timeout, graceful null, never throws.
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
 * webSearch. Trivially extensible — add the city-name → slug pair.
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
 * any word-boundary token derived from the founder's `topics` — so "AI Agents
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
      const geo = o["geo_address_info"];
      const city =
        geo &&
        typeof geo === "object" &&
        typeof (geo as Record<string, unknown>)["city"] === "string"
          ? ((geo as Record<string, unknown>)["city"] as string)
          : null;
      out.push({ slug: url, name: name.trim(), startAtIso: startAt, city });
    }

    for (const v of Object.values(o)) stack.push(v);
  }
  return out;
}

/**
 * Fetch a Luma city page and return its embedded events (all of them — the
 * caller applies the date window). Returns null on any failure (unknown slug,
 * non-2xx, no `__NEXT_DATA__`, parse error, network blip) so the caller falls
 * back to webSearch.
 */
export async function fetchCityEvents(citySlug: string): Promise<LumaDiscoveredEvent[] | null> {
  if (!citySlug) return null;
  let res: Response;
  try {
    res = await fetch(`https://luma.com/${encodeURIComponent(citySlug)}`, {
      method: "GET",
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "luma-events.discover_fetch",
        slug: citySlug,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
  if (!res.ok) {
    logEvent(
      "error.swallowed",
      { kind: "luma-events.discover_status", slug: citySlug, status: res.status },
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
    logEvent(
      "error.swallowed",
      { kind: "luma-events.discover_no_nextdata", slug: citySlug },
      "warn",
    );
    return null;
  }
  return collectEvents(data).slice(0, MAX_EVENTS);
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
  return parts.join(" ").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
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
 * Fetch one event's structured details from `api.lu.ma/url?url=<slug>` — the
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
      const geo = o["geo_address_info"];
      if (geo && typeof geo === "object") {
        const c = (geo as Record<string, unknown>)["city"];
        if (typeof c === "string") eventCity = c;
      }
    }
    // The event blurb is NOT on the event node — it sits on the wrapping
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
    for (const v of Object.values(o)) stack.push(v);
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
  return { eventTitle, eventDateIso, eventCity, eventDescription, attendees };
}
