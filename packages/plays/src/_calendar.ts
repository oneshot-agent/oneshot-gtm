import {
  CalendarApiError,
  clearGmailTokenScope,
  gmailAccountFor,
  isFreemailDomain,
  listCalendarEvents,
  loadConfig,
  loadGmailTokens,
  logEvent,
  demoMode,
  getLedger,
  resolveIdentities,
  naiveLocalToInstant,
  EMAIL_RE,
  type CalendarEventAttendee,
  type CalendarEventItem,
  type EmailIdentity,
  type MeetingMatchMethod,
  type MeetingMatchStatus,
} from "@oneshot-gtm/core";

/**
 * Calendar ingest (issue #577): read the founder's designated calendar and
 * turn past meetings into rows the founder can log an outcome against.
 *
 * Deliberately NOT a TRIGGERS registry entry — triggers are spend-gated
 * candidate finders behind an approval-rate gate; this is a free read that
 * belongs in the scheduler tick body (see apps/server/src/scheduler.ts).
 */

/** poll_state key: JSON `{calendarId, identityId, updatedMin}`. */
const CALENDAR_WATERMARK_KEY = "calendar_events";
/**
 * poll_state key for the weekly belt-and-braces full resync (no
 * `updatedMin`) — guards against the silent-data-loss failure mode where a
 * meeting booked far in the future is invisible today (outside timeMax) and
 * by the time it slides into range its `updated` is already older than the
 * watermark, so an incremental poll would never see it.
 */
const CALENDAR_FULL_RESYNC_KEY = "calendar_events_full_resync";
const FULL_RESYNC_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** `updatedMin` is re-examined this much before the watermark — Google's timestamps are second-granular and delivery isn't strictly ordered. */
const WATERMARK_OVERLAP_MS = 10 * 60_000;
/** `timeMin` is an exclusive lower bound on the event's END. */
const TIME_MIN_MS = 90 * 24 * 60 * 60_000;
/**
 * `timeMax` is an exclusive upper bound on the event's START — and must be
 * ~400 days out, not 90: a meeting booked six months ahead is stamped
 * `updated` today; if it falls outside `timeMax` it's invisible now, and by
 * the time it slides into a narrower window its `updated` predates the
 * watermark, so it would never be ingested. This is the silent-data-loss bug
 * this design is built around.
 */
const TIME_MAX_MS = 400 * 24 * 60 * 60_000;
/** Mirrors REPLY_POLL_MAX_PAGES's precedent — bounds one poll after an install or outage. */
const CALENDAR_POLL_MAX_PAGES = 10;
const CALENDAR_PAGE_SIZE = 250;
/** More than this many externals reads as a webinar, not a 1:1 — auto-link is refused even on an exact hit. */
const LARGE_INVITE_THRESHOLD = 8;
const EXTERNAL_ATTENDEES_CAP = 20;
/** Fuzzy-match record floor; below this the event is stored unmatched rather than guessed at. */
const FUZZY_MATCH_THRESHOLD = 0.5;

/**
 * eventType values that are never a prospect call, even when they happen to
 * carry an external-looking address — `fromGmail` in particular
 * auto-creates flight/hotel events with a real external (airline/hotel)
 * address that would otherwise pass the self-block check.
 */
const EXCLUDED_EVENT_TYPES = new Set([
  "outOfOffice",
  "focusTime",
  "workingLocation",
  "birthday",
  "fromGmail",
]);

const RESOURCE_DOMAIN_RE = /\.(resource|group)\.calendar\.google\.com$/i;

function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailDomain(email: string): string | null {
  const at = email.indexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

/** Lowercase, NFD-strip diacritics, drop punctuation/honorifics, token set. */
function normalizeNameTokens(name: string | null | undefined): Set<string> {
  if (!name) return new Set();
  const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam"]);
  const stripped = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  return new Set(
    stripped
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !HONORIFICS.has(t)),
  );
}

/** True when the two token sets are the same (order-insensitive) non-empty set of tokens. */
function fullNameMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = normalizeNameTokens(a);
  const tb = normalizeNameTokens(b);
  if (ta.size === 0 || tb.size === 0 || ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

interface ProspectFuzzyRow {
  id: number;
  name: string | null;
  email: string | null;
  company: string | null;
}

/** A prospect candidate for the founder's own address set. */
function buildExclusionSet(cfg: ReturnType<typeof loadConfig>): Set<string> {
  const out = new Set<string>();
  if (cfg.founderEmail) out.add(canonicalizeEmail(cfg.founderEmail));
  for (const identity of resolveIdentities(cfg)) {
    if (identity.address) out.add(canonicalizeEmail(identity.address));
  }
  for (const entry of Object.values(loadGmailTokens())) {
    if (entry.address) out.add(canonicalizeEmail(entry.address));
  }
  return out;
}

interface CandidateAttendee {
  email: string;
  displayName: string | null;
}

/**
 * The external-candidate set: attendees[] ∪ {organizer.email} ∪
 * {creator.email}, minus the founder's own addresses and resource rows.
 * Deduped by email, order-stable.
 */
function externalCandidates(item: CalendarEventItem, exclusions: Set<string>): CandidateAttendee[] {
  const seen = new Map<string, CandidateAttendee>();
  const consider = (email: string | undefined, displayName?: string | null): void => {
    if (!email) return;
    const canon = canonicalizeEmail(email);
    if (exclusions.has(canon)) return;
    const domain = emailDomain(canon);
    if (domain && RESOURCE_DOMAIN_RE.test(`x.${domain}`)) return;
    if (!seen.has(canon)) seen.set(canon, { email: canon, displayName: displayName ?? null });
  };
  for (const a of item.attendees ?? []) {
    if (a.resource || a.self) continue;
    consider(a.email, (a as CalendarEventAttendee & { displayName?: string }).displayName);
  }
  consider(item.organizer?.email);
  consider(item.creator?.email);
  return [...seen.values()];
}

/** self:true attendee's own RSVP, or null if the founder isn't listed as an attendee at all. */
function selfResponseOf(item: CalendarEventItem): string | null {
  return item.attendees?.find((a) => a.self)?.responseStatus ?? null;
}

interface MatchResult {
  prospectId: number | null;
  suggestedProspectId: number | null;
  matchStatus: MeetingMatchStatus;
  matchMethod: MeetingMatchMethod;
  matchConfidence: number | null;
}

const NO_MATCH: MatchResult = {
  prospectId: null,
  suggestedProspectId: null,
  matchStatus: null,
  matchMethod: null,
  matchConfidence: null,
};

/**
 * Resolve a calendar event's external candidates to a prospect.
 *
 * 1. Exact — `findProspectByEmail` per candidate. One hit links outright
 *    (confidence 1.0). Multiple distinct prospects hit (two attendees who
 *    each independently match a ledger row) is the GOOD case, not a founder
 *    question: tie-break to the one with outreach history, most recent
 *    first; ambiguous only when neither has history.
 * 2. Fuzzy (suggestion only, NEVER auto-linked) — scored across every
 *    prospect: domain + full-name match (0.90, `name_domain`), unique
 *    prospect at the same domain (0.65, `domain`), exact full-name match at
 *    a different domain (0.55, `name` — the job-change case),
 *    description-scraped email (0.50, `description`). Record at >= 0.5.
 *
 * Downgrades even a single exact hit to `suggested` when `attendeesOmitted`
 * is set or there are more externals than `LARGE_INVITE_THRESHOLD` — you
 * cannot see the whole room, so auto-linking is refused.
 */
function matchCandidates(input: {
  candidates: CandidateAttendee[];
  descriptionEmails: string[];
  attendeesOmitted: boolean;
  ledger: ReturnType<typeof getLedger>;
  prospects: ProspectFuzzyRow[];
}): MatchResult {
  const { candidates, descriptionEmails, attendeesOmitted, ledger, prospects } = input;
  const tooLarge = candidates.length > LARGE_INVITE_THRESHOLD;

  // ── 1. Exact ──────────────────────────────────────────────────────────
  const exactHits = new Set<number>();
  for (const c of candidates) {
    const hit = ledger.findProspectByEmail(c.email);
    if (hit) exactHits.add(hit.id);
  }
  if (exactHits.size === 1) {
    const [prospectId] = [...exactHits];
    const downgrade = attendeesOmitted || tooLarge;
    return {
      prospectId: downgrade ? null : (prospectId ?? null),
      suggestedProspectId: downgrade ? (prospectId ?? null) : null,
      matchStatus: downgrade ? "suggested" : "exact",
      matchMethod: null,
      matchConfidence: 1.0,
    };
  }
  if (exactHits.size > 1) {
    // Tie-break to whichever exact hit has outreach history, most recent
    // first; ambiguous only when NONE of them do.
    let best: { id: number; at: string } | null = null;
    for (const id of exactHits) {
      if (!ledger.hasOutreachHistory(id)) continue;
      const at = ledger.lastOutreachAt(id) ?? "";
      if (!best || at > best.at) best = { id, at };
    }
    if (best) {
      const downgrade = attendeesOmitted || tooLarge;
      return {
        prospectId: downgrade ? null : best.id,
        suggestedProspectId: downgrade ? best.id : null,
        matchStatus: downgrade ? "suggested" : "exact",
        matchMethod: null,
        matchConfidence: 1.0,
      };
    }
    return { ...NO_MATCH, matchStatus: "ambiguous" };
  }

  // ── 2. Fuzzy (suggestion only) ───────────────────────────────────────
  let best: { prospectId: number; score: number; method: MeetingMatchMethod } | null = null;
  let bestTie = false;

  const domainCounts = new Map<string, number>();
  for (const p of prospects) {
    const d = p.email ? emailDomain(p.email) : null;
    if (d && !isFreemailDomain(d)) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
  }

  const record = (prospectId: number, score: number, method: MeetingMatchMethod): void => {
    if (!best || score > best.score) {
      best = { prospectId, score, method };
      bestTie = false;
    } else if (score === best.score && prospectId !== best.prospectId) {
      bestTie = true;
    }
  };

  for (const c of candidates) {
    const cDomain = emailDomain(c.email);
    const freemail = isFreemailDomain(cDomain);
    for (const p of prospects) {
      const pDomain = p.email ? emailDomain(p.email) : null;
      const nameMatches = fullNameMatch(c.displayName, p.name);
      if (!freemail && cDomain && pDomain && cDomain === pDomain) {
        if (nameMatches) {
          record(p.id, 0.9, "name_domain");
        } else if ((domainCounts.get(cDomain) ?? 0) === 1) {
          record(p.id, 0.65, "domain");
        }
        // Same-domain-but-several-prospects with no name match: too weak, dropped.
      } else if (nameMatches) {
        record(p.id, 0.55, "name");
      }
    }
  }
  // Description-scraped emails: fuzzy-only, exact-address match against a
  // prospect, but never auto-linked and always the lowest-confidence tier.
  for (const email of descriptionEmails) {
    const hit = ledger.findProspectByEmail(email);
    if (hit) record(hit.id, 0.5, "description");
  }

  if (!best || (best as { score: number }).score < FUZZY_MATCH_THRESHOLD) return NO_MATCH;
  if (bestTie) return { ...NO_MATCH, matchStatus: "ambiguous" };
  const b = best as { prospectId: number; score: number; method: MeetingMatchMethod };
  return {
    prospectId: null,
    suggestedProspectId: b.prospectId,
    matchStatus: "suggested",
    matchMethod: b.method,
    matchConfidence: b.score,
  };
}

/** Bounded scrape of an event description for a fuzzy-only linking signal — never persisted. */
function scrapeDescriptionEmails(description: string | undefined): string[] {
  if (!description) return [];
  const PROSE_SCAN_LIMIT = 8_000;
  const matches = description.slice(0, PROSE_SCAN_LIMIT).match(EMAIL_RE) ?? [];
  return [...new Set(matches.map((m) => canonicalizeEmail(m)))];
}

interface StoredWatermark {
  calendarId: string;
  identityId: string;
  updatedMin: string;
}

function parseWatermark(raw: string | null): StoredWatermark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredWatermark>;
    if (
      typeof v.calendarId === "string" &&
      typeof v.identityId === "string" &&
      typeof v.updatedMin === "string"
    ) {
      return { calendarId: v.calendarId, identityId: v.identityId, updatedMin: v.updatedMin };
    }
    return null;
  } catch {
    return null;
  }
}

export interface CalendarPollResult {
  /** True when the feature is off (no identity configured) or in demo mode — not an error. */
  idle: boolean;
  eventsPolled: number;
  meetingsIngested: number;
  matched: number;
  suggested: number;
  selfBlocksSkipped: number;
  resynced: boolean;
  clean: boolean;
}

const IDLE: CalendarPollResult = {
  idle: true,
  eventsPolled: 0,
  meetingsIngested: 0,
  matched: 0,
  suggested: 0,
  selfBlocksSkipped: 0,
  resynced: false,
  clean: true,
};

/** Logged once per dangling-identity-id sighting per process, not once per poll (10-min throttle would still spam otherwise). */
const loggedDanglingIdentity = new Set<string>();

/**
 * Poll the designated calendar, upsert every relevant event as a `meetings`
 * row, and (re)match its external attendees to a prospect. Belongs in the
 * scheduler tick body, throttled like the bounce sweep — nothing about a
 * meeting is minute-sensitive.
 */
export async function pollCalendarMeetings(): Promise<CalendarPollResult> {
  const cfg = loadConfig();
  if (demoMode() || !cfg.calendarIdentityId) return IDLE;

  const identity = resolveIdentities(cfg).find(
    (i): i is EmailIdentity & { provider: "gmail" } =>
      i.id === cfg.calendarIdentityId && i.provider === "gmail",
  );
  if (!identity) {
    if (!loggedDanglingIdentity.has(cfg.calendarIdentityId)) {
      loggedDanglingIdentity.add(cfg.calendarIdentityId);
      logEvent(
        "scheduler.calendar_poll.dangling_identity",
        { identity_id: cfg.calendarIdentityId },
        "warn",
      );
    }
    return IDLE;
  }
  const account = gmailAccountFor(identity);
  if (!account) {
    logEvent("scheduler.calendar_poll.no_token", { identity_id: identity.id }, "warn");
    return IDLE;
  }

  const calendarId = (cfg.calendarId || "primary").trim() || "primary";
  const ledger = getLedger();
  const exclusions = buildExclusionSet(cfg);
  const prospects = ledger.listProspectsForFuzzyMatch();

  const storedWatermark = parseWatermark(ledger.getPollWatermark(CALENDAR_WATERMARK_KEY));
  // Repointing the calendar or identity invalidates the watermark — a
  // mismatch forces a full-window resync, or the newly-pointed calendar
  // would be silently under-polled forever.
  const watermarkApplies =
    storedWatermark != null &&
    storedWatermark.calendarId === calendarId &&
    storedWatermark.identityId === identity.id;

  const fullResyncMarker = parseWatermark(ledger.getPollWatermark(CALENDAR_FULL_RESYNC_KEY));
  const dueForWeeklyResync =
    !fullResyncMarker ||
    fullResyncMarker.calendarId !== calendarId ||
    fullResyncMarker.identityId !== identity.id ||
    Date.now() - Date.parse(fullResyncMarker.updatedMin) >= FULL_RESYNC_INTERVAL_MS;

  const now = Date.now();
  const timeMin = new Date(now - TIME_MIN_MS).toISOString();
  const timeMax = new Date(now + TIME_MAX_MS).toISOString();

  const out: CalendarPollResult = { ...IDLE, idle: false };
  let resyncsUsed = 0;

  const walk = async (
    updatedMin: string | undefined,
    pageBudget: number,
  ): Promise<{
    newestUpdated: string | null;
    pagesUsed: number;
    clean: boolean;
    resyncRequested: boolean;
  }> => {
    let newestUpdated: string | null = null;
    let pageToken: string | undefined;
    let pagesUsed = 0;
    let clean = true;
    while (pagesUsed < pageBudget) {
      let page: Awaited<ReturnType<typeof listCalendarEvents>>;
      try {
        page = await listCalendarEvents(account, {
          calendarId,
          ...(updatedMin ? { updatedMin } : {}),
          timeMin,
          timeMax,
          maxResults: CALENDAR_PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
        });
      } catch (err) {
        if (err instanceof CalendarApiError && err.httpStatus === 410) {
          return { newestUpdated, pagesUsed, clean, resyncRequested: true };
        }
        if (
          err instanceof CalendarApiError &&
          err.googleStatus === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
        ) {
          // Live token disagrees with the persisted scope — clear it so the
          // reconnect affordance reappears (it would otherwise be invisible
          // exactly when it's needed).
          clearGmailTokenScope(identity.id);
        }
        clean = false;
        logEvent(
          "scheduler.calendar_poll.failed",
          { message_120: ((err as Error).message ?? "").slice(0, 120) },
          "warn",
        );
        break;
      }
      pagesUsed++;
      for (const item of page.items) {
        out.eventsPolled++;
        if (item.updated && (newestUpdated == null || item.updated > newestUpdated)) {
          newestUpdated = item.updated;
        }
        try {
          ingestEvent(item, { ledger, calendarId, exclusions, prospects, out, cfg });
        } catch (err) {
          logEvent(
            "scheduler.calendar_poll.event_failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120), event_id: item.id },
            "warn",
          );
        }
      }
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return { newestUpdated, pagesUsed, clean, resyncRequested: false };
  };

  const forceFullPull = !watermarkApplies || dueForWeeklyResync;
  const updatedMin =
    !forceFullPull && storedWatermark
      ? new Date(Date.parse(storedWatermark.updatedMin) - WATERMARK_OVERLAP_MS).toISOString()
      : undefined;

  let result = await walk(updatedMin, CALENDAR_POLL_MAX_PAGES);
  if (result.resyncRequested && resyncsUsed < 1) {
    resyncsUsed++;
    logEvent("scheduler.calendar_poll.resync", { calendar_id: calendarId }, "warn");
    result = await walk(undefined, CALENDAR_POLL_MAX_PAGES - result.pagesUsed);
    out.resynced = true;
  }
  out.clean = result.clean;

  // Advance the watermark only on a clean walk — a partial poll must not
  // move the cursor, or the gap the failure left behind is skipped rather
  // than re-covered by the next good poll.
  if (result.clean && result.newestUpdated) {
    const next =
      storedWatermark && !forceFullPull && result.newestUpdated < storedWatermark.updatedMin
        ? storedWatermark.updatedMin
        : result.newestUpdated;
    ledger.setPollWatermark(
      CALENDAR_WATERMARK_KEY,
      JSON.stringify({ calendarId, identityId: identity.id, updatedMin: next }),
    );
  }
  if (result.clean && forceFullPull) {
    ledger.setPollWatermark(
      CALENDAR_FULL_RESYNC_KEY,
      JSON.stringify({ calendarId, identityId: identity.id, updatedMin: new Date().toISOString() }),
    );
  }

  return out;
}

function ingestEvent(
  item: CalendarEventItem,
  ctx: {
    ledger: ReturnType<typeof getLedger>;
    calendarId: string;
    exclusions: Set<string>;
    prospects: ProspectFuzzyRow[];
    out: CalendarPollResult;
    cfg: ReturnType<typeof loadConfig>;
  },
): void {
  const { ledger, calendarId, exclusions, prospects, out, cfg } = ctx;

  // A cancellation for an event never seen is a no-op UPDATE, not an insert
  // — the stub has no start time to file a ghost row under. `upsertMeeting`
  // itself refuses to INSERT this shape; short-circuit here too so we skip
  // the (pointless) matching work for a stub.
  const existing = ledger.getMeeting(calendarId, item.id);
  if (!existing && item.status === "cancelled" && !item.start) {
    ledger.upsertMeeting({ calendarId, eventId: item.id, status: "cancelled" });
    return;
  }

  // Idempotency fast path: event_updated_at hasn't advanced — touch
  // last_seen_at only, skip re-deriving anything.
  if (existing && item.updated && existing.event_updated_at === item.updated) {
    ledger.touchMeetingLastSeen(calendarId, item.id);
    return;
  }

  const eventType = item.eventType ?? "default";
  if (EXCLUDED_EVENT_TYPES.has(eventType)) return;

  // A cancellation STUB (status cancelled, no start time — the shape a
  // cancelled event actually arrives in) for an event already in the
  // ledger: update status in place and stop. Stub payloads carry no
  // attendees, so falling through to the self-block check below would
  // wrongly read every existing-row cancellation as a self-block and
  // silently drop the status update — upsertMeeting's own COALESCE already
  // guarantees this never wipes summary/prospect_id/match_status.
  if (existing && item.status === "cancelled" && !item.start) {
    ledger.upsertMeeting({
      calendarId,
      eventId: item.id,
      status: "cancelled",
      eventUpdatedAt: item.updated ?? null,
    });
    out.meetingsIngested++;
    return;
  }

  const allDay = item.start?.date != null && item.start.dateTime == null;
  const zone = item.start?.timeZone ?? item.end?.timeZone ?? null;
  const installZone = cfg.timezone ?? undefined;
  const startsAt = allDay
    ? item.start?.date
      ? naiveLocalToInstant(item.start.date, zone ?? installZone ?? "UTC")
      : null
    : (item.start?.dateTime ?? null);
  const endsAt = allDay
    ? item.end?.date
      ? naiveLocalToInstant(item.end.date, zone ?? installZone ?? "UTC")
      : null
    : (item.end?.dateTime ?? null);

  const candidates = externalCandidates(item, exclusions);
  const fingerprint = candidates
    .map((c) => c.email)
    .toSorted()
    .join(",");

  // Self-block: no external candidate survives the exclusion set. Never
  // stored — a cancellation of one of these later is correctly a no-op
  // (never seen).
  if (candidates.length === 0) {
    out.selfBlocksSkipped++;
    return;
  }

  const descriptionEmails = scrapeDescriptionEmails(item.description);
  const attendeesOmitted = Boolean(item.attendeesOmitted);

  // A founder's dismiss must stick until the attendee set genuinely
  // changes — re-matching runs ONLY when the fingerprint changed since last
  // seen, or this event has never been matched at all. Without this, every
  // poll would re-suggest the prospect the founder just dismissed.
  const shouldRematch = !existing || existing.attendees_fingerprint !== fingerprint;

  const match = shouldRematch
    ? matchCandidates({
        candidates,
        descriptionEmails,
        attendeesOmitted,
        ledger,
        prospects,
      })
    : {
        prospectId: existing.prospect_id,
        suggestedProspectId: existing.suggested_prospect_id,
        matchStatus: existing.match_status,
        matchMethod: existing.match_method,
        matchConfidence: existing.match_confidence,
      };

  if (match.prospectId != null) out.matched++;
  else if (match.suggestedProspectId != null) out.suggested++;

  ledger.upsertMeeting({
    calendarId,
    eventId: item.id,
    icalUid: item.iCalUID ?? null,
    recurringEventId: item.recurringEventId ?? null,
    status: item.status ?? "confirmed",
    summary: item.summary ?? null,
    allDay,
    startsAt,
    endsAt,
    eventTimezone: zone,
    organizerEmail: item.organizer?.email ? canonicalizeEmail(item.organizer.email) : null,
    selfResponse: selfResponseOf(item),
    externalAttendeeCount: candidates.length,
    externalAttendeesJson: JSON.stringify(
      candidates.slice(0, EXTERNAL_ATTENDEES_CAP).map((c) => c.email),
    ),
    attendeesOmitted,
    matchStatus: match.matchStatus,
    matchMethod: match.matchMethod,
    matchConfidence: match.matchConfidence,
    prospectId: match.prospectId,
    suggestedProspectId: match.suggestedProspectId,
    eventUpdatedAt: item.updated ?? null,
    attendeesFingerprint: fingerprint,
  });
  out.meetingsIngested++;
}
