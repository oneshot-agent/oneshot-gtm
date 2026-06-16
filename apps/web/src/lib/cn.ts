import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatUsd(n: number): string {
  const digits = n === 0 ? 2 : n < 0.01 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/**
 * SQLite's `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" in UTC with no
 * timezone marker. JavaScript's `new Date()` interprets such bare strings as
 * LOCAL time, which silently shifts every receipt / sequence_event / queue
 * row's displayed age by the user's UTC offset (UTC+2 → "2h ago" instead of
 * "just now"). Append "Z" so the value is unambiguously parsed as UTC. ISO
 * strings that already carry a "Z" or offset pass through unchanged.
 *
 * Exported separately so future date-rendering helpers can normalize too.
 */
export function normalizeUtcIso(iso: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso}Z` : iso;
}

/**
 * Humanize an event's ISO date to "today" / "tomorrow" / "this Tuesday" /
 * "next Tuesday" / "Sat Jun 21" for upcoming events, and "yesterday" /
 * "last Tuesday" / "last week" / "Sat Jun 21" for passed ones. Mirrors the
 * server-side prompt humanizer in packages/plays/src/luma-events.ts so the
 * queue UI reads the same way the LLM was told the date. Unparseable dates
 * fall back to the raw string.
 */
export function humanizeEventDate(iso: string): string {
  const d = new Date(normalizeUtcIso(iso));
  if (Number.isNaN(d.getTime())) return iso;
  const dayMs = 24 * 3600 * 1000;
  const days = Math.round((d.getTime() - Date.now()) / dayMs);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const absolute = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (days >= 0) {
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days <= 6) return `this ${weekday}`;
    if (days <= 13) return `next ${weekday}`;
    return absolute;
  }
  // Past: retrospective phrasing mirrors the play's describeEventDate.
  if (days < -14) return absolute;
  if (days === -1) return "yesterday";
  if (days >= -6) return `last ${weekday}`;
  return "last week";
}

/**
 * Whether an event's ISO date is in the past. Uses the SAME day-rounding
 * threshold as humanizeEventDate so "today" (delta 0) never reads as passed —
 * an all-day event whose UTC-midnight timestamp already slipped behind the
 * local clock still counts as today, not passed.
 */
export function eventIsPast(iso: string): boolean {
  const d = new Date(normalizeUtcIso(iso));
  if (Number.isNaN(d.getTime())) return false;
  return Math.round((d.getTime() - Date.now()) / (24 * 3600 * 1000)) < 0;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const seconds = Math.floor((Date.now() - new Date(normalizeUtcIso(iso)).getTime()) / 1000);
  // Future deltas cascade through the same buckets as past deltas — without
  // this, the /cadences "NEXT DUE" column rendered "in 150983s" instead of
  // "in 2d" for a step due ~42h from now. `Math.abs` once; bucket once.
  const future = seconds < 0;
  const abs = Math.abs(seconds);
  const suffix = (unit: string): string => (future ? `in ${unit}` : `${unit} ago`);
  if (abs < 60) return suffix(`${abs}s`);
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return suffix(`${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return suffix(`${hours}h`);
  const days = Math.floor(hours / 24);
  return suffix(`${days}d`);
}
