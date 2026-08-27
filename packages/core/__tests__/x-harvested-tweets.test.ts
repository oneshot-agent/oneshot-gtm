import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

const NOW = new Date("2026-08-27T09:00:00Z");
const SKIP_HOURS = 96;
const cutoff = (from: Date) => new Date(from.getTime() - SKIP_HOURS * 3600_000).toISOString();

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("x_harvested_tweets", () => {
  it("remembers what we already paid for", () => {
    ledger.recordXHarvestedTweets(["t1", "t2"], NOW.toISOString(), cutoff(NOW));
    const seen = ledger.recentXHarvestedTweetIds(cutoff(NOW));
    expect(seen.has("t1")).toBe(true);
    expect(seen.has("t9")).toBe(false);
  });

  it("forgets entries past the skip window, so tweets can be re-harvested later", () => {
    ledger.recordXHarvestedTweets(["old"], NOW.toISOString(), cutoff(NOW));
    const muchLater = new Date(NOW.getTime() + (SKIP_HOURS + 1) * 3600_000);
    expect(ledger.recentXHarvestedTweetIds(cutoff(muchLater)).size).toBe(0);
  });

  it("prunes on write so the table cannot silt", () => {
    ledger.recordXHarvestedTweets(["old"], NOW.toISOString(), cutoff(NOW));
    const later = new Date(NOW.getTime() + (SKIP_HOURS + 1) * 3600_000);
    ledger.recordXHarvestedTweets(["fresh"], later.toISOString(), cutoff(later));
    // A wide-open cutoff sees everything left in the table.
    const all = ledger.recentXHarvestedTweetIds("1970-01-01T00:00:00Z");
    expect([...all]).toEqual(["fresh"]);
  });

  it("accumulates across runs within the window", () => {
    ledger.recordXHarvestedTweets(["t1"], NOW.toISOString(), cutoff(NOW));
    const hourLater = new Date(NOW.getTime() + 3600_000);
    ledger.recordXHarvestedTweets(["t2"], hourLater.toISOString(), cutoff(hourLater));
    expect(ledger.recentXHarvestedTweetIds(cutoff(NOW)).size).toBe(2);
  });

  it("an empty table is an empty set", () => {
    expect(ledger.recentXHarvestedTweetIds(cutoff(NOW)).size).toBe(0);
  });

  it("re-recording an id refreshes its timestamp instead of throwing", () => {
    ledger.recordXHarvestedTweets(["t1"], NOW.toISOString(), cutoff(NOW));
    const later = new Date(NOW.getTime() + 3600_000);
    expect(() =>
      ledger.recordXHarvestedTweets(["t1"], later.toISOString(), cutoff(later)),
    ).not.toThrow();
    expect(ledger.recentXHarvestedTweetIds(cutoff(later)).size).toBe(1);
  });
});
