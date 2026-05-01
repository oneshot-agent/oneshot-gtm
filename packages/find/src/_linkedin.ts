import { logEvent, webSearch } from "@oneshot-gtm/core";

/**
 * Shared LinkedIn / phone capture helpers used across all finders. Centralises:
 * - `findLinkedInUrl`: webSearch-based LinkedIn-URL discovery (active lookup)
 * - `extractFirstPhone`: passive read of phone fields from enrichment SDK results
 *
 * Both feed the same goal — populate `target.linkedinUrl` and `target.phone` so
 * the founder sees these signals in /queue review and the prospect row carries
 * them after drain.
 */

const PLAY_NAME = "linkedin-lookup";

/** Match `linkedin.com/in/<slug>` profile URLs. The slug class is permissive
 *  enough to cover URL-encoded unicode slugs (e.g. `%E7%8E%8B`) which LinkedIn
 *  does serve for non-Latin display names. */
const LINKEDIN_PROFILE_RX =
  /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/[a-z0-9-_.%]+/i;

/** Per-process cache so the same `(fullName, disambiguators)` doesn't re-search
 *  within a run. `null` is a real cached value (means "we tried and missed"). */
const cache = new Map<string, string | null>();

/** Test-only: reset the cache between cases. */
export function _resetLinkedInCache(): void {
  cache.clear();
}

/**
 * Returns true when `url` looks like a LinkedIn profile URL (`linkedin.com/in/<slug>`).
 * Use to validate LLM-extracted `linkedinUrl` strings before persisting them —
 * the prompt instructs the LLM to emit only profile URLs but real outputs drift
 * (sometimes a `/posts/` URL, sometimes free-form prose).
 */
export function isLinkedInProfileUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  return LINKEDIN_PROFILE_RX.test(url.trim());
}

/**
 * Find a LinkedIn profile URL for a person via webSearch.
 *
 * Query shape: `"<fullName>" "<disambig1>" "<disambig2>" site:linkedin.com/in`.
 * The `site:` operator narrows results to actual profile pages (not company
 * pages or jobs). We iterate `webSearch` result URLs and return the first that
 * matches `linkedin.com/in/<slug>`. No regex over freeform text — webSearch
 * returns structured `{url, title, description}` results.
 *
 * Returns null on:
 *   - empty fullName
 *   - no result URL matches the LinkedIn-profile shape
 *   - webSearch throws (logged as `error.swallowed` so the caller's pipeline
 *     doesn't tear down)
 *
 * Cost: ~$0.01 per call (one webSearch). Cached per-run by
 * `(fullName, disambiguators)` so duplicate calls within a finder run are free.
 */
export async function findLinkedInUrl(args: {
  fullName: string;
  /** Optional tokens that narrow the search — company name, github handle,
   *  podcast name, cohort label, etc. Each becomes a quoted token in the query. */
  disambiguators?: string[];
  accumCost: (c: number | undefined) => void;
  /** Used in the error.swallowed event kind, e.g. "github-topics" or "show-hn". */
  errKindPrefix: string;
}): Promise<string | null> {
  const fullName = args.fullName.trim();
  if (fullName.length === 0) return null;

  const disambiguators = (args.disambiguators ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  const cacheKey = JSON.stringify([fullName.toLowerCase(), disambiguators.map((s) => s.toLowerCase())]);
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const tokens = [fullName, ...disambiguators];
  const query = `${tokens.map((t) => `"${t}"`).join(" ")} site:linkedin.com/in`;
  try {
    const search = await webSearch({ query, maxResults: 5 }, { playName: PLAY_NAME });
    args.accumCost(extractCost(search.result) ?? 0.01);
    for (const r of search.result.results ?? []) {
      const url = typeof r.url === "string" ? r.url : "";
      if (LINKEDIN_PROFILE_RX.test(url)) {
        cache.set(cacheKey, url);
        logEvent("linkedin.search.found", { full_name: fullName, url });
        return url;
      }
    }
    cache.set(cacheKey, null);
    logEvent("linkedin.search.miss", { full_name: fullName, disambiguators });
    return null;
  } catch (err) {
    cache.set(cacheKey, null);
    logEvent(
      "error.swallowed",
      {
        kind: `${args.errKindPrefix}.linkedin_search`,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

/**
 * Pull the first usable phone number out of either an enrichProfile or a
 * deepResearchPerson result shape. Both SDK results may surface a phone — this
 * is the single read site so finders don't have to know which shape they got.
 *
 * Shapes accepted:
 *   - deepResearchPerson: `enrichment.fullphone[0].fullphone` (array of objects)
 *   - enrichProfile: `profile.phone` (single string)
 *   - LLM extracts: `extract.phone` (single string)
 *
 * Returns the raw string from whichever source. No normalization — defer
 * E.164 formatting until a downstream consumer needs it.
 */
export function extractFirstPhone(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const obj = source as Record<string, unknown>;

  // deepResearchPerson `enrichment.fullphone` array shape
  const fullphone = obj["fullphone"];
  if (Array.isArray(fullphone)) {
    for (const entry of fullphone) {
      if (entry && typeof entry === "object") {
        const v = (entry as Record<string, unknown>)["fullphone"];
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
      } else if (typeof entry === "string" && entry.trim().length > 0) {
        return entry.trim();
      }
    }
  }

  // enrichProfile `profile.phone` OR LLM-extract `extract.phone` shape
  const phone = obj["phone"];
  if (typeof phone === "string" && phone.trim().length > 0) return phone.trim();

  return null;
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
