import { getLedger, logEvent, webSearch } from "@oneshot-gtm/core";
import { resolveVerifyEnrichQualify, icpFields } from "./_contact.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { persistRoleRejection, qualifyPreSpend } from "./_qualify.ts";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { JobChangeTarget } from "@oneshot-gtm/plays";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import { batchCompaniesByQueryLength, rotateBatches } from "./_query-batch.ts";
import type { FinderResult, JobChangeExtract, RunOpts } from "./_types.ts";

const PLAY_NAME = "job-change";
const SOURCE = "find:job-change";

export interface JobChangeFinderOpts extends RunOpts {
  /** The pitch angle, stamped onto every enqueued row so it drafts inline. */
  yourEdge?: string;
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
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    const companies = opts.companies ?? [];
    const buildQuery = (batch: readonly string[]): string => {
      const companyClause = batch.length > 0 ? ` (${batch.map((c) => `"${c}"`).join(" OR ")})` : "";
      return `"joined as ${persona}"${companyClause} ${sincePhrase}`;
    };
    const batches = rotateBatches(
      batchCompaniesByQueryLength(companies, buildQuery),
      opts.companyBatchCursor ?? 0,
    );
    for (const batch of batches) {
      if (hits.length >= limit * 2) break;
      // Hard cap, checked BEFORE each paid batch search (issue #708
      // correction): checking only after the search-gathering loop finished
      // let a long `companies` list run every remaining batch search once
      // the cap was already reached, and a run that ended with zero hits
      // never reached the per-hit check below at all, so the cap never
      // fired. Checking here, ahead of every webSearch call, stops
      // additional spend the moment the accumulated cost reaches the cap —
      // including on the very next batch/persona, and even when no hit is
      // ever produced.
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
        result.halted = `max-cost cap (${opts.maxCostUsd})`;
        break;
      }
      const query = buildQuery(batch);
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
    // Stage A: judge the extracted role BEFORE paying for findEmail +
    // verify + enrich — a clearly off-ICP newRole must not consume
    // the run's cost budget and crowd out valid candidates behind it.
    const preSpend = await qualifyPreSpend({
      icp,
      person: {
        name: extract.fullName,
        company: extract.newCompany,
        roleText: extract.newRole,
        evidence: `moved to ${extract.newCompany ?? "a new role"}`,
      },
    });
    if (preSpend.action === "reject") {
      result.droppedRole = (result.droppedRole ?? 0) + 1;
      persistRoleRejection({
        playName: PLAY_NAME,
        dedupeKey: hit.url,
        payload: { name: extract.fullName },
        source: SOURCE,
        reason: preSpend.reason,
        dryRun: opts.dryRun,
      });
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
      ...icpFields(contact),
      yourEdge: opts.yourEdge ?? "",
    };
    const id = enqueueScoredTarget(ledger, {
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: hit.url,
      source: SOURCE,
      fitReason: filter.reason,
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
