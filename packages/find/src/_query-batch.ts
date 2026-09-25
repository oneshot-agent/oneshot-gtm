/**
 * Splits a long `companies` list into batches whose rendered search query
 * stays under a safe word-count bound, and rotates which batch is searched
 * first so a list longer than one batch isn't always scanned from the top.
 *
 * Search engines cap query length at roughly 32 words — including any
 * `site:`/date clauses the caller wraps around the company OR clause — so a
 * named-account list beyond a handful gets silently truncated or matches
 * nothing once ORed whole into one query (issue #708).
 */

/** Conservative word-count bound most major search engines respect. */
export const MAX_QUERY_WORDS = 32;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Greedily groups `companies` into batches: each batch grows as large as
 * possible while `buildQuery(batch)` — the caller's FULL query (role/persona
 * text, site clauses, date phrase, and all) with that batch's OR clause
 * substituted in — stays at or under `maxWords` words. Batch size therefore
 * follows the rendered query's actual length, not a fixed company count:
 * long company names or a wordy site clause both shrink the batch that still
 * fits, exactly as issue #708 asks.
 *
 * A single company whose own one-company query already exceeds `maxWords`
 * still gets its own batch rather than being dropped — an over-length query
 * beats a silently missing account.
 *
 * `companies.length === 0` returns `[[]]` (one empty batch), so a caller
 * that issues one query per batch keeps issuing exactly the one
 * companies-free query it always has — byte-for-byte unchanged.
 */
export function batchCompaniesByQueryLength(
  companies: readonly string[],
  buildQuery: (companyBatch: readonly string[]) => string,
  maxWords: number = MAX_QUERY_WORDS,
): string[][] {
  if (companies.length === 0) return [[]];
  const batches: string[][] = [];
  let current: string[] = [];
  for (const company of companies) {
    const candidate = [...current, company];
    if (current.length > 0 && wordCount(buildQuery(candidate)) > maxWords) {
      batches.push(current);
      current = [company];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Rotates `batches` so index `cursor mod batches.length` runs first — the
 * fairness knob issue #708 asks for: a `companies` list spanning several
 * batches shouldn't always have the same batch searched (and therefore
 * scored against `limit`/`maxCostUsd`) first on every run. `cursor` is
 * typically the trigger's last-poll epoch ms (see `registry.ts`), which
 * changes every run and so rotates the start deterministically with no new
 * persisted cursor state. A negative or fractional cursor is normalized the
 * same way.
 */
export function rotateBatches<T>(batches: readonly T[][], cursor: number): T[][] {
  if (batches.length <= 1) return [...batches];
  const start = ((Math.trunc(cursor) % batches.length) + batches.length) % batches.length;
  return [...batches.slice(start), ...batches.slice(0, start)];
}
