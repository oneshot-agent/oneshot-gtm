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
