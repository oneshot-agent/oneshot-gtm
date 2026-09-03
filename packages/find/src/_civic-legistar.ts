import { logEvent } from "@oneshot-gtm/core";

/**
 * Legistar/Granicus Web API helpers for the `civic-agenda` finder. Same
 * fault-tolerance posture as `_luma-discover.ts`: undocumented/shape-drifting
 * upstream, so every parse is defensive and every failure returns null rather
 * than throwing — the caller decides what a missing result means.
 *
 * No auth, no API key: the whole surface is public JSON (`Accept:
 * application/json` — the default response is XML). Docs:
 * https://webapi.legistar.com/Home/Examples
 */

const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 oneshot-gtm/civic-agenda";
const LEGISTAR_BASE = "https://webapi.legistar.com/v1";
/** Sane cap on events fetched per city per run. */
const MAX_EVENTS_PER_CITY = 100;
/** Sane cap on office records considered per body. */
const MAX_OFFICE_RECORDS = 50;

/**
 * Curated city-name → Legistar client-slug map (case/whitespace-insensitive).
 * Legistar covers 80%+ of US municipalities, but each deployment's slug is
 * its own arbitrary string (confirmed against the live API, not guessed) —
 * extend this map as founders name more cities. Unmapped cities are skipped
 * with a logged reason rather than guessed at.
 */
const CITY_SLUGS: Record<string, string> = {
  "new york": "nyc",
  "new york city": "nyc",
  nyc: "nyc",
  chicago: "chicago",
  philadelphia: "phila",
  phila: "phila",
  oakland: "oakland",
  "san francisco": "sfgov",
  sf: "sfgov",
};

/** Resolve a founder-supplied city name to a Legistar client slug, or null. */
export function cityToLegistarSlug(city: string): string | null {
  return CITY_SLUGS[city.trim().toLowerCase()] ?? null;
}

export interface LegistarEvent {
  eventId: number;
  eventBodyId: number;
  eventBodyName: string | null;
  /** Raw `EventDate` — midnight local civil time, no offset. */
  eventDateIso: string;
  /** Raw `EventTime` display string (e.g. "10:00 AM"). Free-form; not always present. */
  eventTime: string | null;
  eventLocation: string | null;
  eventAgendaFile: string | null;
  eventInSiteUrl: string | null;
}

interface RawLegistarEvent {
  EventId?: unknown;
  EventBodyId?: unknown;
  EventBodyName?: unknown;
  EventDate?: unknown;
  EventTime?: unknown;
  EventLocation?: unknown;
  EventAgendaFile?: unknown;
  EventInSiteURL?: unknown;
}

function parseEvent(raw: RawLegistarEvent): LegistarEvent | null {
  const eventId = raw.EventId;
  const eventDate = raw.EventDate;
  if (typeof eventId !== "number" || typeof eventDate !== "string" || eventDate.length === 0) {
    return null;
  }
  return {
    eventId,
    eventBodyId: typeof raw.EventBodyId === "number" ? raw.EventBodyId : 0,
    eventBodyName: typeof raw.EventBodyName === "string" ? raw.EventBodyName : null,
    eventDateIso: eventDate,
    eventTime: typeof raw.EventTime === "string" && raw.EventTime.trim() ? raw.EventTime : null,
    eventLocation: typeof raw.EventLocation === "string" ? raw.EventLocation : null,
    eventAgendaFile: typeof raw.EventAgendaFile === "string" ? raw.EventAgendaFile : null,
    eventInSiteUrl: typeof raw.EventInSiteURL === "string" ? raw.EventInSiteURL : null,
  };
}

/** OData literal for a JS Date, in the `datetime'...'` form Legistar's filter expects. */
function odataDateTime(d: Date): string {
  return `datetime'${d.toISOString().slice(0, 19)}'`;
}

/**
 * Fetch upcoming events for a city within `[now, now + sinceDays]`. Returns
 * null on any failure (unmapped-shape response, non-2xx, network blip) so the
 * caller can skip this city and continue with the rest.
 */
export async function fetchCityEvents(
  slug: string,
  sinceDays: number,
): Promise<LegistarEvent[] | null> {
  if (!slug) return null;
  const now = new Date();
  const end = new Date(now.getTime() + Math.max(1, sinceDays) * 24 * 3600 * 1000);
  const filter = `EventDate ge ${odataDateTime(now)} and EventDate lt ${odataDateTime(end)}`;
  const url =
    `${LEGISTAR_BASE}/${encodeURIComponent(slug)}/Events` +
    `?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent("EventDate asc")}` +
    `&$top=${MAX_EVENTS_PER_CITY}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logEvent(
        "error.swallowed",
        { kind: "civic-agenda.events_status", slug, status: res.status },
        "warn",
      );
      return null;
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    return data
      .map((e) => parseEvent(e as RawLegistarEvent))
      .filter((e): e is LegistarEvent => e !== null);
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "civic-agenda.events_fetch",
        slug,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

export interface LegistarEventItem {
  eventItemId: number;
  /** `EventItemTitle`, falling back to `EventItemMatterName` when blank. */
  title: string;
  matterFile: string | null;
}

interface RawLegistarEventItem {
  EventItemId?: unknown;
  EventItemTitle?: unknown;
  EventItemMatterName?: unknown;
  EventItemMatterFile?: unknown;
}

function parseEventItem(raw: RawLegistarEventItem): LegistarEventItem | null {
  const eventItemId = raw.EventItemId;
  if (typeof eventItemId !== "number") return null;
  const title =
    (typeof raw.EventItemTitle === "string" && raw.EventItemTitle.trim()) ||
    (typeof raw.EventItemMatterName === "string" && raw.EventItemMatterName.trim()) ||
    "";
  if (!title) return null;
  return {
    eventItemId,
    title,
    matterFile: typeof raw.EventItemMatterFile === "string" ? raw.EventItemMatterFile : null,
  };
}

/**
 * Fetch the agenda items for one event. Returns null on any failure (an
 * event with a hidden/unpublished agenda 404s here) so the caller skips it.
 */
export async function fetchEventItems(
  slug: string,
  eventId: number,
): Promise<LegistarEventItem[] | null> {
  if (!slug || !Number.isFinite(eventId)) return null;
  const url = `${LEGISTAR_BASE}/${encodeURIComponent(slug)}/Events/${eventId}/EventItems`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logEvent(
        "error.swallowed",
        { kind: "civic-agenda.event_items_status", slug, eventId, status: res.status },
        "warn",
      );
      return null;
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    return data
      .map((i) => parseEventItem(i as RawLegistarEventItem))
      .filter((i): i is LegistarEventItem => i !== null);
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "civic-agenda.event_items_fetch",
        slug,
        eventId,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

export interface LegistarContact {
  fullName: string;
  email: string;
  phone: string | null;
  title: string | null;
}

interface RawOfficeRecord {
  OfficeRecordFullName?: unknown;
  OfficeRecordEmail?: unknown;
  // Docs spell this without an "s" — matches the sample payload exactly.
  OfficeRecordPhone?: unknown;
  OfficeRecordTitle?: unknown;
}

/**
 * Legistar's own published-contact titles that read as "the person actually
 * running this body" rather than a rank-and-file member — preferred when more
 * than one office record carries an email, same principle as SAM.gov's POC:
 * use the contact the source already elevated, don't guess.
 */
const PREFERRED_TITLE_RX = /chair|president|clerk|secretary/i;

/**
 * Pick the best-published contact off a body's office records: prefer a
 * chair/president/clerk/secretary title, else the first record with an
 * email. Returns null when no record has one at all — a real, common case
 * (many bodies publish no member emails), not a fetch failure.
 */
export function pickOfficeContact(records: LegistarContact[]): LegistarContact | null {
  const withEmail = records.filter((r) => r.email.trim().length > 0);
  if (withEmail.length === 0) return null;
  const preferred = withEmail.find((r) => r.title && PREFERRED_TITLE_RX.test(r.title));
  return preferred ?? withEmail[0]!;
}

function parseOfficeRecord(raw: RawOfficeRecord): LegistarContact | null {
  const fullName =
    typeof raw.OfficeRecordFullName === "string" ? raw.OfficeRecordFullName.trim() : "";
  const email = typeof raw.OfficeRecordEmail === "string" ? raw.OfficeRecordEmail.trim() : "";
  if (!fullName || !email) return null;
  return {
    fullName,
    email,
    phone:
      typeof raw.OfficeRecordPhone === "string" && raw.OfficeRecordPhone.trim()
        ? raw.OfficeRecordPhone.trim()
        : null,
    title:
      typeof raw.OfficeRecordTitle === "string" && raw.OfficeRecordTitle.trim()
        ? raw.OfficeRecordTitle.trim()
        : null,
  };
}

/**
 * Fetch the office-holders for one body and return the best publicly-listed
 * contact (see `pickOfficeContact`). Returns null on fetch failure OR when
 * the body publishes no member email at all — the caller can't tell those
 * apart from the return value alone, which is fine: either way there's
 * nothing to enqueue against for this candidate.
 */
export async function fetchBodyContact(
  slug: string,
  bodyId: number,
): Promise<LegistarContact | null> {
  if (!slug || !Number.isFinite(bodyId) || bodyId <= 0) return null;
  const url = `${LEGISTAR_BASE}/${encodeURIComponent(slug)}/Bodies/${bodyId}/OfficeRecords`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logEvent(
        "error.swallowed",
        { kind: "civic-agenda.office_records_status", slug, bodyId, status: res.status },
        "warn",
      );
      return null;
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    const records = data
      .slice(0, MAX_OFFICE_RECORDS)
      .map((r) => parseOfficeRecord(r as RawOfficeRecord))
      .filter((r): r is LegistarContact => r !== null);
    return pickOfficeContact(records);
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "civic-agenda.office_records_fetch",
        slug,
        bodyId,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

/**
 * Free keyword gate on an agenda item title. Word-boundary token match (not
 * substring) so "AI" doesn't fire on "Maintenance", mirroring
 * `eventNameMatchesTopics` in `_luma-discover.ts`. Empty `keywords` gates
 * nothing (the caller's readiness check should prevent that in practice).
 */
function stemWord(w: string): string {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}
function titleTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2)
    .map(stemWord);
}

export function agendaItemMatchesKeywords(title: string, keywords: string[]): boolean {
  const tokens = new Set(keywords.flatMap(titleTokens));
  if (tokens.size === 0) return false;
  const words = new Set(titleTokens(title));
  for (const tok of tokens) {
    if (words.has(tok)) return true;
  }
  return false;
}
