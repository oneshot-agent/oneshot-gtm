import { getLedger, logEvent, webRead, webSearch } from "@oneshot-gtm/core";
import { resolveAndVerifyContact } from "./_contact.ts";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { PostFundingTarget } from "@oneshot-gtm/plays";
import { readFileSync } from "node:fs";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { isDuplicate } from "./_dedupe.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import type { FinderResult, PostFundingExtract, RunOpts } from "./_types.ts";

const PLAY_NAME = "post-funding";
const SOURCE = "find:post-funding";

const ROUND_MAP: Record<string, string> = {
  "Pre-Seed": "Pre-Seed",
  Seed: "Seed",
  "Series A": "Series A",
  "Series B": "Series B",
  "Series C": "Series C",
  "Series D+": "Series D+",
};

export interface PostFundingFinderOpts extends RunOpts {
  /** File with one URL per line (TC / Crunchbase / company-blog). */
  sourceUrlsFile?: string;
  /** Or: pass URLs directly. */
  sourceUrls?: string[];
  /**
   * Auto-discovery mode: if no source URLs are supplied, run a webSearch
   * per round in `autoRounds` for "<industry hint> <round> announcement".
   * Industry hint comes from the saved ICP one-liner (or autoIndustry override).
   */
  auto?: boolean;
  /** Rounds to scan in auto mode. Default: ["Seed", "Series A"]. */
  autoRounds?: string[];
  /** Override the industry hint extracted from the ICP. */
  autoIndustry?: string;
  /** Look back this many days in auto mode (used in the search query). Default 7. */
  autoSinceDays?: number;
}

export async function runPostFundingFinder(opts: PostFundingFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const system = loadPrompt("post-funding-extract");

  // Auto mode: harvest URLs via webSearch instead of reading a file.
  let urls = collectUrls(opts);
  let autoCost = 0;
  if (opts.auto && urls.length === 0) {
    const harvested = await harvestAutoUrls({
      rounds: opts.autoRounds ?? ["Seed", "Series A"],
      industry: opts.autoIndustry ?? deriveIndustryHint(icp),
      sinceDays: opts.autoSinceDays ?? 7,
      limit: limit * 2, // pull a bit extra; ICP filter + extract will winnow
    });
    urls = harvested.urls;
    autoCost = harvested.costUsd;
  }

  const result: FinderResult = {
    source: opts.auto ? `${SOURCE}:auto` : SOURCE,
    candidates: urls.length,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: autoCost,
  };

  for (const url of urls.slice(0, limit)) {
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    // Dedupe by URL before spending anything (cheap).
    if (ledger.isQueueDuplicate(PLAY_NAME, url)) {
      result.droppedDuplicate++;
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    // Read the announcement.
    let extract: PostFundingExtract;
    try {
      const read = await webRead({ url }, { playName: PLAY_NAME });
      result.costUsd += read.result.cost ?? 0;
      const llm = await complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: (read.result.markdown ?? "").slice(0, 12000) },
        ],
        temperature: 0.1,
        maxTokens: 600,
      });
      extract = parsePostFundingExtract(llm.content);
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "post-funding.read_or_extract",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      result.droppedEnrichment++;
      continue;
    }

    if (!extract.company || !extract.companyDomain || !extract.founderName) {
      result.droppedEnrichment++;
      continue;
    }

    // ICP filter on the LLM-extracted summary.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: `${extract.company} ${extract.round ?? "raised"} (${extract.industry ?? "industry n/a"})`,
        url,
        summary: extract.summary,
      },
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
        payload: {
          company: extract.company,
          round: extract.round,
          industry: extract.industry,
          summary: extract.summary,
          sourceUrl: url,
        },
        dedupeKey: url,
        source: SOURCE,
        initialStatus: "rejected",
        notes: `auto: ICP — ${filter.reason}`,
      });
      continue;
    }

    // Resolve + verify the founder's email (prescreen → findEmail → dedupe → verify).
    const contact = await resolveAndVerifyContact({
      playName: PLAY_NAME,
      fullName: extract.founderName,
      companyDomain: extract.companyDomain,
      isDuplicate: (email) => isDuplicate({ playName: PLAY_NAME, dedupeKey: url, prospectEmail: email }),
    });
    result.costUsd += contact.costUsd;
    if (!contact.ok) {
      if (contact.reason === "duplicate") result.droppedDuplicate++;
      else result.droppedEnrichment++;
      continue;
    }
    const email = contact.email;

    const enr = await enrichVerifiedContact(email, {
      playName: PLAY_NAME,
      errKindPrefix: "post-funding",
    });
    result.costUsd += enr.costUsd;
    // Priority mirrors LinkedIn chain: page-specific extract beats generic
    // enrichment lookup when both are set.
    const phone = (extract.phone || null) ?? enr.phone;
    let linkedinUrl: string | null = isLinkedInProfileUrl(extract.linkedinUrl)
      ? extract.linkedinUrl
      : null;
    linkedinUrl = linkedinUrl ?? enr.linkedinUrl;
    if (!linkedinUrl) {
      linkedinUrl = await findLinkedInUrl({
        fullName: extract.founderName,
        disambiguators: [extract.company],
        accumCost: (c) => {
          result.costUsd += c ?? 0;
        },
        errKindPrefix: "post-funding",
      });
    }

    const target: PostFundingTarget = {
      name: extract.founderName,
      email,
      company: extract.company,
      round: ROUND_MAP[extract.round ?? ""] ?? extract.round ?? "Seed",
      amountUsd: extract.amountUsd ?? 0,
      sourceUrl: url,
      ...(extract.leadInvestor ? { leadInvestor: extract.leadInvestor } : {}),
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: url,
      source: SOURCE,
      notes: `${extract.round ?? "?"} ${extract.amountUsd ? `$${extract.amountUsd.toLocaleString()}` : ""} — ${filter.reason}`,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

export function collectUrls(opts: PostFundingFinderOpts): string[] {
  const urls: string[] = [];
  if (opts.sourceUrls) urls.push(...opts.sourceUrls);
  if (opts.sourceUrlsFile) {
    const raw = readFileSync(opts.sourceUrlsFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        const _validate = new URL(trimmed);
        urls.push(_validate.toString());
      } catch {
        // skip non-URL lines
      }
    }
  }
  return [...new Set(urls)];
}

export function parsePostFundingExtract(raw: string): PostFundingExtract {
  return tryParseJsonObject<PostFundingExtract>(raw, {
    company: null,
    companyDomain: null,
    round: null,
    amountUsd: null,
    leadInvestor: null,
    founderName: null,
    founderRole: null,
    industry: null,
    linkedinUrl: null,
    phone: null,
    summary: null,
  });
}

interface HarvestArgs {
  rounds: string[];
  industry: string;
  sinceDays: number;
  limit: number;
}

const FUNDING_DOMAIN_HINTS = [
  "techcrunch.com",
  "crunchbase.com",
  "businesswire.com",
  "prnewswire.com",
  "pitchbook.com",
  "venturebeat.com",
  "axios.com",
  "fortune.com",
  "forbes.com",
  "reuters.com",
  "bloomberg.com",
  "sifted.eu",
  "tech.eu",
  "theinformation.com",
];

async function harvestAutoUrls(args: HarvestArgs): Promise<{ urls: string[]; costUsd: number }> {
  const seen = new Set<string>();
  const urls: string[] = [];
  let costUsd = 0;
  const sincePhrase = args.sinceDays <= 1 ? "today" : `last ${args.sinceDays} days`;
  const industry = args.industry.trim();

  for (const round of args.rounds) {
    if (urls.length >= args.limit) break;
    const queryParts = [
      industry,
      `"${round}"`,
      "funding announcement",
      sincePhrase,
      "site:(techcrunch.com OR crunchbase.com OR businesswire.com OR prnewswire.com OR sifted.eu OR tech.eu)",
    ].filter(Boolean);
    const query = queryParts.join(" ");
    try {
      const search = await webSearch(
        { query, maxResults: Math.min(20, Math.max(5, args.limit - urls.length)) },
        { playName: PLAY_NAME },
      );
      costUsd += search.result.cost ?? 0;
      for (const hit of search.result.results ?? []) {
        if (urls.length >= args.limit) break;
        if (!hit.url) continue;
        const normalized = normalizeUrl(hit.url);
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        if (!isLikelyFundingUrl(normalized, hit.title, hit.description)) continue;
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch {
      // skip this round on error; keep harvesting others
    }
  }
  return { urls, costUsd };
}

export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function isLikelyFundingUrl(url: string, title?: string, description?: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hostMatch = FUNDING_DOMAIN_HINTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (hostMatch) return true;
  const text = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  return /\b(raises?|raised|series\s+[a-d]|seed round|pre-?seed|funding round|led by)\b/.test(text);
}

export function deriveIndustryHint(icp: string | null): string {
  if (!icp) return "startup";
  const cleaned = icp
    .toLowerCase()
    .replace(/[^a-z0-9\s+/-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "for",
    "to",
    "with",
    "in",
    "on",
    "who",
    "that",
    "are",
    "is",
    "be",
    "their",
    "they",
    "we",
    "our",
    "you",
    "your",
    "at",
    "as",
    "by",
    "from",
    "any",
    "need",
    "needs",
    "want",
    "wants",
    "use",
    "uses",
    "using",
    "build",
    "building",
    "ship",
    "shipping",
    "make",
    "making",
    "people",
    "team",
    "teams",
    "company",
    "companies",
    "founder",
    "founders",
    "developer",
    "developers",
    "engineer",
    "engineers",
    "ceo",
    "cto",
    "vp",
    "head",
  ]);
  const keywords = cleaned.filter((w) => w.length > 2 && !stop.has(w)).slice(0, 4);
  return keywords.length > 0 ? keywords.join(" ") : "startup";
}
