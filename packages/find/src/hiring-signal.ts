import { findEmail, getLedger, verifyEmail, webRead, webSearch } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import type { HiringSignalTarget } from "@oneshot-gtm/plays";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
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
const DEFAULT_CLAIM =
  "we cut new-hire ramp time by ~30% on the team they're hiring for — happy to share how";

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
  const yourClaim = opts.yourClaim ?? DEFAULT_CLAIM;

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const sincePhrase = sinceDays <= 7 ? "this week" : `last ${sinceDays} days`;

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
      result.costUsd += extractCost(search.result) ?? 0.01;
      for (const hit of search.result.results ?? []) {
        if (!hit.url || seen.has(hit.url) || !isAtsUrl(hit.url)) continue;
        seen.add(hit.url);
        hits.push({ url: hit.url, title: hit.title, description: hit.description });
      }
    } catch {
      // skip role on failure
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
    if (!filter.match) {
      result.droppedIcp++;
      continue;
    }

    let extract: HiringSignalExtract;
    try {
      const read = await webRead({ url: hit.url }, { playName: PLAY_NAME });
      result.costUsd += extractCost(read.result) ?? 0.02;
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
      extract = parseExtract(llm.content);
    } catch {
      result.droppedEnrichment++;
      continue;
    }

    if (!extract.jobTitle || !extract.company) {
      result.droppedEnrichment++;
      continue;
    }

    const domain = extract.companyDomain ?? guessCorporateDomain(hit.url, extract.company);
    if (!domain) {
      result.droppedEnrichment++;
      continue;
    }

    // Email target = the hiring manager when extracted, else fall back to a
    // best-effort search on the company domain (no name).
    const findInput =
      extract.hiringManagerName && extract.hiringManagerName.length > 0
        ? { fullName: extract.hiringManagerName, companyDomain: domain }
        : { companyDomain: domain };
    const found = await findEmail(findInput, { playName: PLAY_NAME });
    result.costUsd += extractCost(found.result) ?? 0.05;
    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      continue;
    }
    const email = found.result.email;

    if (isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.url, prospectEmail: email })) {
      result.droppedDuplicate++;
      continue;
    }

    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += extractCost(verified.result) ?? 0.01;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      continue;
    }

    const target: HiringSignalTarget = {
      name: extract.hiringManagerName ?? found.result.full_name ?? "team",
      email,
      company: extract.company,
      jobTitle: extract.jobTitle,
      jobPostUrl: extract.jobUrl ?? hit.url,
      yourClaim,
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

function isAtsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ATS_DOMAIN_HINTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function guessCorporateDomain(jobUrl: string, _company: string): string | null {
  // ATS URLs encode the slug in the path: jobs.lever.co/<slug>/...,
  // boards.greenhouse.io/<slug>/jobs/..., apply.workable.com/<slug>/...,
  // jobs.ashbyhq.com/<slug>/...
  // We don't know the corporate TLD, so we fall through to urlDomain — the
  // findEmail call will just use the ATS subdomain, which usually fails. The
  // safest move is to surface this as enrichment-failed when we can't infer a
  // real corporate domain from the slug.
  try {
    const u = new URL(jobUrl);
    const seg = u.pathname.split("/").find((s) => s.length > 0);
    if (seg && /^[a-z0-9-]+$/.test(seg)) return `${seg}.com`;
  } catch {
    // fall through
  }
  return urlDomain(jobUrl);
}

function parseExtract(raw: string): HiringSignalExtract {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse((candidate ?? "").trim()) as HiringSignalExtract;
  } catch {
    const start = (candidate ?? "").indexOf("{");
    const end = (candidate ?? "").lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse((candidate ?? "").slice(start, end + 1)) as HiringSignalExtract;
      } catch {
        // fall through
      }
    }
  }
  return {
    jobTitle: null,
    jobUrl: null,
    company: null,
    companyDomain: null,
    hiringManagerName: null,
    hiringManagerRole: null,
    team: null,
    postedAt: null,
    summary: null,
  };
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
