import { getLedger, logEvent, webSearch } from "@oneshot-gtm/core";
import { resolveVerifyEnrichQualify } from "./_contact.ts";
import { persistRoleRejection } from "./_qualify.ts";
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
      result.costUsd += search.result.cost ?? 0;
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
    const contact = await resolveVerifyEnrichQualify({
      playName: PLAY_NAME,
      fullName: extract.fullName,
      companyDomain: domain,
      isDuplicate: (email) =>
        isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.url, prospectEmail: email }),
      icp,
      person: {
        name: extract.fullName,
        company: extract.newCompany,
        roleText: extract.newRole,
        evidence: `moved to ${extract.newCompany ?? "a new role"}`,
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
          payload: { name: extract.fullName },
          source: SOURCE,
          reason: contact.detail ?? "off-ICP role",
          dryRun: opts.dryRun,
        });
      } else result.droppedEnrichment++;
      continue;
    }
    const email = contact.email;

    const enr = { phone: contact.phone, linkedinUrl: contact.linkedinUrl };
    // Priority mirrors LinkedIn chain: page-specific extract beats generic
    // enrichment lookup when both are set.
    const phone = (extract.phone || null) ?? enr.phone;
    let linkedinUrl: string | null = isLinkedInProfileUrl(extract.linkedinUrl)
      ? extract.linkedinUrl
      : null;
    linkedinUrl = linkedinUrl ?? enr.linkedinUrl;
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
      ...(phone ? { phone } : {}),
      ...(contact.title ? { title: contact.title } : {}),
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
