import type { Database } from "bun:sqlite";
import { getSharedDb } from "./shared-db.ts";

/**
 * Cache persistence extracted from `Ledger` (#618) — the second slice of the
 * ledger split tracked in ROADMAP.md, after the fresh-install schema/inline
 * migrations moved to `ledger-schema.ts` (#452). Covers every cache `Ledger`
 * exposes: the product-research dossier cache, which owns its rows directly
 * in this ledger's own SQLite file, and the paid-lookup enrichment/LinkedIn
 * caches, which `Ledger` merely forwards to the cross-workspace `SharedDb`
 * (shared-db.ts) so the same person is never bought twice across products.
 *
 * `Ledger` keeps its exact public method names/signatures and constructs one
 * `LedgerCache` per instance, delegating every cache method to it — an
 * observer of the public surface sees no difference.
 */

/** How long a SUCCESSFUL enrichment is reused before refetching (profiles are stable). */
export const ENRICH_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/** How long a FAILED enrichment suppresses retries — long enough to ride out an SDK outage, short enough to self-heal. */
export const ENRICH_FAILURE_TTL_MS = 3 * 24 * 3600 * 1000;
/**
 * Hard ceiling on waiting for one enrichProfile call. The platform's enrich
 * tool has been observed HANGING (no error, no result, 5+ min) rather than
 * failing — callers race against this and treat a deadline as a failure.
 */
export const ENRICH_DEADLINE_MS = 120_000;

/**
 * How long a SUCCESSFUL person dossier (deepResearchPerson) is reused. Longer
 * than the enrich TTL: a person's org history and profiles change slowly, and
 * the call costs 10x as much (~$0.05 vs ~$0.005).
 */
export const RESEARCH_CACHE_TTL_MS = 90 * 24 * 3600 * 1000;
/**
 * Hard ceiling on one deepResearchPerson call. Its own doc comment puts it at
 * 2-5 minutes, so this sits above that rather than at the enrich ceiling — the
 * call is legitimately slow, and racing it at 120s would abandon work we paid for.
 */
export const RESEARCH_DEADLINE_MS = 360_000;

/** How long a FOUND LinkedIn URL is reused. Profile URLs effectively never change. */
export const LINKEDIN_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/**
 * How long a genuine MISS ("we searched, this person has no findable profile")
 * suppresses re-searching. Longer than the enrich failure TTL because a miss is
 * a real answer rather than an outage — but not permanent, since people do
 * create profiles. Every re-search costs ~$0.01, so this directly caps the
 * spend of repeatedly running finders over the same candidate pool.
 */
export const LINKEDIN_MISS_TTL_MS = 14 * 24 * 3600 * 1000;

export class LedgerCache {
  constructor(
    private db: Database,
    private path: string,
  ) {}

  /**
   * Paid-lookup caches live in the cross-workspace SHARED DB (shared-db.ts) —
   * the same person must never be bought twice across products. These methods
   * keep their contracts and delegate; this ledger's legacy cache rows are
   * copied across once on first use.
   */
  private shared(): ReturnType<typeof getSharedDb> {
    const shared = getSharedDb();
    shared.ensureImported(this.db, this.path);
    return shared;
  }

  getCachedEnrichment(
    email: string,
  ): { result_json: string; fetched_at: string; status: string | null } | null {
    return this.shared().getCachedEnrichment(email);
  }

  getCachedLinkedIn(
    queryKey: string,
  ): { url: string | null; status: string; fetched_at: string } | null {
    return this.shared().getCachedLinkedIn(queryKey);
  }

  setCachedLinkedIn(queryKey: string, url: string | null): void {
    this.shared().setCachedLinkedIn(queryKey, url);
  }

  setCachedEnrichment(email: string, resultJson: string): void {
    this.shared().setCachedEnrichment(email, resultJson);
  }

  setCachedEnrichmentFailure(email: string, message: string): void {
    this.shared().setCachedEnrichmentFailure(email, message);
  }

  getProductResearchCache(cacheKey: string, maxAgeMs: number): string | null {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const row = this.db
      .query(
        "SELECT dossier_json FROM product_research_cache WHERE cache_key = ? AND fetched_at >= ?",
      )
      .get(cacheKey, cutoff) as { dossier_json: string } | undefined;
    return row?.dossier_json ?? null;
  }

  setProductResearchCache(cacheKey: string, dossierJson: string): void {
    this.db
      .prepare(
        `INSERT INTO product_research_cache(cache_key, dossier_json, fetched_at)
         VALUES(?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           dossier_json = excluded.dossier_json,
           fetched_at = excluded.fetched_at`,
      )
      .run(cacheKey, dossierJson, new Date().toISOString());
  }
}
