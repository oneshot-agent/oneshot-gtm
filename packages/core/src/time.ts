/** `2026-08-27 02:30:00` — SQLite's `datetime('now')` form: UTC, no `T`/`Z`. */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Several tables store `datetime('now')` timestamps
 * (`"YYYY-MM-DD HH:MM:SS"`, UTC, no `T`/`Z`) while others already store ISO
 * strings. This normalizes either into ISO 8601 with a `Z` suffix so a merged
 * timeline's plain string sort stays chronological.
 *
 * ISO input is returned unchanged (idempotent) rather than blindly appended
 * with `Z` — appending unconditionally turns an already-`Z`-suffixed ISO
 * string into the `...ZZ` trap (`2026-09-08T10:00:00ZZ`), which is invalid
 * and fails `Date.parse`. Matching the exact SQLite shape, rather than a
 * looser `includes(" ")`/`includes("T")` check, is what makes this a safe
 * superset of every inline version it replaces.
 */
export function sqliteToIso(ts: string): string {
  return SQLITE_DATETIME.test(ts) ? `${ts.replace(" ", "T")}Z` : ts;
}

/** ISO date-time with no `Z` or offset, which `new Date()` would read as local time. */
const ZONELESS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function toDate(ts: string | Date): Date | null {
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts;
  // A zone-less time is UTC, as SQLite reads it, never the process's local zone.
  const iso = sqliteToIso(ts);
  const d = new Date(ZONELESS_ISO.test(iso) ? `${iso}Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Any timestamp (SQLite form, ISO `Z`, RFC 3339 with an offset, or a `Date`)
 * as SQLite's `datetime('now')` form. The cutoff for a string comparison
 * against an S column must be in this form: `' ' < 'T'`, so an ISO bound
 * mis-sorts every row from its own calendar day. Unparseable input is
 * returned as-is so a bad bound can't throw inside a query.
 */
export function toSqliteUtc(ts: string | Date): string {
  if (typeof ts === "string" && SQLITE_DATETIME.test(ts)) return ts;
  const d = toDate(ts);
  return d ? d.toISOString().slice(0, 19).replace("T", " ") : String(ts);
}

/** Any timestamp as `YYYY-MM-DDTHH:MM:SS.sssZ`; the web client's one format. */
export function toIsoUtc(ts: string | Date): string {
  const d = toDate(ts);
  return d ? d.toISOString() : String(ts);
}
