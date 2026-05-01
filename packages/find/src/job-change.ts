import { findEmail, getLedger, logEvent, verifyEmail, webSearch } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { JobChangeTarget } from "@oneshot-gtm/plays";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import type { FinderResult, JobChangeExtract, RunOpts } from "./_types.ts";

const PLAY_NAME = "job-change";
const SOURCE = "find:job-change";

export interface JobChangeFinderOpts extends RunOpts {
  /**
   * Target personas to search for (e.g. "VP Engineering", "Head of Growth").
   * Each persona gets one webSearch query combined with sinceDays.
   */
  personas?: string[];
  /**
   * Optional list of company-name filters to bias results toward (e.g. ICP companies).
   * If empty, casts a wider net per persona.
   */
  companies?: string[];
  /** Days back to bias the search query. Default 14. */
  sinceDays?: number;
}

const DEFAULT_PERSONAS = [
  "VP Engineering",
  "Head of Growth",
  "Director of Product",
  "Chief of Staff",
];

interface SearchHit {
  url: string;
  title: string;
  description: string;
}

export async function runJobChangeFinder(opts: JobChangeFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const sinceDays = opts.sinceDays ?? 14;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const system = loadPrompt("job-change-extract");
  const personas = opts.personas && opts.personas.length > 0 ? opts.personas : DEFAULT_PERSONAS;

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  const seenUrls = new Set<string>();
  const hits: SearchHit[] = [];
  const sincePhrase = sinceDays <= 7 ? "last week" : `last ${sinceDays} days`;

  for (const persona of personas) {
    if (hits.length >= limit * 2) break;
    const companyClause =
      opts.companies && opts.companies.length > 0
        ? ` (${opts.companies.map((c) => `"${c}"`).join(" OR ")})`
        : "";
    const query = `"joined as ${persona}"${companyClause} ${sincePhrase}`;
    try {
      const search = await webSearch(
        { query, maxResults: Math.min(15, limit) },
        { playName: PLAY_NAME },
      );
      result.costUsd += extractCost(search.result) ?? 0.01;
      for (const hit of search.result.results ?? []) {
        if (!hit.url || seenUrls.has(hit.url)) continue;
        seenUrls.add(hit.url);
        hits.push({ url: hit.url, title: hit.title, description: hit.description });
      }
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "job-change.webSearch",
          persona,
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

    let extract: JobChangeExtract;
    try {
      const llm = await complete({
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              url: hit.url,
              title: hit.title,
              description: hit.description,
            }),
          },
        ],
        temperature: 0.1,
        maxTokens: 500,
      });
      extract = parseJobChangeExtract(llm.content);
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "job-change.llm.extract",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      result.droppedEnrichment++;
      continue;
    }

    if (!extract.fullName || !extract.newRole || !extract.newCompany) {
      result.droppedEnrichment++;
      continue;
    }

    const domain = extract.newCompanyDomain ?? urlDomain(hit.url);
    if (!domain) {
      result.droppedEnrichment++;
      continue;
    }

    const found = await findEmail(
      { fullName: extract.fullName, companyDomain: domain },
      { playName: PLAY_NAME },
    );
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

    let linkedinUrl: string | null = isLinkedInProfileUrl(extract.linkedinUrl)
      ? extract.linkedinUrl
      : null;
    if (!linkedinUrl) {
      linkedinUrl = await findLinkedInUrl({
        fullName: extract.fullName,
        disambiguators: [extract.newCompany],
        accumCost: (c) => {
          result.costUsd += c ?? 0;
        },
        errKindPrefix: "job-change",
      });
    }

    const target: JobChangeTarget = {
      name: extract.fullName,
      email,
      newRole: extract.newRole,
      newCompany: extract.newCompany,
      ...(extract.previousRole ? { previousRole: extract.previousRole } : {}),
      ...(extract.previousCompany ? { previousCompany: extract.previousCompany } : {}),
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(extract.phone ? { phone: extract.phone } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: hit.url,
      source: SOURCE,
      notes: `${extract.fullName} → ${extract.newRole} @ ${extract.newCompany} — ${filter.reason}`,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

export function parseJobChangeExtract(raw: string): JobChangeExtract {
  return tryParseJsonObject<JobChangeExtract>(raw, {
    fullName: null,
    newRole: null,
    newCompany: null,
    newCompanyDomain: null,
    previousRole: null,
    previousCompany: null,
    linkedinUrl: null,
    phone: null,
    summary: null,
  });
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
