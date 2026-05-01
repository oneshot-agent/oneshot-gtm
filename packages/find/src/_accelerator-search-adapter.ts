import { logEvent, webRead, webSearch } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { isLinkedInProfileUrl } from "./_linkedin.ts";
import type { AcceleratorLaunchExtract, CompanyRecord } from "./_types.ts";

/**
 * Fallback adapter for accelerators that DON'T publish a structured directory
 * (Techstars, Antler, 500 Global, AI Grant, SPC, Neo, …). Combo-search shape:
 * webSearch with cohort-derived queries, aggregate hits, dedupe, then per-hit
 * webRead + LLM extract.
 *
 * Less reliable than the yc-oss adapter (search recall depends on the
 * accelerator's web presence) but works without per-accelerator scrapers.
 */

const PLAY_NAME = "accelerator-batch";

interface SearchHit {
  url: string;
  title: string;
  description: string;
}

/**
 * Build the three search queries from a human-readable cohort label.
 * Founders supply `cohortLabel: "YC W26"` or `"Techstars Toronto Spring 2025"`
 * and we generate complementary queries. Three is enough to hit different
 * indexing patterns (launch posts vs portfolio pages vs press coverage)
 * without burning the search-call budget.
 */
export function buildCohortQueries(cohortLabel: string): string[] {
  const label = cohortLabel.trim();
  if (label.length === 0) return [];
  return [`"${label}" launch announcement`, `"${label}" portfolio company`, `"${label}" demo day`];
}

/**
 * Drop URL hosts that reliably fail per-page extraction or pollute results.
 * Aggregators (techcrunch, news.yc) carry batch lists, not company-specific
 * pages; social-media root paths surface profiles, not products.
 *
 * Conservative: an empty hit list breaks the finder, so only block hosts
 * that are NEVER useful per-record.
 */
export function looksLikeAcceleratorNoise(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return true; // un-parseable URL is always noise
  }
  // Listicles, social roots, video aggregators — never a per-company page.
  const noiseHosts = [
    "twitter.com",
    "x.com",
    "linkedin.com",
    "facebook.com",
    "youtube.com",
    "youtu.be",
    "reddit.com",
    "medium.com", // medium URLs sometimes work but recall is bad and noise is high
  ];
  if (noiseHosts.includes(host)) return true;
  // News aggregators that DO host accelerator coverage but rarely as
  // single-company pages — keep the option to surface specific paths later
  // by host-prefix matching, but block bare-host hits for now.
  if (host === "news.ycombinator.com") return true;
  if (host === "techcrunch.com") return true;
  return false;
}

/**
 * Fetch search hits for a non-YC accelerator cohort, then extract a
 * `CompanyRecord` per hit via LLM. Honors `limit` at the hit-count level so a
 * sparse search doesn't blow the per-record budget on noise.
 *
 * Cost is non-zero (webSearch + webRead + LLM extract per hit).
 */
export async function fetchAcceleratorSearch(
  _cohort: string,
  cohortLabel: string,
  limit: number,
): Promise<{ records: CompanyRecord[]; costUsd: number; diagnostic: string | null }> {
  const queries = buildCohortQueries(cohortLabel);
  if (queries.length === 0) {
    return {
      records: [],
      costUsd: 0,
      diagnostic: "set `cohortLabel` to the human-readable program name",
    };
  }

  let costUsd = 0;
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const query of queries) {
    if (hits.length >= limit * 2) break;
    try {
      const search = await webSearch(
        { query, maxResults: Math.min(15, limit) },
        { playName: PLAY_NAME },
      );
      costUsd += extractCost(search.result) ?? 0.01;
      for (const raw of search.result.results ?? []) {
        if (!raw.url || seen.has(raw.url)) continue;
        if (looksLikeAcceleratorNoise(raw.url)) continue;
        seen.add(raw.url);
        hits.push({ url: raw.url, title: raw.title, description: raw.description });
      }
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "accelerator-search.query",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }

  if (hits.length === 0) {
    return {
      records: [],
      costUsd,
      diagnostic: `no usable hits for '${cohortLabel}' — try a more specific cohortLabel (e.g. include the city/year)`,
    };
  }

  const system = loadPrompt("accelerator-launch-extract");
  const records: CompanyRecord[] = [];
  for (const hit of hits.slice(0, limit)) {
    let extract: AcceleratorLaunchExtract | null = null;
    try {
      const read = await webRead({ url: hit.url }, { playName: PLAY_NAME });
      costUsd += extractCost(read.result) ?? 0.02;
      const llm = await complete({
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              url: hit.url,
              title: hit.title,
              description: hit.description,
              markdown: (read.result.markdown ?? "").slice(0, 12000),
            }),
          },
        ],
        temperature: 0.1,
        maxTokens: 500,
      });
      extract = parseAcceleratorLaunchExtract(llm.content);
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "accelerator-search.read",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      continue;
    }
    if (!extract || !extract.company) continue;
    // The prompt instructs the LLM to return a bare hostname, but LLMs drift —
    // sanitize so an off-spec response can't break URL construction or pass
    // through paths/protocols into findEmail.
    const cleanDomain = sanitizeCompanyDomain(extract.companyDomain);
    const website = cleanDomain ? `https://${cleanDomain}` : null;
    records.push({
      name: extract.company,
      website,
      oneLiner: extract.oneLiner,
      longDescription: null,
      industry: null,
      tags: [],
      ycUrl: null,
      // The websearch extract returns founderName when the page named one
      // explicitly. Keep null here when it didn't — the pipeline still has
      // a chance to resolve via per-page extract on a different URL.
      founderName: extract.founderName?.trim() || null,
      founderLinkedinUrl: isLinkedInProfileUrl(extract.linkedinUrl)
        ? (extract.linkedinUrl as string).trim()
        : null,
      founderPhone: extract.phone?.trim() || null,
      source: "websearch",
    });
  }

  if (records.length === 0) {
    return {
      records: [],
      costUsd,
      diagnostic: `${hits.length} hits found but none extracted to a usable company record`,
    };
  }

  return { records, costUsd, diagnostic: null };
}

/**
 * Coerce an LLM-supplied "company domain" string into a bare hostname.
 * Strips scheme, leading `www.`, paths, query, and fragment. Returns null
 * for null/empty/invalid input.
 *
 * Prompt instructs the LLM to return bare hosts, but real-world outputs
 * include `https://www.foo.com/about`, `foo.com/`, ` foo.com `, etc. This
 * normalizes them so downstream `findEmail` always sees a clean domain.
 */
export function sanitizeCompanyDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  if (v.length === 0) return null;
  // Strip scheme.
  v = v.replace(/^https?:\/\//, "");
  // Strip leading www.
  v = v.replace(/^www\./, "");
  // Drop path / query / fragment / port.
  v = v.replace(/[/?#:].*$/, "");
  // Trim trailing dots.
  v = v.replace(/\.+$/, "");
  // Sanity: must contain a dot and at least one non-digit char to be a real domain.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return null;
  return v;
}

export function parseAcceleratorLaunchExtract(raw: string): AcceleratorLaunchExtract {
  return tryParseJsonObject<AcceleratorLaunchExtract>(raw, {
    company: null,
    companyDomain: null,
    oneLiner: null,
    founderName: null,
    founderRole: null,
    launchUrl: null,
    linkedinUrl: null,
    phone: null,
  });
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
