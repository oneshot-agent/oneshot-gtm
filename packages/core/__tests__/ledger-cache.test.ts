import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

/**
 * Focused coverage for the cache persistence extracted to `ledger-cache.ts`
 * (#618): hits, misses, expiry boundaries, replacement and invalidation,
 * exercised entirely through the public `Ledger` surface so this file also
 * proves the extraction changed nothing observable. `ledger.test.ts` already
 * covers the enrichment-cache negative-entry (failure/success) transitions
 * and a basic product-research hit/expiry pair — this file goes deeper on
 * boundary conditions and the LinkedIn cache, without duplicating those.
 */

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-ledger-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

/** Direct access to the underlying db to backdate a row's fetched_at, same pattern used elsewhere in this suite. */
function backdateProductResearchCache(cacheKey: string, fetchedAtIso: string): void {
  (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare("UPDATE product_research_cache SET fetched_at = ? WHERE cache_key = ?")
    .run(fetchedAtIso, cacheKey);
}

describe("product research cache — hits, misses, expiry boundaries, replacement", () => {
  it("is a miss for a key that was never written", () => {
    expect(ledger.getProductResearchCache("https://never-set.dev", 60_000)).toBeNull();
  });

  it("is a hit immediately after a write, within the TTL", () => {
    ledger.setProductResearchCache("https://acme.dev", '{"version":1}');
    expect(ledger.getProductResearchCache("https://acme.dev", 60_000)).toBe('{"version":1}');
  });

  it("is a miss once the row is older than maxAgeMs", () => {
    ledger.setProductResearchCache("https://acme.dev", '{"version":1}');
    backdateProductResearchCache("https://acme.dev", new Date(Date.now() - 120_000).toISOString());
    expect(ledger.getProductResearchCache("https://acme.dev", 60_000)).toBeNull();
  });

  it("expiry boundary: a row exactly at the cutoff is still a hit (>=, not >)", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const maxAgeMs = 60_000;
      ledger.setProductResearchCache("https://boundary.dev", '{"version":1}');
      // Row fetched exactly maxAgeMs ago: cutoff = now - maxAgeMs = fetchedAt.
      backdateProductResearchCache("https://boundary.dev", new Date(now - maxAgeMs).toISOString());
      expect(ledger.getProductResearchCache("https://boundary.dev", maxAgeMs)).toBe(
        '{"version":1}',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("expiry boundary: a row one millisecond past the cutoff is a miss", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const maxAgeMs = 60_000;
      ledger.setProductResearchCache("https://boundary2.dev", '{"version":1}');
      // Row fetched one millisecond before the cutoff.
      backdateProductResearchCache(
        "https://boundary2.dev",
        new Date(now - maxAgeMs - 1).toISOString(),
      );
      expect(ledger.getProductResearchCache("https://boundary2.dev", maxAgeMs)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a negative maxAgeMs always misses, even right after a write", () => {
    ledger.setProductResearchCache("https://acme.dev", '{"version":1}');
    expect(ledger.getProductResearchCache("https://acme.dev", -1)).toBeNull();
  });

  it("replacement: a second write for the same key overwrites the dossier and refreshes fetched_at", () => {
    ledger.setProductResearchCache("https://acme.dev", '{"version":1}');
    backdateProductResearchCache("https://acme.dev", new Date(Date.now() - 120_000).toISOString());
    // Stale by the old write's timestamp...
    expect(ledger.getProductResearchCache("https://acme.dev", 60_000)).toBeNull();
    // ...but a fresh write replaces both the payload and the freshness.
    ledger.setProductResearchCache("https://acme.dev", '{"version":2}');
    expect(ledger.getProductResearchCache("https://acme.dev", 60_000)).toBe('{"version":2}');
  });

  it("distinct cache keys never collide", () => {
    ledger.setProductResearchCache("https://a.dev", '{"co":"a"}');
    ledger.setProductResearchCache("https://b.dev", '{"co":"b"}');
    expect(ledger.getProductResearchCache("https://a.dev", 60_000)).toBe('{"co":"a"}');
    expect(ledger.getProductResearchCache("https://b.dev", 60_000)).toBe('{"co":"b"}');
  });
});

describe("enrichment cache (delegated to SharedDb) — hits, misses, replacement, invalidation", () => {
  it("is a miss for an email that was never enriched", () => {
    expect(ledger.getCachedEnrichment("nobody@acme.dev")).toBeNull();
  });

  it("is a hit after a successful enrichment write", () => {
    ledger.setCachedEnrichment("ada@acme.dev", '{"title":"CTO"}');
    expect(ledger.getCachedEnrichment("ada@acme.dev")).toMatchObject({
      result_json: '{"title":"CTO"}',
      status: null,
    });
  });

  it("replacement: a later success overwrites the earlier payload", () => {
    ledger.setCachedEnrichment("ada@acme.dev", '{"title":"CTO"}');
    ledger.setCachedEnrichment("ada@acme.dev", '{"title":"Founder"}');
    expect(ledger.getCachedEnrichment("ada@acme.dev")?.result_json).toBe('{"title":"Founder"}');
  });

  it("invalidation: a failure write marks the entry failed, suppressing the prior success", () => {
    ledger.setCachedEnrichment("ada@acme.dev", '{"title":"CTO"}');
    ledger.setCachedEnrichmentFailure("ada@acme.dev", "SDK outage");
    expect(ledger.getCachedEnrichment("ada@acme.dev")?.status).toBe("failed");
  });
});

describe("LinkedIn cache (delegated to SharedDb) — hits, misses, replacement", () => {
  it("is a miss (null row) for a query key never searched", () => {
    expect(ledger.getCachedLinkedIn("ada acme.dev")).toBeNull();
  });

  it("is a hit with status 'hit' when a URL was found", () => {
    ledger.setCachedLinkedIn("ada acme.dev", "https://linkedin.com/in/ada");
    expect(ledger.getCachedLinkedIn("ada acme.dev")).toMatchObject({
      url: "https://linkedin.com/in/ada",
      status: "hit",
    });
  });

  it("records a genuine miss (searched, not found) as status 'miss' with a null url — distinct from never having been queried", () => {
    ledger.setCachedLinkedIn("ghost person", null);
    const row = ledger.getCachedLinkedIn("ghost person");
    expect(row).toMatchObject({ url: null, status: "miss" });
    expect(row).not.toBeNull();
  });

  it("replacement: a later hit overwrites an earlier miss for the same query key", () => {
    ledger.setCachedLinkedIn("ada acme.dev", null);
    expect(ledger.getCachedLinkedIn("ada acme.dev")?.status).toBe("miss");
    ledger.setCachedLinkedIn("ada acme.dev", "https://linkedin.com/in/ada");
    expect(ledger.getCachedLinkedIn("ada acme.dev")).toMatchObject({
      url: "https://linkedin.com/in/ada",
      status: "hit",
    });
  });
});
