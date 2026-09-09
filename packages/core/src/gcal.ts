import {
  formatGmailApiError,
  getGmailAccessToken,
  GMAIL_AUTH_HINT,
  invalidateGmailAccessToken,
  type GmailAccount,
  type GoogleApiErrorEnvelope,
} from "./gmail.ts";

/**
 * Google Calendar REST client (issue #577) — mirrors gmail.ts's plain-fetch
 * shape deliberately: same OAuth client, same refresh token, and (critically)
 * the SAME `tokenCache` inside gmail.ts. `getGmailAccessToken` is reused
 * as-is rather than duplicated, so a Gmail-family access token minted for a
 * send is reused for a calendar read within its lifetime, and vice versa —
 * building a second cache here would double the refresh-token traffic for
 * no reason and risk the two caches disagreeing about whether a token is
 * still valid.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * Thrown by `calendarJson` on any non-2xx response. Carries the HTTP status
 * and (when parseable) Google's own `error.status` gRPC-style code — the
 * field that separates `PERMISSION_DENIED` (scope/auth lost) from
 * `RESOURCE_EXHAUSTED` (quota, self-heals) from
 * `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (persisted scope says calendar, live
 * token disagrees). Callers that need to branch on the specific failure
 * (the poller does, for 410/403) match on these fields instead of
 * re-parsing `.message`.
 */
export class CalendarApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly googleStatus: string | null,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

async function calendarFetch(
  path: string,
  init: RequestInit | undefined,
  account: GmailAccount,
): Promise<Response> {
  const token = await getGmailAccessToken(account);
  return fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
}

async function calendarJson<T>(
  path: string,
  init: RequestInit | undefined,
  account: GmailAccount,
): Promise<T> {
  const res = await calendarFetch(path, init, account);
  if (!res.ok) {
    // Mirror gmailJson's 401 handling exactly (gmail.ts:218-225 in the
    // implementer's own words): check the status before reading the body —
    // there's nothing in an auth-rejected body worth parsing, and a
    // stuck/slow/unclosed stream must not delay the re-auth message the
    // caller needs to act on. Additionally (calendar-specific): tokenCache
    // can hold a live access token for up to an hour, so a token REVOKED at
    // myaccount.google.com surfaces as a 401 on this very call, not as
    // `invalid_grant` on the next refresh — evict the cached token now or
    // every poll until natural expiry keeps handing back the dead one.
    if (res.status === 401) {
      res.body?.cancel().catch(() => {});
      invalidateGmailAccessToken(account);
      throw new CalendarApiError(
        `Calendar auth rejected (401) for ${account.id} — ${GMAIL_AUTH_HINT}`,
        401,
        null,
      );
    }
    const raw = await res.text();
    let googleStatus: string | null = null;
    try {
      googleStatus = (JSON.parse(raw) as GoogleApiErrorEnvelope).error?.status ?? null;
    } catch {
      // formatGmailApiError below falls back to a raw slice for this same case.
    }
    throw new CalendarApiError(
      `Calendar API failed (${res.status}): ${formatGmailApiError(raw)} [${path.split("?")[0]}]`,
      res.status,
      googleStatus,
    );
  }
  return (await res.json()) as T;
}

export interface CalendarEventDateTime {
  /** Set for a timed event — RFC3339 instant. */
  dateTime?: string;
  /** Set for an all-day event — bare YYYY-MM-DD, no time, no zone. */
  date?: string;
  /** IANA zone the event was created in; absent for UTC/all-day. */
  timeZone?: string;
}

export interface CalendarEventAttendee {
  email?: string;
  /** True on the row representing the authenticated calendar owner. */
  self?: boolean;
  organizer?: boolean;
  /** A room / equipment resource, not a person — never a match candidate. */
  resource?: boolean;
  responseStatus?: string;
}

export interface CalendarEventPerson {
  email?: string;
  self?: boolean;
}

/** One `events.list` item, trimmed to the `fields` this poller requests. */
export interface CalendarEventItem {
  id: string;
  iCalUID?: string;
  status?: "confirmed" | "tentative" | "cancelled" | string;
  summary?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  /** Last-modified instant — the field this poller sorts/watermarks on. */
  updated?: string;
  organizer?: CalendarEventPerson;
  creator?: CalendarEventPerson;
  attendees?: CalendarEventAttendee[];
  /** True when the room had more attendees than the API would list without `maxAttendees` (which this client deliberately never sends). */
  attendeesOmitted?: boolean;
  recurringEventId?: string;
  originalStartTime?: CalendarEventDateTime;
  eventType?: string;
  hangoutLink?: string;
  visibility?: string;
  transparency?: string;
  /** NEVER persisted past the ingest step — may carry dial-in PINs or private notes. */
  description?: string;
}

export interface ListCalendarEventsOpts {
  calendarId: string;
  /** Exclusive lower bound on `updated`. Omit for a full (unbounded) pull. */
  updatedMin?: string;
  /** Exclusive lower bound on the event's END. */
  timeMin: string;
  /** Exclusive upper bound on the event's START. */
  timeMax: string;
  pageToken?: string;
  maxResults?: number;
}

const EVENT_FIELDS =
  "nextPageToken,items(id,iCalUID,status,summary,start,end,updated," +
  "organizer,creator,attendees,attendeesOmitted,recurringEventId," +
  "originalStartTime,eventType,hangoutLink,visibility,transparency,description)";

/**
 * One page of `calendars.events.list`. Deliberately does NOT send
 * `maxAttendees` (an event over the cap would return only the authenticated
 * participant — the prospect vanishes and the meeting misreads as a
 * self-block) or `eventTypes` (filtering happens in code so dropped events
 * can be logged, not silently excluded server-side).
 */
export async function listCalendarEvents(
  account: GmailAccount,
  opts: ListCalendarEventsOpts,
): Promise<{ items: CalendarEventItem[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "true",
    // Ascending — load-bearing. An interrupted walk leaves a SUFFIX of
    // unexamined updates, not a hole, which is what lets this poller skip
    // the backlog machinery pollInboxReplies needs (see the scheduler-side
    // comment for the full argument).
    orderBy: "updated",
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    maxResults: String(opts.maxResults ?? 250),
    fields: EVENT_FIELDS,
  });
  if (opts.updatedMin) params.set("updatedMin", opts.updatedMin);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  const res = await calendarJson<{ items?: CalendarEventItem[]; nextPageToken?: string }>(
    `/calendars/${encodeURIComponent(opts.calendarId)}/events?${params}`,
    undefined,
    account,
  );
  return { items: res.items ?? [], nextPageToken: res.nextPageToken ?? null };
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  accessRole: string;
}

/**
 * `GET /users/me/calendarList?minAccessRole=writer` — the /setup picker's
 * source list. `writer` is the floor deliberately: on a `reader` or
 * `freeBusyReader` calendar every event comes back as `summary: "busy"`
 * with no attendees, which reads exactly like a self-block and would poison
 * matching with false negatives.
 */
export async function listWritableCalendars(account: GmailAccount): Promise<CalendarListEntry[]> {
  const res = await calendarJson<{
    items?: Array<{ id: string; summary?: string; accessRole?: string }>;
  }>(`/users/me/calendarList?minAccessRole=writer`, undefined, account);
  return (res.items ?? []).map((i) => ({
    id: i.id,
    summary: i.summary?.trim() || i.id,
    accessRole: i.accessRole ?? "",
  }));
}

/**
 * How many events landed on `calendarId` in the trailing 7 days — shown
 * beside each calendar in the /setup picker, because a founder cannot
 * reliably say which calendar their booking tool actually writes to.
 * Best-effort: any failure (including a calendar this account can no longer
 * read) reads as 0 rather than failing the whole picker.
 */
export async function recentEventCount(account: GmailAccount, calendarId: string): Promise<number> {
  const now = Date.now();
  try {
    const res = await listCalendarEvents(account, {
      calendarId,
      timeMin: new Date(now - 7 * 24 * 60 * 60_000).toISOString(),
      timeMax: new Date(now).toISOString(),
      maxResults: 250,
    });
    return res.items.length;
  } catch {
    return 0;
  }
}
