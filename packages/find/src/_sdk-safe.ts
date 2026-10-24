import {
  type CompanySearchInput,
  companySearch,
  deepResearchPerson,
  type EnrichCompanyInput,
  enrichCompany,
  findEmail,
  type GovSolicitationsInput,
  hasCached,
  isCachedPaidFailure,
  isPaidCacheMiss,
  govSolicitations,
  type LocalResolveInput,
  localResolve,
  type LocalSearchInput,
  localSearch,
  logEvent,
  type PaidCacheOptions,
  peopleSearch,
  type PeopleSearchInput,
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
 * Isolate failures from job-based contact-resolution SDK calls.
 * Log thrown errors as `error.swallowed` and return failure sentinels so
 * callers handle one candidate without aborting the parallel or sequential
 * batch. Forward CallContext unchanged to preserve audit metadata.
 */

function swallow(ctx: CallContext, call: string, err: unknown): void {
  // The paid cache's own answers (a miss under cacheOnly, a remembered
  // failure) are not new errors.
  if (isPaidCacheMiss(err) || isCachedPaidFailure(err)) return;
  logEvent(
    "error.swallowed",
    {
      kind: `${ctx.playName}.${call}`,
      message_120: ((err as Error).message ?? "").slice(0, 120),
    },
    "warn",
  );
}

/** findEmail that never throws. A failure resolves to `found: false` (drop). */
export async function safeFindEmail(
  input: FindEmailInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof findEmail>>> {
  try {
    return await findEmail(input, ctx, cache);
  } catch (err) {
    swallow(ctx, "find_email", err);
    // cost 0 / receiptId 0 mirror a cache hit: nothing was spent on this row.
    // A ValidationError is the SDK refusing the CALL (nothing was sent, nothing
    // billed): SDK 0.32 rejects findEmail without a person name. That is a
    // verdict about our input, not a backend outage: reported as "invalid" so
    // the spine drops the candidate instead of feeding the circuit breaker
    // five times and blacking out contact resolution for every finder. A
    // failure the paid cache remembers is a verdict too, never an outage.
    const status = isValidationError(err) || isCachedPaidFailure(err) ? "invalid" : "error";
    return { result: { status, email: null, found: false, cost: 0 }, receiptId: 0 };
  }
}

function isValidationError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    ((err as { name?: unknown }).name === "ValidationError" ||
      /\brequired\b/i.test(String((err as { message?: unknown }).message ?? "")))
  );
}

/** verifyEmail that never throws. A failure resolves to `deliverable: false` (drop). */
export async function safeVerifyEmail(
  input: VerifyEmailInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof verifyEmail>>> {
  try {
    return await verifyEmail(input, ctx, cache);
  } catch (err) {
    swallow(ctx, "verify_email", err);
    return {
      result: {
        // A remembered failure is a verdict (drop), not an outage (defer).
        status: isCachedPaidFailure(err) ? "invalid" : "error",
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
 * peopleSearch that never throws. A failure resolves to an empty result set
 * (no candidates found) instead of aborting the whole finder run.
 */
/**
 * Hard ceiling on one peopleSearch. The SDK polls a job with no end-to-end
 * deadline of its own; a wedged job otherwise blocks the finder forever
 * (measured 2026-09-07: a sequential run sat 10+ minutes on one domain
 * lookup with no receipt and no error). Past the deadline the call is a
 * platform error (deferred, breaker-fed) not a stall.
 */
const PEOPLE_SEARCH_DEADLINE_MS = 120_000;

export async function safePeopleSearch(
  input: PeopleSearchInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof peopleSearch>>> {
  try {
    return await withDeadline(
      peopleSearch(input, ctx, cache),
      PEOPLE_SEARCH_DEADLINE_MS,
      "peopleSearch",
    );
  } catch (err) {
    swallow(ctx, "people_search", err);
    return { result: { status: "error", results: [], total_found: 0, cost: 0 }, receiptId: 0 };
  }
}

/**
 * companySearch that never throws. A failure resolves to an empty result
 * set instead of aborting the whole finder run.
 */
export async function safeCompanySearch(
  input: CompanySearchInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof companySearch>>> {
  try {
    return await companySearch(input, ctx, cache);
  } catch (err) {
    swallow(ctx, "company_search", err);
    return { result: { status: "error", results: [], total_found: 0, cost: 0 }, receiptId: 0 };
  }
}

/**
 * enrichCompany that never throws. A failure resolves to an empty company
 * record (drop) instead of aborting the whole finder run.
 */
export async function safeEnrichCompany(
  input: EnrichCompanyInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof enrichCompany>>> {
  try {
    return await enrichCompany(input, ctx, cache);
  } catch (err) {
    swallow(ctx, "enrich_company", err);
    return { result: { status: "error", company: {}, cost: 0 }, receiptId: 0 };
  }
}

/**
 * govSolicitations that never throws. A failure resolves to an empty,
 * `status: "error"` result so the finder halts with a named platform
 * error instead of reading "no notices for these NAICS codes".
 */
export async function safeGovSolicitations(
  input: GovSolicitationsInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof govSolicitations>>> {
  try {
    return await govSolicitations(input, ctx, cache);
  } catch (err) {
    swallow(ctx, "gov_solicitations", err);
    return {
      result: {
        status: "error",
        results: [],
        total_found: 0,
        truncated: false,
        description_fetches: 0,
        cost: 0,
      },
      receiptId: 0,
    };
  }
}

/** localSearch that never throws: same `status: "error"` sentinel as safeCompanySearch. */
export async function safeLocalSearch(
  input: LocalSearchInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof localSearch>>> {
  try {
    return await localSearch(input, ctx, cache);
  } catch (err) {
    swallow(ctx, "local_search", err);
    return {
      result: {
        status: "error",
        results: [],
        total_found: 0,
        truncated: false,
        cost: 0,
      },
      receiptId: 0,
    };
  }
}

/**
 * localResolve that never throws. A failure resolves to `found: false`
 * (drop), the same shape a genuine miss already has.
 */
export async function safeLocalResolve(
  input: LocalResolveInput,
  ctx: CallContext,
  cache?: PaidCacheOptions,
): Promise<Awaited<ReturnType<typeof localResolve>>> {
  try {
    return await localResolve(input, ctx, cache);
  } catch (err) {
    swallow(ctx, "local_resolve", err);
    return {
      result: {
        status: "error",
        found: false,
        confidence: 0,
        result: null,
        candidates_considered: 0,
        cost: 0,
      },
      receiptId: 0,
    };
  }
}

/**
 * True when `safeDeepResearchPerson` would answer this input from the paid
 * cache for free: a fresh, successful entry. A negative entry does not count.
 * It returns the failed sentinel, which is not research.
 */
export function hasCachedResearch(input: DeepResearchPersonInput): boolean {
  if (!input.socialMediaUrl?.trim() && !input.email?.trim()) return false;
  return hasCached("research.person", input);
}

/** Graceful sentinel: the same `receiptId: 0` / `cost: 0` shape as a cache hit,
 *  so callers spend nothing and drop just this row. */
const FAILED_RESEARCH = {
  status: "failed",
  result: { enrichment: {} },
  request_id: "",
  cost: 0,
} as unknown as Awaited<ReturnType<typeof deepResearchPerson>>["result"];

/**
 * deepResearchPerson that never throws and cannot hang forever. The paid
 * cache under the wrapper answers repeats (and remembers genuine failures);
 * this adds the deadline, because the call is the slowest in the toolbox (2-5
 * min by its own doc comment). A purchase that outlives the deadline is still
 * stored by the cache when it settles.
 */
export async function safeDeepResearchPerson(
  input: DeepResearchPersonInput,
  ctx: CallContext,
  opts: PaidCacheOptions = {},
): Promise<Awaited<ReturnType<typeof deepResearchPerson>>> {
  // Cache only: a miss is never a paid call. Without a URL or an email there
  // is no person to look up, cached or not.
  if (opts.cacheOnly && !input.socialMediaUrl?.trim() && !input.email?.trim())
    return { result: FAILED_RESEARCH, receiptId: 0 };
  try {
    const live = deepResearchPerson(input, ctx, opts);
    // A deadline-abandoned promise must not surface as an unhandled rejection.
    live.catch(() => undefined);
    return await withDeadline(live, RESEARCH_DEADLINE_MS, "deepResearchPerson");
  } catch (err) {
    swallow(ctx, "deep_research_person", err);
    return { result: FAILED_RESEARCH, receiptId: 0 };
  }
}
