import {
  deepResearchPerson,
  ENRICH_FAILURE_TTL_MS,
  findEmail,
  getLedger,
  isTransientToolError,
  logEvent,
  RESEARCH_CACHE_TTL_MS,
  RESEARCH_DEADLINE_MS,
  verifyEmail,
  withDeadline,
} from "@oneshot-gtm/core";
import type {
  CallContext,
  DeepResearchPersonInput,
  FindEmailInput,
  VerifyEmailInput,
} from "@oneshot-gtm/core";

/**
 * Per-candidate-safe wrappers for the job-based contact-resolution SDK calls.
 *
 * Finders process candidates concurrently via `parallelMap` (errors propagate
 * through Promise.all) or in sequential loops. An unguarded throw from one
 * candidate's `findEmail`/`verifyEmail` — e.g. a OneShot backend job timeout —
 * rejects the whole batch and aborts the entire trigger run. These wrappers
 * swallow the throw, log `error.swallowed`, and return a graceful "not found /
 * not deliverable" sentinel so the caller's existing drop branch handles just
 * that candidate and the run continues. Same pattern as `enrichVerifiedContact`
 * (_enrich.ts) and `findLinkedInUrl` (_linkedin.ts). The full `CallContext` is
 * forwarded unchanged, so audit/decisionContext metadata is preserved.
 */

function swallow(ctx: CallContext, call: string, err: unknown): void {
  logEvent(
    "error.swallowed",
    {
      kind: `${ctx.playName}.${call}`,
      message_120: ((err as Error).message ?? "").slice(0, 120),
    },
    "warn",
  );
}

/** findEmail that never throws — a failure resolves to `found: false` (drop). */
export async function safeFindEmail(
  input: FindEmailInput,
  ctx: CallContext,
): Promise<Awaited<ReturnType<typeof findEmail>>> {
  try {
    return await findEmail(input, ctx);
  } catch (err) {
    swallow(ctx, "find_email", err);
    // cost 0 / receiptId 0 mirror the cache-miss sentinels in _enrich.ts.
    return { result: { status: "error", email: null, found: false, cost: 0 }, receiptId: 0 };
  }
}

/** verifyEmail that never throws — a failure resolves to `deliverable: false` (drop). */
export async function safeVerifyEmail(
  input: VerifyEmailInput,
  ctx: CallContext,
): Promise<Awaited<ReturnType<typeof verifyEmail>>> {
  try {
    return await verifyEmail(input, ctx);
  } catch (err) {
    swallow(ctx, "verify_email", err);
    return {
      result: {
        status: "error",
        email: input.email,
        valid: false,
        deliverable: false,
        catch_all: false,
        disposable: false,
        cost: 0,
      },
      receiptId: 0,
    };
  }
}

/**
 * Cache key for a person dossier. Namespaced like `webread:<label>` so it can
 * share the enrichment_cache table (which lives in the cross-workspace SHARED
 * db — the whole point being that a person researched for one product is never
 * re-bought for another). The social URL identifies a person more precisely
 * than an email, so it wins when both are present.
 */
export function personCacheKey(input: DeepResearchPersonInput): string | null {
  const url = input.socialMediaUrl?.trim().toLowerCase();
  if (url) return `person:${url}`;
  const email = input.email?.trim().toLowerCase();
  return email ? `person:${email}` : null;
}

/** Graceful sentinel — same `receiptId: 0` / `cost: 0` shape as the cache-miss
 *  sentinels in _enrich.ts, so callers spend nothing and drop just this row. */
const FAILED_RESEARCH = {
  status: "failed",
  result: { enrichment: {} },
  request_id: "",
  cost: 0,
} as unknown as Awaited<ReturnType<typeof deepResearchPerson>>["result"];

/**
 * deepResearchPerson that never throws, caches, and cannot hang forever.
 *
 * Modelled on `safeEnrich` (packages/plays/src/_lib.ts) rather than
 * safeFindEmail, because this call is both the most expensive (~$0.05, 10x
 * enrich) and the slowest (2-5 min by its own doc comment) in the toolbox —
 * it needs caching and a deadline, not just a try/catch. Before this wrapper
 * existed all three call sites hand-rolled a catch and none cached, so the
 * same person could be researched repeatedly at full price.
 */
export async function safeDeepResearchPerson(
  input: DeepResearchPersonInput,
  ctx: CallContext,
): Promise<Awaited<ReturnType<typeof deepResearchPerson>>> {
  const ledger = getLedger();
  const key = personCacheKey(input);

  if (key) {
    let cached: ReturnType<typeof ledger.getCachedEnrichment> = null;
    try {
      cached = ledger.getCachedEnrichment(key);
    } catch {
      // cache-READ failure = cache miss, never a research failure
    }
    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
      if (cached.status === "failed") {
        // Negative entry: a recent genuine failure. Don't re-buy until it expires.
        if (ageMs < ENRICH_FAILURE_TTL_MS) return { result: FAILED_RESEARCH, receiptId: 0 };
      } else if (ageMs < RESEARCH_CACHE_TTL_MS) {
        try {
          return { result: JSON.parse(cached.result_json), receiptId: 0 };
        } catch {
          // corrupt cache row — fall through and refetch
        }
      }
    }
  }

  try {
    const live = deepResearchPerson(input, ctx);
    // Cache writes ride the LIVE promise, not the deadline race: a call that
    // outlives the deadline was still PAID for and must reach the cache.
    live.then(
      (out) => {
        if (!key) return;
        try {
          ledger.setCachedEnrichment(key, JSON.stringify(out.result));
        } catch {
          // cache write is best-effort
        }
      },
      () => {
        // Handled by the catch below; this only silences the unhandled
        // rejection from the promise the deadline race abandons.
      },
    );
    return await withDeadline(live, RESEARCH_DEADLINE_MS, "deepResearchPerson");
  } catch (err) {
    swallow(ctx, "deep_research_person", err);
    // Only negative-cache a GENUINE failure. Caching a transient platform error
    // would make this person un-researchable for the whole failure TTL after
    // the platform recovers.
    if (key && !isTransientToolError(err)) {
      try {
        ledger.setCachedEnrichmentFailure(key, (err as Error).message ?? "research failed");
      } catch {
        // cache write is best-effort
      }
    }
    return { result: FAILED_RESEARCH, receiptId: 0 };
  }
}
