import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";

const PLAY_NAME = "luma-events";

/**
 * Past this many days, a passed event's guest-list signal is stale: we still
 * draft a (retrospective) email but hold it behind a `stale-event` flag for
 * founder review instead of auto-sending. Mirrored loosely by the queue UI's
 * "· passed" treatment (apps/web/src/lib/cn.ts).
 */
const STALE_AFTER_DAYS = 14;

/**
 * Classify an event's ISO date relative to now and produce a concrete human
 * phrase for the prompt. Three states drive the copy + send decision:
 *   - "upcoming": today or future → forward-looking pitch, auto-sends.
 *   - "past": within STALE_AFTER_DAYS behind → retrospective pitch, auto-sends.
 *   - "stale": further back → retrospective pitch but HELD (see runLumaEvents
 *     extraFlags). Signal too old to cold-open on without a human glance.
 * The phrase keeps the prompt input concrete so the LLM never does calendar
 * math (and can't infer a future weekday from a date that's already gone —
 * the bug this replaces: a passed Friday read back as "this Friday").
 */
function describeEventDate(iso: string): {
  status: "upcoming" | "past" | "stale";
  phrase: string;
} {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { status: "upcoming", phrase: iso };
  const dayMs = 24 * 3600 * 1000;
  const days = Math.round((d.getTime() - Date.now()) / dayMs);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const absolute = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

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
  /** ISO date or datetime; UI/prompt humanizes to "next Tuesday". */
  eventDate: string;
  /** City or "Online". */
  eventCity: string;
  /** luma.com/<slug>; founder reference only — prompt won't paste it in the body. */
  eventUrl: string;
  /** Founder-provided one-liner about why their product helps attendees of events like this. */
  yourEdge: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface LumaEventsRunOptions {
  dryRun: boolean;
  targets: LumaEventsTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
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
        companyDomain: emailDomain(t.email),
      },
      enrichSlice: 3500,
    }),
  buildInputBlock: (t, prep, cfg) => {
    const when = describeEventDate(t.eventDate);
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
      `EVENT CITY: ${t.eventCity}`,
      `EVENT DATE: ${when.phrase} (${t.eventDate})`,
      `EVENT TIMING: ${timing}`,
      `EVENT URL: ${t.eventUrl}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n");
  },
  // Hold (don't auto-send) drafts for events past the staleness window — the
  // guest-list signal is too old to cold-open on without a founder glance. A
  // non-empty flags array is what holds a draft (see _lib.ts sendDraftedEmail).
  extraFlags: (t) => (describeEventDate(t.eventDate).status === "stale" ? ["stale-event"] : []),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company ?? null,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "luma-events",
  }),
  metadata: (t) => ({ eventTitle: t.eventTitle, eventUrl: t.eventUrl, eventDate: t.eventDate }),
};

export function runLumaEvents(opts: LumaEventsRunOptions): Promise<{ drafted: LumaEventsDraft[] }> {
  return runEmailPlay(lumaEventsDef, opts);
}
