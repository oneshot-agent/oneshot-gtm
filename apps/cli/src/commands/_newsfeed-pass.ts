import { NEWSFEED_CACHE_TTL_MS, type PersonResearchNewsfeed } from "@oneshot-gtm/core";
import {
  captureNewsfeedForProspect,
  captureNewsfeedForQueueRow,
  getCachedNewsfeed,
  isNewsfeedCircuitOpen,
  NEWSFEED_COST_ESTIMATE_USD,
} from "@oneshot-gtm/find";
import { c, note, ok, warn } from "../output.ts";

/**
 * The newsfeed pass shared by `research-queue` and `research-prospects`: after
 * the dossiers are written (or alone, under `--newsfeed-only`), capture each
 * row's recent posts one at a time and patch the pointer in. Posts are kept
 * for later use; nothing drafts from them yet.
 */

export interface NewsfeedItem {
  kind: "queue" | "prospect";
  id: number;
  playName: string;
  url: string;
}

export interface NewsfeedTally {
  captured: number;
  free: number;
  attached: number;
  failed: number;
  skipped: number;
  costUsd: number;
  cappedAt: number | null;
  haltedAt: number | null;
}

/**
 * The row's capture is current: its pointer names the profile this run would
 * capture, is younger than the cache TTL, and the posts are still cached. A
 * pointer for a different profile (the row gained a LinkedIn URL since) or one
 * whose cache entry is gone is not current.
 */
export function hasFreshPointer(pointer: unknown, url: string, now = Date.now()): boolean {
  if (!pointer || typeof pointer !== "object") return false;
  const value = pointer as Partial<PersonResearchNewsfeed>;
  if (value.url !== url) return false;
  const at = Date.parse(value.fetchedAt ?? "");
  if (Number.isNaN(at) || now - at >= NEWSFEED_CACHE_TTL_MS) return false;
  return getCachedNewsfeed(url) !== null;
}

/** One item per row; two rows for the same profile share one capture through the cache. */
export function dedupeItems(items: readonly NewsfeedItem[]): NewsfeedItem[] {
  const seen = new Set<string>();
  const out: NewsfeedItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** How many of these would be billed: profiles with no fresh capture in the cache, counted once. */
export function paidNewsfeedCount(items: readonly NewsfeedItem[]): number {
  const urls = new Set<string>();
  for (const item of items) if (!getCachedNewsfeed(item.url)) urls.add(item.url);
  return urls.size;
}

export function newsfeedEstimateLine(items: readonly NewsfeedItem[], cacheOnly: boolean): string {
  if (cacheOnly) {
    return `${c.dim("Newsfeed:")} cached captures only for ${items.length} rows; nothing is billed.`;
  }
  const paid = paidNewsfeedCount(items);
  return (
    `${c.dim("Newsfeed:")} ${items.length} rows with a LinkedIn or X profile, ${paid} to buy` +
    `  ${c.dim(`est. ~$${(paid * NEWSFEED_COST_ESTIMATE_USD).toFixed(2)} (one at a time, kept 14d)`)}`
  );
}

export async function runNewsfeedPass(
  items: readonly NewsfeedItem[],
  opts: { cacheOnly?: boolean; maxCostUsd?: number; spentUsd?: number },
): Promise<NewsfeedTally> {
  const tally: NewsfeedTally = {
    captured: 0,
    free: 0,
    attached: 0,
    failed: 0,
    skipped: 0,
    costUsd: 0,
    cappedAt: null,
    haltedAt: null,
  };
  const spentBefore = opts.spentUsd ?? 0;
  for (const [index, item] of items.entries()) {
    if (isNewsfeedCircuitOpen()) {
      tally.haltedAt = index;
      break;
    }
    const remainingUsd =
      opts.maxCostUsd != null
        ? Math.max(0, opts.maxCostUsd - spentBefore - tally.costUsd)
        : undefined;
    const call = {
      ...(opts.cacheOnly ? { cacheOnly: true } : {}),
      ...(remainingUsd !== undefined ? { remainingUsd } : {}),
    };
    let result: Awaited<ReturnType<typeof captureNewsfeedForQueueRow>>;
    try {
      result =
        item.kind === "queue"
          ? await captureNewsfeedForQueueRow(item.id, item.playName, call)
          : await captureNewsfeedForProspect(item.id, item.playName, call);
    } catch {
      // One row's write failing never ends the pass.
      tally.failed++;
      continue;
    }
    if (!result) {
      tally.skipped++;
      continue;
    }
    const { outcome } = result;
    // Past the cap, keep walking: a cached capture still attaches for free,
    // and every uncached one skips without a call.
    if (outcome.status === "skipped" && outcome.reason === "cost-cap") {
      tally.cappedAt ??= index;
      tally.skipped++;
      continue;
    }
    if (outcome.status === "skipped" && outcome.reason === "circuit-open") {
      tally.haltedAt = index;
      break;
    }
    if (outcome.status === "skipped") {
      tally.skipped++;
      continue;
    }
    if (outcome.status === "failed") {
      tally.failed++;
      continue;
    }
    tally.costUsd += outcome.costUsd;
    if (outcome.cached) tally.free++;
    else tally.captured++;
    if (result.attached) tally.attached++;
  }
  return tally;
}

export function reportNewsfeed(tally: NewsfeedTally, maxCostUsd: number | undefined): void {
  if (tally.cappedAt !== null) {
    warn(
      `Newsfeed stopped at the $${maxCostUsd?.toFixed(2)} ceiling after ${tally.cappedAt} rows. Re-run to continue.`,
    );
  }
  if (tally.haltedAt !== null) {
    warn(
      `Newsfeed paused after ${tally.haltedAt} rows — the tool kept failing. Re-run later to continue.`,
    );
  }
  ok(
    `newsfeed captured ${tally.captured}  ${c.dim("free (cached):")} ${tally.free}  ` +
      `${c.dim("pointer on dossier:")} ${tally.attached}  ${c.dim("failed:")} ${tally.failed}  ` +
      `${c.dim("skipped:")} ${tally.skipped}  ${c.dim("spent:")} $${tally.costUsd.toFixed(2)}`,
  );
  if (tally.captured + tally.free > tally.attached) {
    note("Rows without a dossier (or already sent) keep their posts in the cache only.");
  }
}
