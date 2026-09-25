import { logEvent, webRead, webSearch } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { AcceleratorLaunchExtract, CompanyRecord } from "./_types.ts";

/**
 * Adapter for accelerators without a structured directory (everyone but YC).
 * Reads the accelerator's own listing pages first, then search hits for the
 * cohort, and extracts EVERY company a page names (a demo-day recap or a class
 * list names dozens). Only companies the page ties to the target cohort's
 * year or label are kept, so an all-years portfolio index cannot flood the
 * queue. A company without a stated domain gets one from a name-only
 * companySearch in the pipeline, after the ICP gate.
 */

/** Pages read per cohort. Each read is slow (~75 s) and paid. */
export const MAX_PAGES_PER_COHORT = 5;
/** A long listing page is extracted in chunks of this size, up to `MAX_CHUNKS_PER_PAGE`. */
const CHUNK_CHARS = 24000;
const MAX_CHUNKS_PER_PAGE = 4;
/** Companies kept per cohort, after filtering. */
const MAX_COMPANIES_PER_COHORT = 300;

/** What the resolver knows about the cohort being searched (all optional for legacy cohorts). */
export interface CohortTarget {
  acceleratorName?: string;
  /** The name cohorts are announced under, when it differs ("Neo Accelerator"). */
  programName?: string;
  year?: number;
  listingUrls?: string[];
}

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

interface CohortCompany {
  name: string;
  domain: string | null;
  oneLiner: string | null;
  cohort: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseCohortExtract(raw: string): {
  aboutTargetCohort: boolean;
  companies: CohortCompany[];
} {
  const parsed = tryParseJsonObject<{ aboutTargetCohort?: unknown; companies?: unknown }>(raw, {});
  const list = Array.isArray(parsed.companies) ? parsed.companies : [];
  return {
    aboutTargetCohort: parsed.aboutTargetCohort === true,
    companies: list
      .map((c): CohortCompany | null => {
        if (!c || typeof c !== "object") return null;
        const o = c as Record<string, unknown>;
        const name = str(o["name"]);
        return name
          ? {
              name,
              domain: str(o["domain"]),
              oneLiner: str(o["oneLiner"]),
              cohort: str(o["cohort"]),
            }
          : null;
      })
      .filter((c): c is CohortCompany => c !== null),
  };
}

/**
 * Whether a company the page lists belongs to the target cohort: its stated
 * cohort names the target year or label; with no stated cohort, only when the
 * page as a whole is about the target cohort.
 */
export function inTargetCohort(
  company: { cohort: string | null },
  aboutTargetCohort: boolean,
  target: { year?: number; label: string },
): boolean {
  if (!company.cohort) return aboutTargetCohort;
  const c = company.cohort.toLowerCase();
  if (target.year !== undefined) return c.includes(String(target.year));
  return c.includes(target.label.toLowerCase());
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
 * Companies of one non-YC cohort: listing pages and search hits, read up to
 * `MAX_PAGES_PER_COHORT`, every company on each page extracted and filtered
 * to the target cohort. `limit` bounds search results, not companies — the
 * run's enqueue limit applies downstream.
 */
export async function fetchAcceleratorSearch(
  _cohort: string,
  cohortLabel: string,
  limit: number,
  target: CohortTarget = {},
): Promise<{ records: CompanyRecord[]; costUsd: number; diagnostic: string | null }> {
  const label = cohortLabel.trim();
  const queries = buildCohortQueries(label);
  if (queries.length === 0) {
    return {
      records: [],
      costUsd: 0,
      diagnostic: "set `cohortLabel` to the human-readable program name",
    };
  }
  const year =
    target.year ??
    (/\b(20\d{2})\b/.exec(label) ? Number(/\b(20\d{2})\b/.exec(label)![1]) : undefined);
  if (target.acceleratorName && year !== undefined) {
    queries.unshift(`"${target.acceleratorName}" ${year} batch companies`);
  }
  if (target.programName && year !== undefined) {
    queries.unshift(
      `"${target.programName}" ${year} companies`,
      `"${target.programName}" ${year} cohort`,
    );
  }

  let costUsd = 0;
  const seen = new Set<string>();
  const pages: SearchHit[] = [];
  for (const url of target.listingUrls ?? []) {
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push({ url, title: target.acceleratorName ?? "", description: "" });
  }
  for (const query of queries) {
    if (pages.length >= MAX_PAGES_PER_COHORT * 2) break;
    try {
      const search = await webSearch(
        { query, maxResults: Math.min(15, Math.max(5, limit)) },
        { playName: PLAY_NAME },
      );
      costUsd += search.result.cost ?? 0;
      for (const raw of search.result.results ?? []) {
        if (!raw.url || seen.has(raw.url)) continue;
        if (looksLikeAcceleratorNoise(raw.url)) continue;
        seen.add(raw.url);
        pages.push({ url: raw.url, title: raw.title, description: raw.description });
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

  if (pages.length === 0) {
    return {
      records: [],
      costUsd,
      diagnostic: `no usable hits for '${label}' — try a more specific cohortLabel (e.g. include the city/year)`,
    };
  }

  const system = loadPrompt("accelerator-cohort-extract");
  const byName = new Map<string, CohortCompany>();
  let pagesRead = 0;
  let readFailed = 0;
  for (const page of pages.slice(0, MAX_PAGES_PER_COHORT)) {
    try {
      const read = await webRead({ url: page.url }, { playName: PLAY_NAME });
      costUsd += read.result.cost ?? 0;
      pagesRead++;
      // A long listing page (an alphabetical portfolio) is read in chunks, so
      // the target cohort's companies past the first screenful are not lost.
      const markdown = read.result.markdown ?? "";
      const chunks = Math.min(
        MAX_CHUNKS_PER_PAGE,
        Math.max(1, Math.ceil(markdown.length / CHUNK_CHARS)),
      );
      let aboutTarget = false;
      const needle = year !== undefined ? String(year) : label.toLowerCase();
      const pageNamesTarget = `${page.title} ${page.url} ${markdown.slice(0, 3000)}`
        .toLowerCase()
        .includes(needle);
      const t = { ...(year !== undefined ? { year } : {}), label };
      for (let k = 0; k < chunks; k++) {
        const llm = await complete({
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: JSON.stringify({
                accelerator: target.programName ?? target.acceleratorName ?? label,
                targetCohort: label,
                targetYear: year ?? null,
                url: page.url,
                title: page.title,
                ...(chunks > 1 ? { part: `${k + 1} of ${chunks}` } : {}),
                markdown: markdown.slice(k * CHUNK_CHARS, (k + 1) * CHUNK_CHARS),
              }),
            },
          ],
          temperature: 0.1,
          maxTokens: 4000,
        });
        const extract = parseCohortExtract(llm.content);
        // The page's heading is usually in the first part: once any part says
        // the page is about the target cohort, the rest inherits it.
        // The model's say-so is not enough: a page counts as about the target
        // cohort only if it names the target year (or label) in its title,
        // URL or opening text. Otherwise an all-years alumni page would pass
        // its most famous companies off as this year's cohort.
        aboutTarget = aboutTarget || (extract.aboutTargetCohort && pageNamesTarget);
        for (const c of extract.companies) {
          if (!inTargetCohort(c, aboutTarget, t)) continue;
          const key = c.name.toLowerCase();
          const prior = byName.get(key);
          if (!prior || (!prior.domain && c.domain)) byName.set(key, c);
        }
      }
    } catch (err) {
      readFailed++;
      logEvent(
        "error.swallowed",
        {
          kind: "accelerator-search.read",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
    if (byName.size >= MAX_COMPANIES_PER_COHORT) break;
  }

  const records: CompanyRecord[] = [];
  for (const c of [...byName.values()].slice(0, MAX_COMPANIES_PER_COHORT)) {
    // A missing domain is looked up later, only for companies that pass the
    // ICP gate (accelerator-batch.ts), not for every name a page lists.
    const domain = sanitizeCompanyDomain(c.domain);
    records.push({
      name: c.name,
      website: domain ? `https://${domain}` : null,
      oneLiner: c.oneLiner,
      longDescription: null,
      industry: null,
      tags: [],
      ycUrl: null,
      founderName: null,
      founderLinkedinUrl: null,
      founderPhone: null,
      source: "websearch",
    });
  }

  if (records.length === 0) {
    return {
      records: [],
      costUsd,
      diagnostic: `${pagesRead} page${pagesRead === 1 ? "" : "s"} read${readFailed > 0 ? ` (${readFailed} failed)` : ""}, no ${label} companies found`,
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
