import { parseProspectPriority } from "@oneshot-gtm/core";

/**
 * Deterministic ranking for /queue review only; output is a permutation of
 * input. Drains, approvals, cadences, and sends do not use it.
 *
 * Cross-finder scores have different ranges and cannot be compared. Interleave
 * finders round-robin and use scores only to order rows within each finder.
 */

/** Interleave buckets; sparse buckets surrender unused capacity. */
export function roundRobin<T>(buckets: ReadonlyMap<string, readonly T[]>, cap: number): T[] {
  const out: T[] = [];
  const cursors = new Map<string, number>();
  let added = true;
  while (out.length < cap && added) {
    added = false;
    for (const [key, items] of buckets) {
      if (out.length >= cap) break;
      const cursor = cursors.get(key) ?? 0;
      const item = items[cursor];
      if (item === undefined) continue;
      out.push(item);
      cursors.set(key, cursor + 1);
      added = true;
    }
  }
  return out;
}

export interface RankableRow {
  id: number;
  play_name: string;
  dedupe_key: string;
  found_at: string;
  priority_json: string | null;
  payload_json: string;
}

export interface RankOptions {
  /** Every Kth slot goes to the exploration pool (unscored ∪ bottom decile). Default 5. */
  explorationInterval?: number;
}

/** Same stable hash as plays' admissionSlot: decisions must not flap across
 *  refetches. Exported for the calibration holdout split (_fit.ts), which
 *  needs the identical time-uncorrelated, refit-stable partition. */
export function stableHash(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function totalOf(row: RankableRow): number | null {
  return parseProspectPriority(row.priority_json)?.total ?? null;
}

/** Luma rows sub-bucket by city so review order preserves the finder's city diversity. */
function bucketKeyOf(row: RankableRow): string {
  if (row.play_name !== "luma-events") return row.play_name;
  let city = "";
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (typeof payload["eventCity"] === "string") city = payload["eventCity"];
  } catch {
    // malformed payload → default bucket
  }
  return `luma-events::${city}`;
}

/**
 * Rank by finder (Luma by city), then descending score within each bucket;
 * unscored rows go last. Interleave buckets in key order and reserve every Kth
 * slot for exploration so human labels include rows the heuristic dislikes.
 */
export function rankPendingRows<T extends RankableRow>(rows: T[], opts: RankOptions = {}): T[] {
  const interval = Math.max(2, opts.explorationInterval ?? 5);
  if (rows.length === 0) return [];

  const totals = new Map<number, number | null>(rows.map((r) => [r.id, totalOf(r)]));

  // Exploration pool: unscored rows plus the bottom decile of scored ones,
  // ordered by the stable hash so the rotation is deterministic per row set.
  const scoredTotals = [...totals.values()]
    .filter((t): t is number => t !== null)
    .toSorted((a, b) => a - b);
  const decileCut =
    scoredTotals.length > 0 ? scoredTotals[Math.floor(scoredTotals.length / 10)]! : null;
  const inPool = (r: T): boolean => {
    const t = totals.get(r.id) ?? null;
    return t === null || (decileCut !== null && t <= decileCut);
  };
  const pool = rows
    .filter(inPool)
    .toSorted((a, b) => stableHash(a.dedupe_key) - stableHash(b.dedupe_key) || a.id - b.id);
  const poolIds = new Set(pool.map((r) => r.id));

  // Main stream: per-bucket score desc → found_at desc → id desc, buckets
  // interleaved in KEY order: deliberately not by top score, because
  // cross-finder totals aren't comparable; interleaving is the fairness.
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    if (poolIds.has(row.id)) continue;
    const key = bucketKeyOf(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const orderedBuckets = new Map(
    [...buckets.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, items]) => [
        key,
        items.toSorted((a, b) => {
          const ta = totals.get(a.id) ?? -1;
          const tb = totals.get(b.id) ?? -1;
          if (tb !== ta) return tb - ta;
          if (a.found_at !== b.found_at) return a.found_at < b.found_at ? 1 : -1;
          return b.id - a.id;
        }),
      ]),
  );
  const stream = roundRobin(orderedBuckets, rows.length);

  // Weave: every `interval`-th slot pulls from the exploration pool; when one
  // side runs dry the other fills the remainder.
  const out: T[] = [];
  let s = 0;
  let e = 0;
  for (let slot = 0; out.length < rows.length; slot++) {
    const wantExploration = (slot + 1) % interval === 0;
    if ((wantExploration && e < pool.length) || s >= stream.length) {
      if (e < pool.length) out.push(pool[e++]!);
      else out.push(stream[s++]!);
    } else {
      out.push(stream[s++]!);
    }
  }
  return out;
}
