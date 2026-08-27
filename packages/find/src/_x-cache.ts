/**
 * Harvest replay cache for the x-reposters finder.
 *
 * Both X providers bill per resource returned, so re-running a harvest to try
 * a filter change costs real money — a day of that once emptied the X account.
 * Every live run saves its raw (post-enrichment) harvest here; a replay run
 * re-scores it offline for nothing.
 *
 * The companion state — tweet ids already paid for — lives in the SQLite
 * ledger (`x_harvested_tweets`), not here: it guards money and must be durable
 * and workspace-aware.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, logEvent } from "@oneshot-gtm/core";
import type { XCandidate } from "./_x-types.ts";

export interface CachedXHarvest {
  savedAt: string;
  engine: string;
  seeds: string[];
  tweetsScanned: number;
  candidates: XCandidate[];
}

export function xHarvestCacheDir(): string {
  return join(configDir(), "x-harvest-cache");
}

export function saveXHarvest(h: Omit<CachedXHarvest, "savedAt">, now: Date): string {
  const dir = xHarvestCacheDir();
  mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const path = join(dir, `${day}.json`);
  const body: CachedXHarvest = { savedAt: now.toISOString(), ...h };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  return path;
}

/** Newest cached harvest, or the one for `day` if given. Null if absent or unreadable. */
export function loadXHarvest(day?: string): (CachedXHarvest & { path: string }) | null {
  const dir = xHarvestCacheDir();
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted();
  const file = day ? files.find((f) => f.startsWith(day)) : files[files.length - 1];
  if (!file) return null;
  const path = join(dir, file);
  try {
    return { ...(JSON.parse(readFileSync(path, "utf-8")) as CachedXHarvest), path };
  } catch {
    logEvent("error.swallowed", { kind: "x-reposters.cache_unreadable", path });
    return null;
  }
}
