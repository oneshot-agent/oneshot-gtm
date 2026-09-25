import { getLedger, logEvent, webRead, webSearch } from "@oneshot-gtm/core";
import { resolveVerifyEnrichQualify, icpFields } from "./_contact.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection, qualifyPreSpend } from "./_qualify.ts";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { HiringSignalTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import { batchCompaniesByQueryLength, rotateBatches } from "./_query-batch.ts";
import type { FinderResult, HiringSignalExtract, RunOpts } from "./_types.ts";

const PLAY_NAME = "hiring-signal";
const SOURCE = "find:hiring-signal";

/**
 * Job boards the finder searches (`site:` clauses) and accepts hits from.
 * The four ATS hosts are where funded companies post; Work at a Startup is
 * YC's own board, where a company that has no GTM yet posts its first
 * intern or generalist — the stage a pre-PMF tool is for. A trigger's
 * `sites` picks from these (or adds its own host); default: the four ATS.
 */
export const JOB_BOARD_HOSTS = {
  greenhouse: "boards.greenhouse.io",
  lever: "jobs.lever.co",
  workable: "apply.workable.com",
  ashby: "jobs.ashbyhq.com",
  workatastartup: "workatastartup.com",
} as const;
export const DEFAULT_JOB_SITES: readonly string[] = [
  JOB_BOARD_HOSTS.greenhouse,
  JOB_BOARD_HOSTS.lever,
  JOB_BOARD_HOSTS.workable,
  JOB_BOARD_HOSTS.ashby,
];
const ATS_DOMAIN_HINTS = [...DEFAULT_JOB_SITES, "ashbyhq.com", JOB_BOARD_HOSTS.workatastartup];

export interface HiringSignalFinderOpts extends RunOpts {
  /** Roles to scan for. Default: ["Staff Engineer","ML Engineer","Solutions Engineer"]. */
  roles?: string[];
  /** Optional company-name filter to bias results. */
  companies?: string[];
  /**
   * Rotation cursor for batching a long `companies` list across queries
   * (issue #708): when the list needs more than one batch to stay under the
   * query length bound, batches start at `cursor mod batchCount` instead of
   * always batch 0, so a list spanning several batches isn't scanned from
   * the top on every run. The registry derives this from the trigger's
   * `last_polled_at` epoch ms; direct/CLI callers may omit it (defaults to
   * 0 — first batch always starts the run).
   */
  companyBatchCursor?: number;
  /**
   * The "your one-line claim" that goes onto every queued target — required for the
   * downstream hiring-signal play. If unset, we fall back to a generic placeholder.
   */
  yourClaim?: string;
  /** Days back to bias the search query. Default 14. */
  sinceDays?: number;
  /**
   * Job-board hosts to search and accept, e.g. `["workatastartup.com"]` for
   * YC's board only. Default: the four ATS hosts (`DEFAULT_JOB_SITES`).
   */
  sites?: string[];
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
  const sites = normalizeSites(opts.sites);
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
    const companies = opts.companies ?? [];
    const buildQuery = (batch: readonly string[]): string => {
      const companyClause = batch.length > 0 ? ` (${batch.map((c) => `"${c}"`).join(" OR ")})` : "";
      return `"${role}"${companyClause} ${sincePhrase} (${sites.map((s) => `site:${s}`).join(" OR ")})`;
    };
    const batches = rotateBatches(
      batchCompaniesByQueryLength(companies, buildQuery),
      opts.companyBatchCursor ?? 0,
    );
    for (const batch of batches) {
      if (hits.length >= limit * 2) break;
      const query = buildQuery(batch);
      try {
        const search = await webSearch(
          { query, maxResults: Math.min(15, limit) },
          { playName: PLAY_NAME },
        );
        result.costUsd += search.result.cost ?? 0;
        for (const hit of search.result.results ?? []) {
          if (!hit.url || seen.has(hit.url) || !isJobBoardUrl(hit.url, sites)) continue;
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

    // Email target = the hiring manager when the page names one in full,
    // else whoever the B2B database has at the company domain (a founder,
    // on a seed-stage board) — the spine's own domain-scoped lookup.
    const managerName = hiringManagerFullName(extract.hiringManagerName);
    // Stage A: judge the extracted role BEFORE paying for findEmail +
    // verify + enrich — a clearly off-ICP hiringManagerRole must not consume
    // the run's cost budget and crowd out valid candidates behind it.
    const preSpend = await qualifyPreSpend({
      icp,
      person: {
        name: extract.hiringManagerName,
        company: extract.company,
        roleText: extract.hiringManagerRole,
        evidence: `hiring: ${extract.jobTitle ?? "role"}`,
      },
    });
    if (preSpend.action === "reject") {
      result.droppedRole = (result.droppedRole ?? 0) + 1;
      persistRoleRejection({
        playName: PLAY_NAME,
        dedupeKey: hit.url,
        payload: { name: extract.hiringManagerName },
        source: SOURCE,
        reason: preSpend.reason,
        dryRun: opts.dryRun,
      });
      continue;
    }

    const contact = await resolveVerifyEnrichQualify({
      playName: PLAY_NAME,
      fullName: managerName,
      // No full name on the posting is the norm on a founder-run board, not
      // a reason to skip: let the spine find a named person at the domain.
      allowMissingFullName: managerName === null,
      companyDomain: domain,
      isDuplicate: (email) =>
        isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.url, prospectEmail: email }),
      icp,
      person: {
        name: extract.hiringManagerName,
        company: extract.company,
        roleText: extract.hiringManagerRole,
        evidence: `hiring: ${extract.jobTitle ?? "role"}`,
      },
      // Stage-C target when email enrichment surfaces no LinkedIn: the page
      // extract often carries one, and without it an off-ICP person slides
      // through as `unclear` instead of being judged on a bought title.
      linkedinUrlHint: isLinkedInProfileUrl(extract.linkedinUrl) ? extract.linkedinUrl : null,
      fillGaps: opts.qualifyFillGaps ?? true,
    });
    result.costUsd += contact.costUsd;
    if (!contact.ok) {
      if (contact.reason === "duplicate") result.droppedDuplicate++;
      else if (contact.reason === "role") {
        result.droppedRole = (result.droppedRole ?? 0) + 1;
        persistRoleRejection({
          playName: PLAY_NAME,
          dedupeKey: hit.url,
          payload: { name: extract.hiringManagerName },
          source: SOURCE,
          reason: contact.detail ?? "off-ICP role",
          dryRun: opts.dryRun,
        });
      } else result.droppedEnrichment++;
      continue;
    }
    const email = contact.email;

    const recipientName = extract.hiringManagerName ?? contact.fullName;
    const enr = { phone: contact.phone, linkedinUrl: contact.linkedinUrl };
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
      ...(contact.title ? { title: contact.title } : {}),
      ...icpFields(contact),
    };
    const id = enqueueScoredTarget(ledger, {
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: hit.url,
      source: SOURCE,
      fitReason: filter.reason,
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

/**
 * Lower-cased, de-duplicated hosts with scheme, `www.` and any path stripped;
 * non-strings dropped (the config route stores whatever JSON it is given);
 * empty or absent → the default ATS set. Plain string ops, no regex: the
 * input is founder-typed config, and CodeQL flags a `/\/.*$/` on it.
 */
export function normalizeSites(sites: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of sites ?? []) {
    if (typeof raw !== "string") continue;
    let host = raw.trim().toLowerCase();
    const scheme = host.indexOf("://");
    if (scheme !== -1) host = host.slice(scheme + 3);
    if (host.startsWith("www.")) host = host.slice(4);
    const slash = host.indexOf("/");
    if (slash !== -1) host = host.slice(0, slash);
    if (host) out.add(host);
  }
  return out.size > 0 ? [...out] : [...DEFAULT_JOB_SITES];
}

/**
 * On boards whose search results mix listing, filter and company pages in
 * with the postings, only a posting counts: the first YC-board run spent a
 * dozen ICP calls (and their dedupe keys) on `/internships`, `/jobs?role=`
 * and `/companies/<x>/website`. Hosts not listed here accept any path.
 */
const JOB_PATH_RULES: ReadonlyArray<{ host: string; posting: (path: string) => boolean }> = [
  { host: JOB_BOARD_HOSTS.workatastartup, posting: (p) => /^\/jobs\/\d+\/?$/.test(p) },
];

/** A hit counts only when it is on one of the searched boards (or a subdomain of one) and is a posting. */
export function isJobBoardUrl(url: string, sites: readonly string[]): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!sites.some((h) => host === h || host.endsWith(`.${h}`))) return false;
    const rule = JOB_PATH_RULES.find((r) => host === r.host || host.endsWith(`.${r.host}`));
    return rule ? rule.posting(u.pathname) : true;
  } catch {
    return false;
  }
}

/**
 * The hiring manager's name only when it is a full one. A board like Work at
 * a Startup names founders by first name ("Sacha"), which the email step
 * cannot search on; returning null there lets the contact spine look the
 * person up by company domain instead of skipping the row.
 */
const NAME_TOKEN = /^\p{L}[\p{L}'’.-]*$/u;
export function hiringManagerFullName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  // Every token must read as a name: letters (with the usual hyphen,
  // apostrophe, period) and nothing else — "@sacha" or "sacha_dev" is a
  // handle, and a handle next to a first name is still not a full name.
  const parts = trimmed.split(" ");
  return parts.length >= 2 && parts.every((p) => NAME_TOKEN.test(p)) ? trimmed : null;
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
  "workatastartup.com",
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
