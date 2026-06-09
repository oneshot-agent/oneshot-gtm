import { getLedger, logEvent, webRead, webSearch } from "@oneshot-gtm/core";
import { resolveAndVerifyContact } from "./_contact.ts";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { HiringSignalTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import type { FinderResult, HiringSignalExtract, RunOpts } from "./_types.ts";

const PLAY_NAME = "hiring-signal";
const SOURCE = "find:hiring-signal";

const ATS_DOMAIN_HINTS = [
  "boards.greenhouse.io",
  "jobs.lever.co",
  "apply.workable.com",
  "jobs.ashbyhq.com",
  "ashbyhq.com",
];

export interface HiringSignalFinderOpts extends RunOpts {
  /** Roles to scan for. Default: ["Staff Engineer","ML Engineer","Solutions Engineer"]. */
  roles?: string[];
  /** Optional company-name filter to bias results. */
  companies?: string[];
  /**
   * The "your one-line claim" that goes onto every queued target — required for the
   * downstream hiring-signal play. If unset, we fall back to a generic placeholder.
   */
  yourClaim?: string;
  /** Days back to bias the search query. Default 14. */
  sinceDays?: number;
}

const DEFAULT_ROLES = ["Staff Engineer", "ML Engineer", "Solutions Engineer"];

interface SearchHit {
  url: string;
  title: string;
  description: string;
}

export async function runHiringSignalFinder(opts: HiringSignalFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const sinceDays = opts.sinceDays ?? 14;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const system = loadPrompt("hiring-signal-extract");
  const roles = opts.roles && opts.roles.length > 0 ? opts.roles : DEFAULT_ROLES;
  // No hardcoded fallback claim — a generic one would assert a product capability
  // the founder may not have. The trigger's readiness gate blocks the scheduled
  // path; this guards the CLI/direct path so an empty claim never ships.
  const yourClaim = (opts.yourClaim ?? "").trim();

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  if (!yourClaim) {
    result.halted = "set `yourClaim` in the hiring-signal config";
    return result;
  }

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const sincePhrase = sinceDays <= 7 ? "this week" : `last ${sinceDays} days`;
  const domainCache = new Map<string, string | null>();

  for (const role of roles) {
    if (hits.length >= limit * 2) break;
    const companyClause =
      opts.companies && opts.companies.length > 0
        ? ` (${opts.companies.map((c) => `"${c}"`).join(" OR ")})`
        : "";
    const query = `"${role}"${companyClause} ${sincePhrase} (site:boards.greenhouse.io OR site:jobs.lever.co OR site:apply.workable.com OR site:jobs.ashbyhq.com)`;
    try {
      const search = await webSearch(
        { query, maxResults: Math.min(15, limit) },
        { playName: PLAY_NAME },
      );
      result.costUsd += search.result.cost ?? 0;
      for (const hit of search.result.results ?? []) {
        if (!hit.url || seen.has(hit.url) || !isAtsUrl(hit.url)) continue;
        seen.add(hit.url);
        hits.push({ url: hit.url, title: hit.title, description: hit.description });
      }
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "hiring-signal.webSearch",
          role,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }
  result.candidates = hits.length;

  for (const hit of hits.slice(0, limit)) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    if (ledger.isQueueDuplicate(PLAY_NAME, hit.url)) {
      result.droppedDuplicate++;
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    const filter = await icpFilter({
      icp,
      candidate: { title: hit.title, url: hit.url, summary: hit.description },
    });
    if (filter.match === null) {
      // Transient classifier failure (Anthropic 5xx, timeout, rate limit) —
      // drop without persisting. A rejection would burn the dedupeKey for
      // every future watch tick since isQueueDuplicate ignores status.
      result.droppedEnrichment++;
      continue;
    }
    if (!filter.match) {
      result.droppedIcp++;
      ledger.enqueueTarget({
        playName: PLAY_NAME,
        payload: { title: hit.title, url: hit.url, description: hit.description },
        dedupeKey: hit.url,
        source: SOURCE,
        initialStatus: "rejected",
        notes: `auto: ICP — ${filter.reason}`,
      });
      continue;
    }

    let extract: HiringSignalExtract;
    try {
      const read = await webRead({ url: hit.url }, { playName: PLAY_NAME });
      result.costUsd += read.result.cost ?? 0;
      const llm = await complete({
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              url: hit.url,
              markdown: (read.result.markdown ?? "").slice(0, 12000),
            }),
          },
        ],
        temperature: 0.1,
        maxTokens: 500,
      });
      extract = parseHiringSignalExtract(llm.content);
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "hiring-signal.llm.extract",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      result.droppedEnrichment++;
      continue;
    }

    if (!extract.jobTitle || !extract.company) {
      result.droppedEnrichment++;
      continue;
    }

    let domain = extract.companyDomain;
    if (!domain) {
      const resolved = await resolveCorporateDomain(extract.company, hit.url, domainCache);
      domain = resolved.domain;
      result.costUsd += resolved.costUsd;
    }
    if (!domain) {
      result.droppedEnrichment++;
      continue;
    }

    // Email target = the hiring manager when extracted, else fall back to a
    // best-effort search on the company domain (no name).
    const managerName =
      extract.hiringManagerName && extract.hiringManagerName.length > 0
        ? extract.hiringManagerName
        : null;
    const contact = await resolveAndVerifyContact({
      playName: PLAY_NAME,
      fullName: managerName,
      companyDomain: domain,
      isDuplicate: (email) => isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.url, prospectEmail: email }),
    });
    result.costUsd += contact.costUsd;
    if (!contact.ok) {
      if (contact.reason === "duplicate") result.droppedDuplicate++;
      else result.droppedEnrichment++;
      continue;
    }
    const email = contact.email;

    const recipientName = extract.hiringManagerName ?? contact.fullName;
    const enr = await enrichVerifiedContact(email, {
      playName: PLAY_NAME,
      errKindPrefix: "hiring-signal",
    });
    result.costUsd += enr.costUsd;
    // Priority mirrors LinkedIn chain: page-specific extract beats generic
    // enrichment lookup when both are set.
    const phone = (extract.phone || null) ?? enr.phone;
    let linkedinUrl: string | null = isLinkedInProfileUrl(extract.linkedinUrl)
      ? extract.linkedinUrl
      : null;
    linkedinUrl = linkedinUrl ?? enr.linkedinUrl;
    if (!linkedinUrl && recipientName) {
      linkedinUrl = await findLinkedInUrl({
        fullName: recipientName,
        disambiguators: [extract.company],
        accumCost: (c) => {
          result.costUsd += c ?? 0;
        },
        errKindPrefix: "hiring-signal",
      });
    }

    const target: HiringSignalTarget = {
      name: recipientName ?? "team",
      email,
      company: extract.company,
      jobTitle: extract.jobTitle,
      jobPostUrl: extract.jobUrl ?? hit.url,
      yourClaim,
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: hit.url,
      source: SOURCE,
      notes: `${extract.company} hiring "${extract.jobTitle}"${extract.team ? ` (${extract.team})` : ""} — ${filter.reason}`,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

export function isAtsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ATS_DOMAIN_HINTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const SOCIAL_OR_ATS_HOSTS = new Set([
  "linkedin.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "github.com",
  "wikipedia.org",
  "crunchbase.com",
  "glassdoor.com",
  "indeed.com",
  "builtin.com",
  "medium.com",
  "substack.com",
  ...ATS_DOMAIN_HINTS,
]);

/**
 * Try to find the company's actual corporate domain when the LLM didn't
 * extract one from the job page. webSearch is ~$0.01/call; we cache by
 * company name within a single finder run so repeated postings from the same
 * employer don't double-charge.
 */
async function resolveCorporateDomain(
  company: string,
  jobUrl: string,
  cache: Map<string, string | null>,
): Promise<{ domain: string | null; costUsd: number }> {
  const key = company.trim().toLowerCase();
  if (cache.has(key)) return { domain: cache.get(key) ?? null, costUsd: 0 };
  let costUsd = 0;
  let domain: string | null = null;
  try {
    const search = await webSearch(
      { query: `"${company}" official site`, maxResults: 5 },
      { playName: PLAY_NAME },
    );
    costUsd += search.result.cost ?? 0;
    for (const hit of search.result.results ?? []) {
      const host = pickCorporateHost(hit.url);
      if (host) {
        domain = host;
        break;
      }
    }
  } catch {
    // fall through to slug guess
  }
  if (!domain) domain = slugFallback(jobUrl);
  cache.set(key, domain);
  return { domain, costUsd };
}

export function pickCorporateHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (SOCIAL_OR_ATS_HOSTS.has(host)) return null;
    if ([...SOCIAL_OR_ATS_HOSTS].some((h) => host.endsWith(`.${h}`))) return null;
    return host;
  } catch {
    return null;
  }
}

export function slugFallback(jobUrl: string): string | null {
  try {
    const u = new URL(jobUrl);
    const seg = u.pathname.split("/").find((s) => s.length > 0);
    if (seg && /^[a-z0-9-]+$/.test(seg)) return `${seg}.com`;
  } catch {
    // ignore
  }
  return null;
}

export function parseHiringSignalExtract(raw: string): HiringSignalExtract {
  return tryParseJsonObject<HiringSignalExtract>(raw, {
    jobTitle: null,
    jobUrl: null,
    company: null,
    companyDomain: null,
    hiringManagerName: null,
    hiringManagerRole: null,
    team: null,
    postedAt: null,
    linkedinUrl: null,
    phone: null,
    summary: null,
  });
}
