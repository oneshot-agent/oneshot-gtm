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
 * Shared LinkedIn / phone capture helpers used across all finders:
 * webSearch-based LinkedIn-URL discovery and passive phone extraction from
 * enrichment SDK results.
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
 * Does this search result belong to the person we searched for? Checked
 * against the result **title**, deliberately NOT the URL — the slug is vanity
 * text and matching it rejects real hits. Rule: the surname must appear, plus
 * at least one other name token. Returns true whenever the check can't reach
 * a verdict — a guard that can neither confirm nor refute must not invent a
 * rejection.
 */
export function nameMatchesTitle(title: string, name: string): boolean {
  // Whole-token comparison, never substring ("Ann Son" must not match "Joanne
  // Johnson"). Short title tokens are kept, unlike the name side, so an
  // initialised title ("J. Smith") can still confirm "John Smith".
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
 * True when a "name" is really an organisation. Searching an org as a person
 * doesn't miss — it finds *an* employee, landing outreach on the wrong human.
 */
export function looksLikeOrgName(name: string | null | undefined): boolean {
  if (!name) return false;
  return fold(name)
    .split(" ")
    .some((t) => ORG_WORDS.has(t));
}

/**
 * True when `url` looks like a LinkedIn profile URL. Validates LLM-extracted
 * `linkedinUrl` strings before persisting — real LLM outputs drift.
 */
export function isLinkedInProfileUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  return LINKEDIN_PROFILE_RX.test(url.trim());
}

/**
 * Find a LinkedIn profile URL for a person via webSearch
 * (`"<name>" "<disambig>" site:linkedin.com/in`). Returns the first result
 * matching the profile shape; null on empty name, no match, or a thrown
 * webSearch (swallowed so the caller's pipeline doesn't tear down). Cached
 * per-run and persistently by `(fullName, disambiguators)`.
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
   * deliberately NOT a validation hook: caches return before any result
   * metadata exists, so verification must stay built-in and non-overridable.
   */
  onTitleMismatch?: (result: { url: string; title: string }) => void;
}): Promise<string | null> {
  const fullName = args.fullName.trim();
  if (fullName.length === 0) return null;

  // An org account can only resolve to some employee's profile — a paid wrong answer.
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

  // Persistent cache — the in-process Map only survives one run.
  const persisted = readPersistedLookup(cacheKey);
  if (persisted !== undefined) {
    cache.set(cacheKey, persisted);
    return persisted;
  }

  // Breaker is shared with email resolution — a platform-wide failure trips it
  // once and every subsequent candidate short-circuits for free.
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
        // Verify before accepting — a wrong URL here isn't a blank field, it's
        // outreach to a stranger.
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
    // Only persist a GENUINE miss — caching a timeout/5xx would suppress this
    // person's lookup for LINKEDIN_MISS_TTL_MS after the platform recovers.
    if (!transient) writePersistedLookup(cacheKey, null);
    // The in-process entry is set either way: no point retrying within one run.
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
 * First usable phone from an enrichProfile (`profile.phone`), LLM extract
 * (`extract.phone`), or deepResearchPerson (`enrichment.fullphone[]`) shape —
 * the single read site for all three. Raw string, no E.164 normalization.
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
