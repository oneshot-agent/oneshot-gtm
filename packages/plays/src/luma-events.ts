import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";

const PLAY_NAME = "luma-events";

/**
 * Humanize an ISO date to "tomorrow", "this Tuesday", "next Tuesday", or a
 * date like "Tue Jun 10". Keeps the prompt input concrete so the LLM doesn't
 * have to do calendar math (and can't accidentally say "next year").
 */
function humanizeEventDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const dayMs = 24 * 3600 * 1000;
  const days = Math.round((d.getTime() - now.getTime()) / dayMs);
  if (days < 0) return d.toISOString().slice(0, 10);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  if (days <= 6) return `this ${weekday}`;
  if (days <= 13) return `next ${weekday}`;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export interface LumaEventsTarget {
  name: string;
  email: string;
  company?: string;
  /** One-line bio / role pulled from the prospect's Luma profile (e.g. "Founder @ AcmeAI"). */
  attendeeBio?: string;
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

export interface LumaEventsDraft {
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
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name}${t.company ? ` at ${t.company}` : ""}`,
      `ATTENDEE BIO/ROLE: ${t.attendeeBio ?? "(none)"}`,
      `EVENT TITLE: ${t.eventTitle}`,
      `EVENT CITY: ${t.eventCity}`,
      `EVENT DATE: ${humanizeEventDate(t.eventDate)} (${t.eventDate})`,
      `EVENT URL: ${t.eventUrl}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
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

export function runLumaEvents(
  opts: LumaEventsRunOptions,
): Promise<{ drafted: LumaEventsDraft[] }> {
  return runEmailPlay(lumaEventsDef, opts);
}
