import { loadConfig } from "./config.ts";

/**
 * Event date/time rendering for draft prompts.
 *
 * The model must never do calendar arithmetic on an event timestamp. A Luma
 * event at 7:30pm on a Wednesday in San Francisco is `2026-08-27T02:30:00Z`;
 * handed that instant, an LLM reads "27" and writes "Thursday" into a cold
 * email about the reader's own event. That error is unrecoverable per contact.
 *
 * So every event instant is resolved HERE, to a human string in the event's
 * own local zone, before it reaches a prompt. Rendering goes through
 * `Intl.DateTimeFormat` — there is no hand-rolled offset arithmetic anywhere in
 * this module; the calendar-day helpers difference two zoned Y-M-D triples that
 * Intl produced, they never add or subtract an offset.
 */

/** `2026-08-26` — a calendar date with no time and no zone. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `2026-08-26T19:30` / `2026-08-26 19:30:00` — a wall clock with no zone. */
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * City → IANA zone for the cities the luma-events finder can be configured
 * with (mirrors `CITY_SLUGS` in `packages/find/src/_luma-discover.ts`, plus the
 * Bay Area suburbs Luma's `geo_address_info.city` actually returns). An
 * unmapped city resolves to null and the caller falls back to the install zone
 * — a wrong guess here would be worse than the founder's own timezone.
 */
const CITY_ZONES: Record<string, string> = {
  "san francisco": "America/Los_Angeles",
  sf: "America/Los_Angeles",
  "sf bay area": "America/Los_Angeles",
  "bay area": "America/Los_Angeles",
  oakland: "America/Los_Angeles",
  berkeley: "America/Los_Angeles",
  "palo alto": "America/Los_Angeles",
  "mountain view": "America/Los_Angeles",
  "menlo park": "America/Los_Angeles",
  "san jose": "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  la: "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  "new york": "America/New_York",
  "new york city": "America/New_York",
  nyc: "America/New_York",
  brooklyn: "America/New_York",
  boston: "America/New_York",
  miami: "America/New_York",
  washington: "America/New_York",
  "washington dc": "America/New_York",
  dc: "America/New_York",
  toronto: "America/Toronto",
  chicago: "America/Chicago",
  austin: "America/Chicago",
  denver: "America/Denver",
  london: "Europe/London",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam",
  vienna: "Europe/Vienna",
  wien: "Europe/Vienna",
  prague: "Europe/Prague",
  praha: "Europe/Prague",
  prag: "Europe/Prague",
  singapore: "Asia/Singapore",
  tokyo: "Asia/Tokyo",
  bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
};

/** True when `zone` is an IANA zone this runtime's ICU actually knows. */
export function isValidTimeZone(zone: string | null | undefined): boolean {
  if (!zone || typeof zone !== "string" || zone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Map an event city to an IANA zone, or null when the city isn't one we can
 * place confidently. "Online" / "Virtual" deliberately return null: a remote
 * event has no local time of its own, so the install zone is the honest answer.
 */
export function cityTimeZone(city: string | null | undefined): string | null {
  if (!city) return null;
  const normalized = city.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const direct = CITY_ZONES[normalized];
  if (direct) return direct;
  // Luma sometimes returns "San Francisco, CA" / "London, United Kingdom".
  const head = normalized.split(",")[0]?.trim();
  return (head && CITY_ZONES[head]) ?? null;
}

/**
 * The install's own zone: the optional `timezone` config field when the founder
 * set one, else whatever `Intl` says this machine is in. Pass `configuredZone`
 * to skip the config read (callers that already hold a loaded config).
 */
export function installTimeZone(configuredZone?: string | null): string {
  const explicit = configuredZone === undefined ? loadConfig().timezone : configuredZone;
  if (isValidTimeZone(explicit)) return explicit!.trim();
  const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(runtime) ? runtime : "UTC";
}

export interface EventZoneInput {
  /** Zone the source stamped on the event itself (Luma's `timezone` field). */
  zone?: string | null;
  /** The event's city, for the finder's configured `cities[]`. */
  city?: string | null;
  /** Install default. Omit to read it from config. */
  installZone?: string | null;
}

/**
 * Resolve the zone an event's date/time should be rendered in, in this order:
 *
 *   1. an explicit IANA zone on the candidate/event,
 *   2. a zone derived from the event's city,
 *   3. the install timezone (`timezone` config field, else the runtime zone).
 *
 * Every step is validated, so a garbage or unknown zone falls through to the
 * next one instead of throwing. Always returns a usable zone.
 */
export function resolveEventZone(input: EventZoneInput = {}): string {
  if (isValidTimeZone(input.zone)) return input.zone!.trim();
  const fromCity = cityTimeZone(input.city);
  if (isValidTimeZone(fromCity)) return fromCity!;
  return installTimeZone(input.installZone);
}

/**
 * An event's date/time as wall-clock fields in the target zone. `time` and
 * `tzAbbr` are null when the SOURCE carried no time or no zone — we render what
 * we were given rather than inventing a midnight or an abbreviation.
 */
interface WallClock {
  weekdayLong: string;
  weekdayShort: string;
  monthLong: string;
  monthShort: string;
  year: number;
  month: number;
  day: number;
  /** e.g. "7:30 PM". Null for a date-only source. */
  time: string | null;
  /** e.g. "PDT". Null when the source has no zone to convert from. */
  tzAbbr: string | null;
}

function partsOf(fmt: Intl.DateTimeFormat, at: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) out[p.type] = p.value;
  return out;
}

/** Weekday/month names for a bare calendar date — identical in every zone. */
function namesForCalendarDate(
  year: number,
  month: number,
  day: number,
): {
  weekdayLong: string;
  weekdayShort: string;
  monthLong: string;
  monthShort: string;
} {
  const at = new Date(Date.UTC(year, month - 1, day, 12));
  const long = partsOf(
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long" }),
    at,
  );
  const short = partsOf(
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short" }),
    at,
  );
  return {
    weekdayLong: long["weekday"] ?? "",
    weekdayShort: short["weekday"] ?? "",
    monthLong: long["month"] ?? "",
    monthShort: short["month"] ?? "",
  };
}

/** "19" + "30" -> "7:30 PM", without touching the machine's locale. */
function twelveHour(hour24: number, minute: number): string {
  const period = hour24 < 12 ? "AM" : "PM";
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${period}`;
}

/**
 * Resolve an event timestamp to wall-clock fields in `zone`.
 *
 * Three input shapes, because all three reach us from Luma:
 *   - `2026-08-26` (date-only, from the LLM extract): no conversion is possible
 *     or wanted — the calendar date IS the answer, rendered without a time.
 *   - `2026-08-26T19:30` (no offset): the wall clock is already local to the
 *     event; we present it verbatim and omit the zone abbreviation rather than
 *     guessing which zone it was written in.
 *   - `2026-08-27T02:30:00Z` / `+02:00` (a real instant): converted into `zone`
 *     by `Intl.DateTimeFormat`. This is the case the bug was about.
 *
 * Returns null when the string is not a timestamp at all.
 */
function wallClock(isoInstant: string, zone: string): WallClock | null {
  const raw = (isoInstant ?? "").trim();
  if (raw.length === 0) return null;

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    return {
      ...namesForCalendarDate(year, month, day),
      year,
      month,
      day,
      time: null,
      tzAbbr: null,
    };
  }

  const naive = NAIVE_DATETIME.exec(raw);
  if (naive) {
    const year = Number(naive[1]);
    const month = Number(naive[2]);
    const day = Number(naive[3]);
    return {
      ...namesForCalendarDate(year, month, day),
      year,
      month,
      day,
      time: twelveHour(Number(naive[4]), Number(naive[5])),
      tzAbbr: null,
    };
  }

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  const long = partsOf(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }),
    at,
  );
  const short = partsOf(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short" }),
    at,
  );
  const numeric = partsOf(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    at,
  );
  return {
    weekdayLong: long["weekday"] ?? "",
    weekdayShort: short["weekday"] ?? "",
    monthLong: long["month"] ?? "",
    monthShort: short["month"] ?? "",
    year: Number(numeric["year"]),
    month: Number(numeric["month"]),
    day: Number(numeric["day"]),
    time: `${long["hour"] ?? ""}:${long["minute"] ?? ""} ${long["dayPeriod"] ?? ""}`.trim(),
    tzAbbr: long["timeZoneName"] ?? null,
  };
}

/**
 * THE helper: render an event instant as one human string in `ianaZone`, e.g.
 * `Wednesday, August 26, 7:30 PM PDT`. This is the only value an event's
 * date/time should reach a draft prompt as.
 *
 * `ianaZone` is validated; a missing or unknown zone falls back to the install
 * timezone rather than throwing. Returns null when `isoInstant` isn't a
 * timestamp, so callers can decide what to say instead of printing "Invalid
 * Date" into an email.
 */
export function formatLocalEventTime(isoInstant: string, ianaZone?: string | null): string | null {
  const zone = isValidTimeZone(ianaZone) ? ianaZone!.trim() : installTimeZone();
  const wc = wallClock(isoInstant, zone);
  if (!wc) return null;
  const date = `${wc.weekdayLong}, ${wc.monthLong} ${wc.day}`;
  if (!wc.time) return date;
  return wc.tzAbbr ? `${date}, ${wc.time} ${wc.tzAbbr}` : `${date}, ${wc.time}`;
}

/**
 * The calendar day of an instant in `ianaZone`, e.g. `Monday, August 24, 2026`.
 * Used to anchor the prompt's "today" so relative phrasing ("next Wednesday")
 * is read off a stated date instead of guessed.
 */
export function formatLocalDay(isoInstant: string, ianaZone?: string | null): string | null {
  const zone = isValidTimeZone(ianaZone) ? ianaZone!.trim() : installTimeZone();
  const wc = wallClock(isoInstant, zone);
  if (!wc) return null;
  return `${wc.weekdayLong}, ${wc.monthLong} ${wc.day}, ${wc.year}`;
}

/** Long weekday name of an instant in `ianaZone` ("Wednesday"), or null. */
export function localWeekday(isoInstant: string, ianaZone?: string | null): string | null {
  const zone = isValidTimeZone(ianaZone) ? ianaZone!.trim() : installTimeZone();
  return wallClock(isoInstant, zone)?.weekdayLong ?? null;
}

/** Compact absolute date in `ianaZone` ("Sat, Jul 4"), or null. */
export function localShortDate(isoInstant: string, ianaZone?: string | null): string | null {
  const zone = isValidTimeZone(ianaZone) ? ianaZone!.trim() : installTimeZone();
  const wc = wallClock(isoInstant, zone);
  return wc ? `${wc.weekdayShort}, ${wc.monthShort} ${wc.day}` : null;
}

/**
 * Whole CALENDAR days from today to the event, counted in `ianaZone`: 0 =
 * today, 1 = tomorrow, -1 = yesterday. Differencing zoned Y-M-D triples (rather
 * than dividing a millisecond delta) is what makes "an event at 11pm tonight"
 * read as today instead of tomorrow.
 */
export function localDayOffset(
  isoInstant: string,
  ianaZone?: string | null,
  nowMs: number = Date.now(),
): number | null {
  const zone = isValidTimeZone(ianaZone) ? ianaZone!.trim() : installTimeZone();
  const event = wallClock(isoInstant, zone);
  const today = wallClock(new Date(nowMs).toISOString(), zone);
  if (!event || !today) return null;
  const a = Date.UTC(today.year, today.month - 1, today.day);
  const b = Date.UTC(event.year, event.month - 1, event.day);
  return Math.round((b - a) / 86_400_000);
}
