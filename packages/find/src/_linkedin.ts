import {
  getLedger,
  isTransientToolError,
  LINKEDIN_CACHE_TTL_MS,
  LINKEDIN_MISS_TTL_MS,
  logEvent,
  webSearch,
} from "@oneshot-gtm/core";
import { isCircuitOpen, recordResolutionOutcome } from "./_breaker.ts";

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
const LINKEDIN_PROFILE_RX = /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/[a-z0-9-_.%]+/i;

/** Per-process cache so the same `(fullName, disambiguators)` doesn't re-search
 *  within a run. `null` is a real cached value (means "we tried and missed"). */
const cache = new Map<string, string | null>();

/** Test-only: reset the cache between cases. */
export function _resetLinkedInCache(): void {
  cache.clear();
}

/** Lowercase, de-accent, reduce punctuation to spaces — so "Ben-Israel" and
 *  "ben israel" compare equal. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does this search result actually belong to the person we searched for?
 *
 * Checked against the result **title** — LinkedIn's own rendering of the
 * display name ("Elad Ben-Israel - Wing | LinkedIn"). Deliberately NOT the URL:
 * the slug is vanity text the member picks, so `/in/hackingonstuff` and
 * `/in/gtewari` are ordinary profiles and matching against it rejects ~1 in 4
 * correct hits.
 *
 * Rule: the surname must appear, plus at least one other name token. That
 * survives a middle name the profile omits ("Bradley Stuart Kirton" →
 * "Bradley Kirton") and an initial in place of a first name, while still
 * rejecting a same-first-name stranger.
 *
 * Returns true whenever the check can't reach a verdict — fewer than two
 * comparable tokens (a bare handle, a mononym, initials) or no title at all.
 * A guard that can neither confirm nor refute must not invent a rejection.
 */
export function nameMatchesTitle(title: string, name: string): boolean {
  // Whole-token comparison, never substring: "Ann Son" would otherwise match
  // "Joanne Johnson" ("ann" inside "joanne", "son" inside "johnson") and write
  // a stranger's profile.
  //
  // Short title tokens are kept, unlike the name side, so an initialised title
  // ("J. Smith") can still confirm "John Smith". Dropping them would reject a
  // correct profile AND cache that as a miss for LINKEDIN_MISS_TTL_MS.
  const titleTokens = fold(title)
    .split(" ")
    .filter((t) => t.length > 0);
  const tokens = fold(name)
    .split(" ")
    .filter((t) => t.length >= 3);
  if (tokens.length < 2 || titleTokens.length === 0) return true;
  // The surname is always compared in full — it's the load-bearing half, and
  // it's ≥3 chars, so no single-letter title token can satisfy it.
  const surname = tokens[tokens.length - 1] ?? "";
  if (!titleTokens.includes(surname)) return false;
  return tokens
    .slice(0, -1)
    .some((t) => titleTokens.some((tt) => tt === t || (tt.length === 1 && t.startsWith(tt))));
}

/** Words that mark a "name" as an organisation rather than a person. */
const ORG_WORDS = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "gmbh",
  "corp",
  "corporation",
  "labs",
  "lab",
  "software",
  "technologies",
  "technology",
  "solutions",
  "systems",
  "automation",
  "studio",
  "studios",
  "agency",
  "consulting",
  "group",
  "ventures",
  "capital",
  "bot",
  // Deliberately NOT "ai" or "co" — both collide with real given names.
]);

/**
 * True when a "name" is really an organisation ("ByteDance Inc.", "Baur
 * Software", "Atomic Bot").
 *
 * GitHub and Luma accounts are often orgs. Searching one as a person doesn't
 * miss — it finds *an* employee, and that lands outreach on someone with no
 * idea why. Cheaper and safer to not search at all.
 */
export function looksLikeOrgName(name: string | null | undefined): boolean {
  if (!name) return false;
  return fold(name)
    .split(" ")
    .some((t) => ORG_WORDS.has(t));
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
  /**
   * Called once per result discarded by the name/title check. Reporting only —
   * deliberately NOT a validation hook.
   *
   * There was a caller-supplied `accept` predicate here. It had a trap: both
   * caches key on (fullName, disambiguators) and return before any result
   * metadata exists, so a cache hit skipped the predicate and could hand back a
   * URL that same predicate had rejected minutes earlier. The built-in check
   * doesn't have that problem — it runs before a value is ever cached, so
   * anything in the cache was verified against the same name. Rather than
   * special-case the caches around an optional hook that no caller used, the
   * verification lives in one place and is not overridable.
   */
  onTitleMismatch?: (result: { url: string; title: string }) => void;
}): Promise<string | null> {
  const fullName = args.fullName.trim();
  if (fullName.length === 0) return null;

  // An org account can only resolve to some employee's profile, which is a
  // wrong answer that costs money to get.
  if (looksLikeOrgName(fullName)) {
    logEvent("linkedin.search.skipped_org", { full_name: fullName });
    return null;
  }

  const disambiguators = (args.disambiguators ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const cacheKey = JSON.stringify([
    fullName.toLowerCase(),
    disambiguators.map((s) => s.toLowerCase()),
  ]);
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  // Persistent cache. The in-process Map above only survives one run, so
  // without this every scheduler restart re-pays ~$0.01 for the same misses —
  // and this lookup now fires for every candidate, not just company-less ones.
  const persisted = readPersistedLookup(cacheKey);
  if (persisted !== undefined) {
    cache.set(cacheKey, persisted);
    return persisted;
  }

  // A webSearch outage would otherwise burn one call per candidate. The breaker
  // is shared with email resolution, so a platform-wide failure trips it once
  // and every subsequent candidate short-circuits for free.
  if (isCircuitOpen()) {
    logEvent("linkedin.search.skipped_breaker", { full_name: fullName });
    return null;
  }

  const tokens = [fullName, ...disambiguators];
  const query = `${tokens.map((t) => `"${t}"`).join(" ")} site:linkedin.com/in`;
  try {
    const search = await webSearch({ query, maxResults: 5 }, { playName: PLAY_NAME });
    args.accumCost(search.result.cost ?? 0);
    recordResolutionOutcome(false); // backend answered
    for (const r of search.result.results ?? []) {
      const url = typeof r.url === "string" ? r.url : "";
      if (LINKEDIN_PROFILE_RX.test(url)) {
        const title = typeof r.title === "string" ? r.title : "";
        // Verify before accepting. A `site:linkedin.com/in` search for a common
        // name happily returns a different person, and a wrong URL here isn't a
        // blank field — it's outreach to a stranger.
        if (!nameMatchesTitle(title, fullName)) {
          args.onTitleMismatch?.({ url, title });
          logEvent("linkedin.search.title_mismatch", { full_name: fullName, url, title });
          continue;
        }
        cache.set(cacheKey, url);
        writePersistedLookup(cacheKey, url);
        logEvent("linkedin.search.found", { full_name: fullName, url });
        return url;
      }
    }
    cache.set(cacheKey, null);
    writePersistedLookup(cacheKey, null);
    logEvent("linkedin.search.miss", { full_name: fullName, disambiguators });
    return null;
  } catch (err) {
    const transient = isTransientToolError(err);
    recordResolutionOutcome(transient);
    // Only persist a GENUINE miss. Caching a timeout/5xx would suppress this
    // person's lookup for LINKEDIN_MISS_TTL_MS after the platform recovers —
    // the same poisoning rule as _enrich.ts:130.
    if (!transient) writePersistedLookup(cacheKey, null);
    // The in-process entry is still set either way: within a single run there's
    // no point retrying a call that just failed.
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
 * Returns the cached URL, `null` for a cached miss, or `undefined` when there's
 * no usable entry (absent or expired) and the caller should search.
 */
function readPersistedLookup(cacheKey: string): string | null | undefined {
  try {
    const row = getLedger().getCachedLinkedIn(cacheKey);
    if (!row) return undefined;
    const age = Date.now() - new Date(row.fetched_at).getTime();
    if (!Number.isFinite(age) || age < 0) return undefined;
    const ttl = row.status === "hit" ? LINKEDIN_CACHE_TTL_MS : LINKEDIN_MISS_TTL_MS;
    if (age >= ttl) return undefined;
    return row.url ?? null;
  } catch {
    // Cache is an optimisation — a ledger hiccup must not stop the lookup.
    return undefined;
  }
}

function writePersistedLookup(cacheKey: string, url: string | null): void {
  try {
    getLedger().setCachedLinkedIn(cacheKey, url);
  } catch {
    /* best-effort */
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
