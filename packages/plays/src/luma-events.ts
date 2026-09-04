import {
  formatLocalDay,
  formatLocalEventTime,
  localDayOffset,
  localShortDate,
  localWeekday,
  resolveEventZone,
} from "@oneshot-gtm/core";
import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { lumaEventsMetadata } from "./_metadata.ts";

const PLAY_NAME = "luma-events";

/**
 * Past this many days, a passed event's guest-list signal is stale: we still
 * draft a (retrospective) email but hold it behind a `stale-event` flag for
 * founder review instead of auto-sending. Mirrored loosely by the queue UI's
 * "· passed" treatment (apps/web/src/lib/cn.ts).
 */
const STALE_AFTER_DAYS = 14;

/**
 * Zone every date on this target is read and rendered in: an explicit zone from
 * the event page, else the event's city, else the install timezone. Resolved in
 * one place so the relative phrase, the absolute string, the "today" anchor and
 * the staleness flag can never disagree about what day it is.
 */
function zoneFor(t: Pick<LumaEventsTarget, "eventTimezone" | "eventCity">): string {
  return resolveEventZone({ zone: t.eventTimezone ?? null, city: t.eventCity });
}

/**
 * Classify an event's date relative to now — IN THE EVENT'S OWN ZONE — and
 * produce a concrete human phrase for the prompt. Three states drive the copy +
 * send decision:
 *   - "upcoming": today or future → forward-looking pitch, auto-sends.
 *   - "past": within STALE_AFTER_DAYS behind → retrospective pitch, auto-sends.
 *   - "stale": further back → retrospective pitch but HELD (see runLumaEvents
 *     extraFlags). Signal too old to cold-open on without a human glance.
 *
 * The phrase keeps the prompt input concrete so the LLM never does calendar
 * math (and can't infer a future weekday from a date that's already gone — the
 * bug this replaces: a passed Friday read back as "this Friday").
 *
 * The day count is a CALENDAR-day difference in `zone`, not a millisecond
 * delta: an event at 11pm tonight is "today", and 7:30pm Wednesday in SF is
 * Wednesday even though the instant is `…T02:30:00Z` on the Thursday.
 */
function describeEventDate(
  iso: string,
  zone: string,
): {
  status: "upcoming" | "past" | "stale";
  phrase: string;
} {
  const days = localDayOffset(iso, zone);
  if (days == null) return { status: "upcoming", phrase: iso };
  const weekday = localWeekday(iso, zone) ?? "";
  const absolute = localShortDate(iso, zone) ?? iso;

  // Future / today: forward-looking.
  if (days >= 0) {
    if (days === 0) return { status: "upcoming", phrase: "today" };
    if (days === 1) return { status: "upcoming", phrase: "tomorrow" };
    if (days <= 6) return { status: "upcoming", phrase: `this ${weekday}` };
    if (days <= 13) return { status: "upcoming", phrase: `next ${weekday}` };
    return { status: "upcoming", phrase: absolute };
  }

  // Past: retrospective. Beyond the staleness window we still draft, but hold.
  const status = days < -STALE_AFTER_DAYS ? "stale" : "past";
  if (status === "stale") return { status, phrase: absolute };
  if (days === -1) return { status, phrase: "yesterday" };
  if (days >= -6) return { status, phrase: `last ${weekday}` };
  return { status, phrase: "last week" };
}

export interface LumaEventsTarget {
  name: string;
  email: string;
  company?: string;
  /**
   * Company domain from enrichment, when it resolved one. Preferred over the
   * email's domain everywhere: an attendee's address is routinely a personal or
   * university one, which points enrichment and product research at the wrong
   * site (or nothing at all).
   */
  companyDomain?: string;
  /** One-line bio / role pulled from the prospect's Luma profile (e.g. "Founder @ AcmeAI"). */
  attendeeBio?: string;
  /**
   * Relationship to the event: "Host" (organizer) vs "Guest" (featured
   * attendee). Surfaced in the queue for review and fed to the prompt so a
   * host isn't pitched as if they're merely attending their own event.
   */
  role?: string;
  /** Event display name, e.g. "SF AI Builders Meetup". */
  eventTitle: string;
  /**
   * Short summary of what the event is about (from the Luma page). Grounds the
   * draft's TOPIC so the Offer/CTA aren't guessed from a vague title. Founder
   * reference only — the prompt won't quote it verbatim. Absent for events
   * found before this was wired (falls back to title-only inference).
   */
  eventDescription?: string;
  /**
   * ISO date or datetime — the machine field. Drives the upcoming/past
   * classification, the staleness hold and the queue UI's "· passed" treatment.
   * It is NEVER put in front of the model: `eventDateLocal` is.
   */
  eventDate: string;
  /**
   * IANA zone the event's times are in, resolved by the finder (explicit zone
   * on the page → the event's city → the install timezone). Absent on rows
   * queued before this existed; the play re-resolves from `eventCity` then.
   */
  eventTimezone?: string;
  /**
   * `eventDate` already rendered in `eventTimezone`, e.g.
   * "Wednesday, August 26, 7:30 PM PDT". This is the ONLY form of the event's
   * date/time the draft prompt sees — handed the raw instant, the model
   * converts it into its own zone and names the wrong weekday, which in a cold
   * email about the reader's own event is unrecoverable. Absent on older rows;
   * the play formats from `eventDate` + the resolved zone then.
   */
  eventDateLocal?: string;
  /** City or "Online". */
  eventCity: string;
  /** luma.com/<slug>; founder reference only — prompt won't paste it in the body. */
  eventUrl: string;
  /** Founder-provided one-liner about why their product helps attendees of events like this. */
  yourEdge: string;
  linkedinUrl?: string;
  phone?: string;
  /** The attendee's Luma profile URL. Persisted as a re-enrichment key. */
  sourceProfileUrl?: string;
  /** Job title from the person-level ICP gate — persisted to prospects.title. */
  title?: string;
}

export interface LumaEventsRunOptions {
  dryRun: boolean;
  targets: LumaEventsTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

interface LumaEventsDraft {
  target: LumaEventsTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const lumaEventsDef: EmailPlayDef<LumaEventsTarget> = {
  playName: PLAY_NAME,
  promptName: "luma-events-email",
  maxBodyWords: 150,
  // One-touch: events are time-sensitive — a multi-touch chase reads worse
  // than silence after the event passes. Matches show-hn / podcast-guest /
  // repo-interest.
  toEmail: (t) => t.email,
  // Enrich on preview + send (cached by email). No deepResearch — the event
  // attendance itself is the load-bearing signal.
  prepare: (t) =>
    standardEnrich({
      playName: PLAY_NAME,
      enrichInput: {
        ...(t.email ? { email: t.email } : {}),
        name: t.name,
        companyDomain: t.companyDomain ?? emailDomain(t.email),
      },
      enrichSlice: 3500,
    }),
  buildInputBlock: (t, prep, cfg) => {
    const zone = resolveEventZone({
      zone: t.eventTimezone ?? null,
      city: t.eventCity,
      installZone: cfg.timezone,
    });
    const when = describeEventDate(t.eventDate, zone);
    // Prefer the string the finder already rendered (it saw the event page's
    // own zone); fall back to formatting here for rows queued before that
    // existed, and to the relative phrase alone if the date won't parse. The
    // instant itself never reaches the prompt.
    const localWhen = t.eventDateLocal ?? formatLocalEventTime(t.eventDate, zone) ?? when.phrase;
    // Anchor "today" in the SAME zone so relative phrasing is read off a stated
    // date instead of the model's guess at what day it is.
    const todayLocal = formatLocalDay(new Date().toISOString(), zone) ?? "(unknown)";
    // "stale" still reads as PAST to the prompt — it drafts retrospectively;
    // the staleness only changes whether we hold (see extraFlags below).
    const timing =
      when.status === "upcoming"
        ? "UPCOMING"
        : "PAST — already happened, write retrospectively (do NOT use future tense)";
    return [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name}${t.company ? ` at ${t.company}` : ""}`,
      `ATTENDEE BIO/ROLE: ${t.attendeeBio ?? "(none)"}`,
      // "Host" = they RUN the event — never write as if they're merely going.
      `RELATIONSHIP TO EVENT: ${t.role ?? "(unknown — assume attendee)"}`,
      `EVENT TITLE: ${t.eventTitle}`,
      // Collapse whitespace defensively: the description is already flattened
      // upstream, but the LLM-extract path may still return newlines, and a raw
      // newline here would split the line-delimited input block mid-field.
      `EVENT ABOUT: ${(t.eventDescription ?? "").replace(/\s+/g, " ").trim().slice(0, 600) || "(none)"}`,
      `EVENT CITY: ${t.eventCity}`,
      `EVENT DATE: ${localWhen}`,
      `EVENT WHEN: ${when.phrase}`,
      `TODAY: ${todayLocal}`,
      `DATE NOTE: EVENT DATE and TODAY are ALREADY in the event's local time. Repeat the weekday, date and time exactly as written — never convert them to another timezone, never recompute the weekday, and never state a time the input doesn't show.`,
      `EVENT TIMING: ${timing}`,
      `EVENT URL: ${t.eventUrl}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n");
  },
  // Hold (don't auto-send) drafts for events past the staleness window — the
  // guest-list signal is too old to cold-open on without a founder glance. A
  // non-empty flags array is what holds a draft (see _lib.ts sendDraftedEmail).
  extraFlags: (t) =>
    describeEventDate(t.eventDate, zoneFor(t)).status === "stale" ? ["stale-event"] : [],
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company ?? null,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "luma-events",
    source_profile_url: t.sourceProfileUrl ?? null,
  }),
  metadata: lumaEventsMetadata,
};

export function runLumaEvents(opts: LumaEventsRunOptions): Promise<{ drafted: LumaEventsDraft[] }> {
  return runEmailPlay(lumaEventsDef, opts);
}
