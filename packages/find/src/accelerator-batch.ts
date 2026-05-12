import { findEmail, getLedger, logEvent, verifyEmail, webRead } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import type { AcceleratorBatchTarget } from "@oneshot-gtm/plays";
import {
  fetchAcceleratorSearch,
  parseAcceleratorLaunchExtract,
} from "./_accelerator-search-adapter.ts";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { findLinkedInUrl, isLinkedInProfileUrl } from "./_linkedin.ts";
import { parallelMap } from "./_parallel.ts";
import { fetchYcOssBatch } from "./_yc-oss-adapter.ts";
import type { CompanyRecord, FinderResult, RunOpts } from "./_types.ts";

/**
 * Pulls an accelerator-cohort directory, ICP-filters, finds founder contact,
 * enqueues for outreach. Two adapters:
 *
 * - `yc-oss` — free structured directory at yc-oss.github.io (auto-selected
 *   when cohort matches `^yc-`). The right path for any YC batch.
 * - `websearch` — combo-search fallback for accelerators without a public API
 *   (Techstars, Antler, 500 Global, AI Grant, …). Less reliable recall but
 *   works for any cohortLabel.
 *
 * The per-company pipeline is shared: dedupe → ICP filter → findEmail →
 * verifyEmail → enqueue, all under `parallelMap` (concurrency 3, mirrors
 * github-topics).
 */

const PLAY_NAME = "accelerator-batch";

export interface AcceleratorBatchFinderOpts extends RunOpts {
  /** Cohort tag — e.g. `yc-w26`, `yc-s25`, `techstars-toronto-2025`. */
  cohort: string;
  /** Human-readable label fed into search queries + the email prompt. */
  cohortLabel: string;
  /** Force a specific adapter. Default: yc-* → yc-oss, everything else → websearch. */
  adapter?: "yc-oss" | "websearch";
  /** Concurrency for the per-company pipeline. Default 3. */
  concurrency?: number;
}

export async function runAcceleratorBatchFinder(
  opts: AcceleratorBatchFinderOpts,
): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const concurrency = opts.concurrency ?? 3;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const source = `find:accelerator-batch:${opts.cohort}`;

  const result: FinderResult = {
    source,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  // Step 1: discover cohort companies via the adapter.
  const adapterName = pickAdapter(opts.cohort, opts.adapter);
  const adapter =
    adapterName === "yc-oss"
      ? () => fetchYcOssBatch(opts.cohort, limit)
      : () => fetchAcceleratorSearch(opts.cohort, opts.cohortLabel, limit);
  const fetched = await adapter();
  result.costUsd += fetched.costUsd;
  if (fetched.records.length === 0) {
    // Surface the adapter's diagnostic on the run summary so the trigger
    // card explains WHY zero — better than the silent-success the previous
    // implementation produced.
    result.halted = fetched.diagnostic ?? "adapter returned 0 records";
    return result;
  }
  result.candidates = fetched.records.length;

  // Step 2: per-company pipeline (parallel, ICP-first like github-topics).
  // `halted` is a soft cap — workers may overshoot by up to (concurrency - 1)
  // candidates. Acceptable at our scale.
  let halted = false;

  await parallelMap(fetched.records, concurrency, async (record) => {
    if (halted) return;
    if (result.enqueued >= limit) {
      halted = true;
      return;
    }
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      halted = true;
      return;
    }

    const dedupeKey = makeDedupeKey(record, opts.cohort);
    if (ledger.isQueueDuplicate(PLAY_NAME, dedupeKey)) {
      result.droppedDuplicate++;
      return;
    }

    if (opts.dryRun) {
      result.enqueued++;
      return;
    }

    // ICP filter — cheapest gate first ($0.001). Uses the structured
    // one-liner + tags so the classifier sees more signal than a bare title.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: record.name,
        url: record.website ?? record.ycUrl,
        summary: buildIcpSummary(record),
      },
    });
    if (!filter.match) {
      result.droppedIcp++;
      ledger.enqueueTarget({
        playName: PLAY_NAME,
        payload: rejectionPayload(record, opts.cohort),
        dedupeKey,
        source,
        initialStatus: "rejected",
        notes: `auto: ICP — ${filter.reason}`,
      });
      return;
    }

    // Resolve a founder name for this record. yc-oss directory rows ship
    // without one; the SDK's findEmail requires `full_name` (or first+last)
    // so we MUST acquire a person name before the enrichment call.
    //
    // Strategy: webRead the YC profile page (or fall back to the company
    // website) and run the same `accelerator-launch-extract` prompt the
    // websearch adapter uses. ~$0.02 per ICP-pass — only paid for candidates
    // that survived the cheaper ICP gate.
    let founderName = record.founderName?.trim() || null;
    let resolvedLinkedin: string | null = isLinkedInProfileUrl(record.founderLinkedinUrl)
      ? record.founderLinkedinUrl
      : null;
    let resolvedPhone: string | null = record.founderPhone ?? null;
    if (!founderName) {
      const resolved = await resolveFounderName(record);
      result.costUsd += resolved.costUsd;
      founderName = resolved.founderName;
      resolvedLinkedin = resolvedLinkedin ?? resolved.linkedinUrl;
      resolvedPhone = resolvedPhone ?? resolved.phone;
    }
    if (!founderName) {
      result.droppedEnrichment++;
      return;
    }

    const domain = record.website ? urlDomain(record.website) : null;
    if (!domain) {
      result.droppedEnrichment++;
      return;
    }
    const skip = shouldSkipFindEmail({ fullName: founderName, companyDomain: domain });
    if (!skip.ok) {
      result.droppedEnrichment++;
      logEvent("finder.skipped_findemail", { name: PLAY_NAME, reason: skip.reason }, "info");
      return;
    }
    const found = await findEmail(
      { fullName: founderName, companyDomain: domain },
      { playName: PLAY_NAME },
    );
    result.costUsd += found.result.cost ?? 0;
    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      return;
    }
    const email = found.result.email;
    // Prefer the SDK's resolved name when available — it's the actual owner of
    // the email — and fall back to the founder name we resolved upstream.
    const fullName = found.result.full_name?.trim() || founderName;

    if (isDuplicate({ playName: PLAY_NAME, dedupeKey, prospectEmail: email })) {
      result.droppedDuplicate++;
      return;
    }

    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += verified.result.cost ?? 0;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      return;
    }

    const enr = await enrichVerifiedContact(email, {
      playName: PLAY_NAME,
      errKindPrefix: "accelerator-batch",
    });
    result.costUsd += enr.costUsd;
    const phone = resolvedPhone ?? enr.phone;
    let linkedinUrl = resolvedLinkedin ?? enr.linkedinUrl;
    if (!linkedinUrl) {
      linkedinUrl = await findLinkedInUrl({
        fullName,
        disambiguators: [record.name],
        accumCost: (c) => {
          result.costUsd += c ?? 0;
        },
        errKindPrefix: "accelerator-batch",
      });
    }

    const target: AcceleratorBatchTarget = {
      name: fullName,
      email,
      company: record.name,
      cohort: opts.cohort,
      ...(record.ycUrl
        ? { launchUrl: record.ycUrl }
        : record.website
          ? { launchUrl: record.website }
          : {}),
      ...(record.oneLiner ? { productOneLiner: record.oneLiner } : {}),
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey,
      source,
      notes: filter.reason,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  });

  return result;
}

/**
 * Pick which adapter handles the cohort. yc-* tags hit the free yc-oss
 * directory; everything else falls back to web search. An explicit override
 * always wins so founders can force a path for testing.
 */
export function pickAdapter(cohort: string, override?: string): "yc-oss" | "websearch" {
  if (override === "yc-oss" || override === "websearch") return override;
  if (/^yc-/i.test(cohort.trim())) return "yc-oss";
  return "websearch";
}

function makeDedupeKey(record: CompanyRecord, cohort: string): string {
  const slug = record.name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return `${slug}|${cohort}`;
}

function rejectionPayload(record: CompanyRecord, cohort: string): Record<string, unknown> {
  return {
    company: record.name,
    cohort,
    ...(record.ycUrl
      ? { launchUrl: record.ycUrl }
      : record.website
        ? { launchUrl: record.website }
        : {}),
    ...(record.oneLiner ? { oneLiner: record.oneLiner } : {}),
  };
}

function buildIcpSummary(record: CompanyRecord): string {
  const parts: string[] = [];
  if (record.oneLiner) parts.push(record.oneLiner);
  if (record.longDescription) parts.push(record.longDescription.slice(0, 600));
  if (record.industry) parts.push(`Industry: ${record.industry}`);
  if (record.tags.length > 0) parts.push(`Tags: ${record.tags.join(", ")}`);
  return parts.join("\n\n");
}

/**
 * webRead a per-company URL (YC profile preferred, company website as
 * fallback) and run the `accelerator-launch-extract` prompt to grab a
 * founder name. Returns `{founderName: null}` if no URL is available, the
 * read fails, or the LLM can't surface a name.
 *
 * Only called for ICP-passing candidates so we don't pay this cost on
 * candidates the cheap classifier already rejected.
 */
export async function resolveFounderName(record: CompanyRecord): Promise<{
  founderName: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  costUsd: number;
}> {
  const url = record.ycUrl ?? record.website;
  if (!url) return { founderName: null, linkedinUrl: null, phone: null, costUsd: 0 };
  let costUsd = 0;
  try {
    const read = await webRead({ url }, { playName: PLAY_NAME });
    costUsd += read.result.cost ?? 0;
    const system = loadPrompt("accelerator-launch-extract");
    const llm = await complete({
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            url,
            company: record.name,
            markdown: (read.result.markdown ?? "").slice(0, 12000),
          }),
        },
      ],
      temperature: 0.1,
      maxTokens: 400,
    });
    const extract = parseAcceleratorLaunchExtract(llm.content);
    const name = extract.founderName?.trim();
    const linkedinUrl = extract.linkedinUrl?.trim() || null;
    return {
      founderName: name && name.length > 0 ? name : null,
      linkedinUrl: isLinkedInProfileUrl(linkedinUrl) ? linkedinUrl : null,
      phone: extract.phone?.trim() || null,
      costUsd,
    };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "accelerator-batch.resolveFounderName",
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return { founderName: null, linkedinUrl: null, phone: null, costUsd };
  }
}
