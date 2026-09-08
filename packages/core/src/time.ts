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
