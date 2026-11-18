/**
 * A prospect's phone number as the dialler reads it: normalised to E.164, and
 * the clock where it rings, so the Calls page shows their local time and keeps
 * calls inside the workspace's call window.
 *
 * The zone comes from the number's prefix in libphonenumber's time-zone data
 * (vendored with its refresh script and provenance in
 * packages/core/vendor/phone-timezones/). A prefix that spans zones, or only
 * the country's calling code, gives every zone it may be in, and the call
 * window must hold in all of them. A number that places nobody gives no zone:
 * the caller does not guess one. People keep their numbers when they move, so
 * this is a hint, never a promise.
 */
import data from "../vendor/phone-timezones/phone-timezones.json";

const PREFIXES = data.prefixes as Record<string, string>;
const COUNTRIES = data.countries as Record<string, string[]>;
const LONGEST_PREFIX = Math.max(...Object.keys(PREFIXES).map((p) => p.length));

/** Where the data came from, for the provenance test and the docs. */
export const PHONE_TIMEZONE_DATA = {
  libphonenumber: data.libphonenumber,
  tzdb: data.tzdb,
  prefixes: Object.keys(PREFIXES).length,
};

const validZones = new Map<string, boolean>();
/** Whether the runtime knows the zone; a zone it does not know is never used. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  let ok = validZones.get(zone);
  if (ok === undefined) {
    try {
      ok = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
    } catch {
      ok = false;
    }
    validZones.set(zone, ok);
  }
  return ok;
}

/** Digits of an E.164 number ("+14155550123" or "14155550123"); null when it is not one. */
function e164Digits(phone: string): string | null {
  const digits = phone.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

/** Every zone the number's longest known prefix maps to; empty when the number or its country is unknown. */
export function phoneTimeZones(phone: string): string[] {
  const digits = e164Digits(phone);
  if (!digits) return [];
  for (let length = Math.min(LONGEST_PREFIX, digits.length); length > 0; length--) {
    const zones = PREFIXES[digits.slice(0, length)];
    if (zones) return zones.split("&").filter(isTimeZone);
  }
  return [];
}

/** The ISO country a zone belongs to (tz `zone.tab`); null when no country lists it. */
export function countryOfTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  const names = [zone, LEGACY_ZONES[zone]].filter((z): z is string => !!z);
  for (const [country, zones] of Object.entries(COUNTRIES)) {
    if (names.some((z) => zones.includes(z))) return country;
  }
  return null;
}

/**
 * Old names the runtime still accepts for a zone (tz `backward`) whose
 * country `zone.tab` lists only under the current name.
 */
const LEGACY_ZONES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "US/Eastern": "America/New_York",
  "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "US/Alaska": "America/Anchorage",
  "US/Hawaii": "Pacific/Honolulu",
};

/**
 * Calling code and trunk prefix for a national number written without its
 * country code. The North American plan is every NANP country; elsewhere the
 * countries a workspace is most likely to sit in. A country not listed reads
 * as the United States, the one most national numbers in the ledger are from.
 */
const NANP = new Set([
  "US",
  "CA",
  "PR",
  "VI",
  "GU",
  "AS",
  "MP",
  "BS",
  "BB",
  "AI",
  "AG",
  "VG",
  "KY",
  "BM",
  "GD",
  "TC",
  "MS",
  "SX",
  "LC",
  "DM",
  "VC",
  "TT",
  "KN",
  "JM",
  "DO",
]);
/**
 * `national`: the fixed length of a national number (without its trunk
 * prefix), for the countries whose numbers have one. It tells a number
 * written with its country code but no "+" ("4712345678", "61255504321")
 * from a national one.
 */
const CALLING_CODES: Record<string, { code: string; trunk: string | null; national?: number }> = {
  GB: { code: "44", trunk: "0", national: 10 },
  IE: { code: "353", trunk: "0" },
  FR: { code: "33", trunk: "0", national: 9 },
  DE: { code: "49", trunk: "0" },
  ES: { code: "34", trunk: null, national: 9 },
  IT: { code: "39", trunk: null },
  PT: { code: "351", trunk: null, national: 9 },
  NL: { code: "31", trunk: "0", national: 9 },
  BE: { code: "32", trunk: "0" },
  LU: { code: "352", trunk: null },
  CH: { code: "41", trunk: "0", national: 9 },
  AT: { code: "43", trunk: "0" },
  SE: { code: "46", trunk: "0" },
  NO: { code: "47", trunk: null, national: 8 },
  DK: { code: "45", trunk: null, national: 8 },
  FI: { code: "358", trunk: "0" },
  PL: { code: "48", trunk: null, national: 9 },
  CZ: { code: "420", trunk: null, national: 9 },
  GR: { code: "30", trunk: null, national: 10 },
  IL: { code: "972", trunk: "0" },
  AE: { code: "971", trunk: "0" },
  IN: { code: "91", trunk: "0", national: 10 },
  SG: { code: "65", trunk: null, national: 8 },
  HK: { code: "852", trunk: null, national: 8 },
  JP: { code: "81", trunk: "0" },
  KR: { code: "82", trunk: "0" },
  AU: { code: "61", trunk: "0", national: 9 },
  NZ: { code: "64", trunk: "0" },
  ZA: { code: "27", trunk: "0", national: 9 },
  NG: { code: "234", trunk: "0" },
  KE: { code: "254", trunk: "0", national: 9 },
  BR: { code: "55", trunk: "0" },
  MX: { code: "52", trunk: null, national: 10 },
  AR: { code: "54", trunk: "0" },
  CO: { code: "57", trunk: null, national: 10 },
  CL: { code: "56", trunk: null, national: 9 },
};

/** A North American number's ten digits are valid: area code and exchange both start 2–9. */
function nanpValid(ten: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten);
}

/** Whether some prefix of these E.164 digits is a known calling code or area. */
function knownPrefix(digits: string): boolean {
  for (let length = Math.min(LONGEST_PREFIX, digits.length); length > 0; length--) {
    if (PREFIXES[digits.slice(0, length)]) return true;
  }
  return false;
}

/** Extension markers, longest first, as they are written before the digits. */
const EXTENSION_MARKERS = ["extension", "ext=", "ext.", "ext", "x", "#"];

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isBlank = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * The number without a trailing extension ("x12", "ext. 12", ";ext=12",
 * "#12"), trimmed. A scan from the end, not a regex: the input is whatever a
 * lookup returned (CodeQL: polynomial backtracking).
 */
function withoutExtension(s: string): string {
  let i = s.length;
  while (isBlank(s[i - 1])) i--;
  const digitsEnd = i;
  while (isDigit(s[i - 1])) i--;
  const digits = digitsEnd - i;
  if (digits < 1 || digits > 6) return s;
  while (isBlank(s[i - 1])) i--;
  const head = s.slice(0, i).toLowerCase();
  const marker = EXTENSION_MARKERS.find((m) => head.endsWith(m));
  if (!marker) return s;
  i -= marker.length;
  while (isBlank(s[i - 1])) i--;
  // ";ext=": the RFC 3966 form keeps its semicolon.
  if (marker === "ext=") {
    if (s[i - 1] !== ";") return s;
    i--;
  }
  return s.slice(0, i).trim();
}

/** Check E.164 digits (no "+") and return the "+…" form, or null. */
function e164(digits: string): string | null {
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (digits.startsWith("1"))
    return digits.length === 11 && nanpValid(digits.slice(1)) ? `+${digits}` : null;
  return knownPrefix(digits) ? `+${digits}` : null;
}

/**
 * A phone number as stored (E.164 from a finder, or a raw string as a lookup
 * returned it: "(512) 653-1187", "+44 20 7946 0958", "001 …") as E.164, or
 * null for anything that is not a number (blank, letters, too short or long,
 * an unknown country code). A number written without its country code is read
 * as national to `defaultCountry` (ISO, e.g. "GB"; default "US"). An extension
 * ("x12", "ext. 12") is dropped: it cannot be dialled from a link.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: string | null = "US",
): string | null {
  if (typeof raw !== "string") return null;
  let s = withoutExtension(raw.trim().replace(/^tel:/i, "").trim());
  if (!s) return null;
  // Separators people and providers write; anything else (letters, a second
  // number) is not one number.
  if (!/^\+?[\d\s\-()./]+$/.test(s)) return null;
  const plus = s.startsWith("+");
  // "+44 (0)20 …" or "0044 (0)20 …": the bracketed trunk zero is a national
  // habit, not part of the number, where the country's plan has a trunk "0"
  // (Italy keeps it).
  const trunkZero = /^(?:\+|00)\d{1,3}\s*\(0\)/.test(s);
  s = s.replace(/\D/g, "");
  if (trunkZero) {
    const intl = plus ? "" : "00";
    const plan = Object.values(CALLING_CODES).find(
      (p) => p.trunk === "0" && s.startsWith(`${intl}${p.code}0`),
    );
    if (plan) s = `${intl}${plan.code}${s.slice(intl.length + plan.code.length + 1)}`;
  }
  if (plus) return e164(s);
  if (s.startsWith("00")) return e164(s.slice(2));
  const country = (defaultCountry ?? "US").toUpperCase();
  const plan = CALLING_CODES[country];
  if (!plan || NANP.has(country)) {
    if (s.length === 10) return nanpValid(s) ? `+1${s}` : null;
    if (s.length === 11 && s.startsWith("1")) return e164(s);
    return null;
  }
  const national = plan.trunk && s.startsWith(plan.trunk) ? s.slice(plan.trunk.length) : s;
  // Written with the country code but without "+": exactly the code plus
  // the fixed national length, where the plan has one (a national number is
  // shorter, so it is never misread); or the code plus at least eight, and
  // longer than any national number starting with those digits could be
  // (Italy, Germany, whose national numbers vary in length).
  // North American numbers never reach here: they are read above.
  // A trunk-prefix country's national form starts with its trunk "0", which
  // no calling code does, so the same reading holds there.
  if (
    s.startsWith(plan.code) &&
    ((plan.national != null && s.length === plan.code.length + plan.national) ||
      (s.length >= plan.code.length + 8 && s.length > 11))
  )
    return e164(s);
  return national.length >= 6 ? e164(`${plan.code}${national}`) : null;
}

/**
 * The country national numbers are read as in a workspace: the country of its
 * `timezone` when one is set and a country lists it, else the United States.
 */
export function defaultPhoneCountry(cfg: { timezone?: string | null }): string {
  return countryOfTimeZone(cfg.timezone ?? null) ?? "US";
}

/** The call window as `callsOf` resolves it. */
export interface CallWindow {
  start: string;
  end: string;
  weekdays: boolean;
}

/** The prospect's local clock, as the Calls page shows it (mirrors shared-types' `CallLocalTime`). */
export interface PhoneLocalTime {
  zones: string[];
  localTime: string | null;
  inWindow: boolean;
  opensAt: string | null;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();
function clockFormat(zone: string): Intl.DateTimeFormat {
  let f = clockFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      timeZoneName: "longOffset",
    });
    clockFormats.set(zone, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock in a zone at an instant. */
function wallClock(
  zone: string,
  at: Date,
): {
  y: number;
  m: number;
  d: number;
  minutes: number;
  weekday: number;
  offset: number;
  hhmm: string;
} {
  const parts = Object.fromEntries(
    clockFormat(zone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = Number(parts["hour"]) % 24;
  const minute = Number(parts["minute"]);
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parts["timeZoneName"] ?? "");
  const offset = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return {
    y: Number(parts["year"]),
    m: Number(parts["month"]),
    d: Number(parts["day"]),
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS.indexOf(parts["weekday"] ?? ""),
    offset,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function inWindowAt(zone: string, at: Date, window: CallWindow): boolean {
  const c = wallClock(zone, at);
  if (window.weekdays && (c.weekday === 0 || c.weekday === 6)) return false;
  return c.minutes >= minutesOf(window.start) && c.minutes < minutesOf(window.end);
}

/**
 * The instants a zone's wall clock reads `minutes` past midnight on y-m-d:
 * one, or two in the hour repeated when clocks go back. In the hour skipped
 * when they go forward, the instant just after the jump.
 */
function instantsAt(zone: string, y: number, m: number, d: number, minutes: number): number[] {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // The offsets either side of that day: a change on it is one of them.
  const offsets = new Set(
    [guess - 12 * 3600 * 1000, guess + 12 * 3600 * 1000].map(
      (t) => wallClock(zone, new Date(t)).offset,
    ),
  );
  const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const out = [...offsets]
    .map((offset) => guess - offset * 60_000)
    .filter((t) => {
      const c = wallClock(zone, new Date(t));
      return c.y === y && c.m === m && c.d === d && c.hhmm === hhmm;
    });
  if (out.length > 0) return out.toSorted((a, b) => a - b);
  const first = wallClock(zone, new Date(guess)).offset;
  const t = guess - first * 60_000;
  const second = wallClock(zone, new Date(t)).offset;
  return [second === first ? t : guess - second * 60_000];
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 3600 * 1000;

/**
 * The instants in (from, to] where a zone's UTC offset changes, to the
 * minute (tz rules change on whole minutes): a day-by-day read, narrowed
 * by halving the day where it changed.
 */
function offsetChanges(zone: string, from: number, to: number): number[] {
  const out: number[] = [];
  let a = Math.ceil(from / MINUTE_MS);
  let before = wallClock(zone, new Date(a * MINUTE_MS)).offset;
  const end = Math.floor(to / MINUTE_MS);
  while (a < end) {
    const b = Math.min(a + DAY_MS / MINUTE_MS, end);
    const after = wallClock(zone, new Date(b * MINUTE_MS)).offset;
    if (after !== before) {
      // offset(lo) is the old one, offset(hi) not: the change is at hi once they meet.
      let lo = a;
      let hi = b;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (wallClock(zone, new Date(mid * MINUTE_MS)).offset === before) lo = mid;
        else hi = mid;
      }
      out.push(hi * MINUTE_MS);
    }
    a = b;
    before = after;
  }
  return out;
}

/** How far ahead the window's next opening is looked for. */
const OPENS_HORIZON_DAYS = 8;

/**
 * The prospect's local time from their number, against the workspace's call
 * window: in window only when it holds in EVERY zone the number may be in,
 * and when not, the time it next opens in all of them. A number no zone is
 * known for, or whose zones never share an hour of the window (a calling code
 * that spans the Pacific and the Atlantic), reads as unknown: in window, no
 * zone, no local time.
 */
export function phoneLocalTime(
  phone: string | null | undefined,
  window: CallWindow,
  now: Date = new Date(),
): PhoneLocalTime {
  const unknown: PhoneLocalTime = { zones: [], localTime: null, inWindow: true, opensAt: null };
  if (!phone) return unknown;
  const zones = phoneTimeZones(phone);
  if (zones.length === 0) return unknown;
  // Every zone, at every instant checked: two zones on the same clock now
  // (Denver and Phoenix in winter) part when one of them changes for summer.
  // The zone that last refused is asked first.
  let blocker = zones[0]!;
  const all = (at: Date) => {
    if (!inWindowAt(blocker, at, window)) return false;
    const refuses = zones.find((zone) => zone !== blocker && !inWindowAt(zone, at, window));
    if (refuses) blocker = refuses;
    return !refuses;
  };
  const localTime = wallClock(zones[0]!, now).hhmm;
  if (all(now)) return { zones, localTime, inWindow: true, opensAt: null };
  // The shared window opens when the last zone's opens: one of the zones'
  // own opening times, or a clock change that jumps a zone into the window
  // (London's spring-forward over a 01:30 start opens it at 01:00 UTC).
  // Zones on the same clock now and at the horizon give the same times, so
  // one of each is enough to list them; every zone is still checked at each.
  const start = minutesOf(window.start);
  const horizon = new Date(now.getTime() + (OPENS_HORIZON_DAYS + 1) * 24 * 3600 * 1000);
  const byClock = new Map<string, string>();
  for (const zone of zones) {
    const key = `${wallClock(zone, now).offset}/${wallClock(zone, horizon).offset}`;
    if (!byClock.has(key)) byClock.set(key, zone);
  }
  const candidates = new Set<number>();
  for (const zone of byClock.values()) {
    const today = wallClock(zone, now);
    for (let i = 0; i <= OPENS_HORIZON_DAYS; i++) {
      const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
      const opening = instantsAt(
        zone,
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        start,
      );
      for (const t of opening) if (t > now.getTime()) candidates.add(t);
    }
    for (const t of offsetChanges(zone, now.getTime(), horizon.getTime())) candidates.add(t);
  }
  const opens = [...candidates].toSorted((a, b) => a - b).find((t) => all(new Date(t)));
  if (opens === undefined) return unknown;
  return { zones, localTime, inWindow: false, opensAt: new Date(opens).toISOString() };
}
