import { logEvent } from "@oneshot-gtm/core";
import type { LumaPublicAttendee } from "./_types.ts";

/**
 * Optional v2 path for the luma-events finder. When the founder has pasted
 * their `luma.auth-session-key` cookie into `LUMA_SESSION_COOKIE`, this helper
 * fetches the FULL guest list from Luma's internal API — the same call the
 * logged-in dashboard makes. Public-only mode (no cookie) caps coverage at
 * the 5-30 attendees Luma chose to surface; auth'd mode unlocks everyone
 * the founder could see by clicking the event in their browser.
 *
 * The endpoint is undocumented and may change. We try two URL shapes (the
 * `/admin/` and the bare variant) and fall back gracefully to null on any
 * 4xx / shape drift / network blip. The caller (luma.ts) treats null as
 * "stay in public-only mode for this event" — no crash.
 *
 * TOS posture: this is the founder's own cookie hitting pages they could
 * read in a browser. The cookie value is never logged (only its presence is)
 * and never persisted by this codebase beyond the `~/.oneshot-gtm/.env` file
 * the founder owns.
 */

const ENDPOINTS = [
  "https://api.lu.ma/event/admin/get-guest-list",
  "https://api.lu.ma/event/get-guest-list",
];

const COOKIE_NAME = "luma.auth-session-key";
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 oneshot-gtm/luma-events";
const MAX_AUTHED_ATTENDEES = 30;

interface RawGuest {
  user?: {
    name?: string | null;
    avatar_url?: string | null;
    website?: string | null;
    linkedin_handle?: string | null;
    twitter_handle?: string | null;
    bio?: string | null;
    bio_short?: string | null;
    url?: string | null;
  } | null;
  name?: string | null;
  // Surface "Approved Going" / "Speaker" / etc when present at this level.
  registration_status?: string | null;
  role?: string | null;
}

interface RawResponse {
  entries?: RawGuest[];
  guests?: RawGuest[];
}

export function buildLinkedinUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = String(input).trim();
  if (v.length === 0) return null;
  if (/^https?:\/\//i.test(v)) return v;
  // Handle no-scheme variants like "linkedin.com/in/sarah" or "www.linkedin.com/in/sarah":
  // strip the host prefix so we don't end up with "/in/linkedin.com/in/sarah".
  const cleaned = v.replace(/^(?:www\.)?linkedin\.com\/in\//i, "");
  return `https://www.linkedin.com/in/${cleaned.replace(/^@/, "")}`;
}

export function buildTwitterUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = String(input).trim();
  if (v.length === 0) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const cleaned = v.replace(/^(?:www\.)?(?:twitter\.com|x\.com)\//i, "");
  return `https://x.com/${cleaned.replace(/^@/, "")}`;
}

function projectRawGuest(raw: RawGuest): LumaPublicAttendee | null {
  const u = raw.user ?? null;
  const name = (u?.name ?? raw.name ?? "").trim();
  if (!name) return null;
  const profileUrl = u?.url ?? null;
  return {
    name,
    profileUrl,
    websiteUrl: u?.website ?? null,
    linkedinUrl: buildLinkedinUrl(u?.linkedin_handle),
    twitterUrl: buildTwitterUrl(u?.twitter_handle),
    bio: u?.bio_short ?? u?.bio ?? null,
    role: raw.role ?? raw.registration_status ?? null,
  };
}

/**
 * Fetch a Luma event's full guest list using the founder's session cookie.
 * Returns null on any failure mode (no cookie, expired cookie, 4xx, shape
 * drift, network blip) — the caller falls back to public-only mode.
 */
export async function fetchAuthedGuestList(
  eventSlug: string,
  cookie: string,
): Promise<LumaPublicAttendee[] | null> {
  if (!cookie || !eventSlug) return null;
  const cookieHeader = `${COOKIE_NAME}=${cookie}`;

  let lastStatus: number | null = null;
  for (const base of ENDPOINTS) {
    const url = `${base}?event_api_id=${encodeURIComponent(eventSlug)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Cookie: cookieHeader,
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "luma-events.auth_fetch",
          slug: eventSlug,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      // Network blip — try the next endpoint, but don't keep retrying
      // forever. The next iteration's fetch will either work or this catch
      // will fire again and exit the loop after the URL list is exhausted.
      lastStatus = null;
      continue;
    }
    lastStatus = res.status;
    if (res.status === 404) continue; // try next endpoint shape
    if (res.status === 401 || res.status === 403) {
      logEvent(
        "luma-events.auth_unauthorized",
        { slug: eventSlug, status: res.status },
        "warn",
      );
      return null;
    }
    if (!res.ok) {
      logEvent(
        "error.swallowed",
        { kind: "luma-events.auth_status", slug: eventSlug, status: res.status },
        "warn",
      );
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      logEvent(
        "error.swallowed",
        { kind: "luma-events.auth_parse", slug: eventSlug },
        "warn",
      );
      return null;
    }
    const parsed = body as RawResponse | null;
    const raws = parsed?.entries ?? parsed?.guests ?? null;
    if (!Array.isArray(raws)) {
      logEvent(
        "error.swallowed",
        { kind: "luma-events.auth_shape", slug: eventSlug },
        "warn",
      );
      return null;
    }
    const projected: LumaPublicAttendee[] = [];
    for (const raw of raws) {
      const a = projectRawGuest(raw);
      if (a) projected.push(a);
      if (projected.length >= MAX_AUTHED_ATTENDEES) break;
    }
    return projected;
  }
  // Both endpoints returned 404 — likely wrong slug or API path drift.
  if (lastStatus === 404) {
    logEvent(
      "error.swallowed",
      { kind: "luma-events.auth_404_all_endpoints", slug: eventSlug },
      "warn",
    );
  }
  return null;
}

/**
 * Merge public (LLM-extracted) attendees with auth'd attendees. Dedupe key is
 * the lowercased trimmed name; matches the per-event dedupe key used downstream.
 *
 * Per-field union: when both sides have an entry for the same name, the auth
 * value wins on conflict, but public values fill in any nulls. This handles
 * the realistic case where the auth API doesn't surface a field (`linkedinUrl`
 * = null) that the LLM caught from a visible attendee card.
 */
export function mergeAttendees(
  publicList: LumaPublicAttendee[],
  authedList: LumaPublicAttendee[],
): LumaPublicAttendee[] {
  const byName = new Map<string, LumaPublicAttendee>();
  for (const a of publicList) {
    const key = a.name.trim().toLowerCase();
    if (key.length === 0) continue;
    byName.set(key, a);
  }
  for (const auth of authedList) {
    const key = auth.name.trim().toLowerCase();
    if (key.length === 0) continue;
    const pub = byName.get(key);
    if (!pub) {
      byName.set(key, auth);
      continue;
    }
    byName.set(key, {
      name: auth.name, // canonical capitalization from the auth source
      profileUrl: auth.profileUrl ?? pub.profileUrl,
      websiteUrl: auth.websiteUrl ?? pub.websiteUrl,
      linkedinUrl: auth.linkedinUrl ?? pub.linkedinUrl,
      twitterUrl: auth.twitterUrl ?? pub.twitterUrl,
      bio: auth.bio ?? pub.bio,
      role: auth.role ?? pub.role,
    });
  }
  return [...byName.values()];
}
