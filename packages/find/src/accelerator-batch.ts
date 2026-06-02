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
import { deriveCohortLabel, fetchYcOssBatch } from "./_yc-oss-adapter.ts";
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

export interface CohortEntry {
  /** Cohort tag — e.g. `yc-w26`, `techstars-spring-2026`, `spc-2026-1`. */
  cohort: string;
  /** Human-readable label fed into search queries + the email prompt. */
  cohortLabel: string;
}

export interface AcceleratorBatchFinderOpts extends RunOpts {
  /**
   * Multi-cohort sweep. Each entry routes to its own adapter — yc-* → yc-oss,
   * everything else → websearch. Per-cohort failures are isolated; the run
   * only halts if EVERY cohort returns 0 records.
   */
  cohorts?: CohortEntry[];
  /** Legacy single-cohort tag. Ignored when `cohorts` is set. */
  cohort?: string;
  /** Legacy human label. Ignored when `cohorts` is set. */
  cohortLabel?: string;
  /** Force a specific adapter for ALL entries. Default: yc-* → yc-oss, else → websearch. */
  adapter?: "yc-oss" | "websearch";
  /** Concurrency for the per-company pipeline (over the unified pool). Default 3. */
  concurrency?: number;
  /** The sender's own cohort tag — stamped onto every enqueued row so the play
   *  can draft inline (self-contained), like github-topics stamps `yourEdge`. */
  senderCohort?: string;
  /** Optional time-bound offer for the sender's cohort, stamped onto each row. */
  freeForCohortOffer?: string;
}

/**
 * Normalize the legacy single-cohort opts shape into the new multi-cohort
 * list. Old trigger rows with `{cohort, cohortLabel}` keep working — they
 * become a one-entry list. Each entry's `cohort` is trimmed and an empty
 * `cohortLabel` is filled via `deriveCohortLabel`. Malformed entries
 * (missing or empty cohort tag) are dropped silently. Throws when zero
 * usable entries remain — readiness gate is supposed to prevent this.
 */
export function normalizeCohorts(
  opts: Pick<AcceleratorBatchFinderOpts, "cohorts" | "cohort" | "cohortLabel">,
): CohortEntry[] {
  if (opts.cohorts && opts.cohorts.length > 0) {
    const normalized = opts.cohorts
      .map((entry): CohortEntry | null => {
        if (!entry || typeof entry.cohort !== "string") return null;
        const cohort = entry.cohort.trim();
        if (cohort.length === 0) return null;
        const labelRaw = typeof entry.cohortLabel === "string" ? entry.cohortLabel.trim() : "";
        return { cohort, cohortLabel: labelRaw.length > 0 ? labelRaw : deriveCohortLabel(cohort) };
      })
      .filter((e): e is CohortEntry => e !== null);
    if (normalized.length > 0) return normalized;
    // All entries malformed — fall through to the legacy fields below before
    // throwing, in case the operator set both fields.
  }
  if (typeof opts.cohort === "string" && opts.cohort.trim().length > 0) {
    const cohort = opts.cohort.trim();
    const cohortLabel =
      typeof opts.cohortLabel === "string" && opts.cohortLabel.trim().length > 0
        ? opts.cohortLabel.trim()
        : deriveCohortLabel(cohort);
    return [{ cohort, cohortLabel }];
  }
  throw new Error("accelerator-batch: at least one cohort required");
}

/**
 * Round-robin interleave records by their source cohort. Without this, the
 * per-company `parallelMap` would chew through every yc-w26 candidate before
 * touching Techstars — so the global `limit` enqueue cap (25 by default)
 * would be hit before any non-YC cohort got a chance. Interleaving picks
 * one record per cohort in turn until all cohort lists are exhausted, so
 * the eventual queue has a balanced cross-incubator footprint.
 *
 * Stable: ordering within a cohort matches input order. Empty input → [].
 */
export function interleaveByCohort<T extends { cohort: string }>(records: T[]): T[] {
  if (records.length === 0) return [];
  const byCohort = new Map<string, T[]>();
  // Preserve cohort first-seen order so the output is deterministic.
  const order: string[] = [];
  for (const r of records) {
    let list = byCohort.get(r.cohort);
    if (!list) {
      list = [];
      byCohort.set(r.cohort, list);
      order.push(r.cohort);
    }
    list.push(r);
  }
  const out: T[] = [];
  let idx = 0;
  while (out.length < records.length) {
    let pushed = false;
    for (const cohort of order) {
      const list = byCohort.get(cohort);
      if (list && idx < list.length) {
        out.push(list[idx]!);
        pushed = true;
      }
    }
    if (!pushed) break;
    idx++;
  }
  return out;
}

/** Source-tagged company record. Each entry carries the cohort it was fetched under. */
export type TaggedCompanyRecord = CompanyRecord & { cohort: string; cohortLabel: string };

/**
 * Cross-cohort dedupe by company name slug. A company appearing in two
 * cohorts (e.g. a YC alum joining Techstars) is rare but possible — keep the
 * first occurrence so the per-company pipeline doesn't pay enrichment cost
 * twice. Slug = lowercase + whitespace→hyphens + non-alphanumerics stripped,
 * matching the dedupeKey shape downstream.
 */
export function dedupeRecordsBySlug<T extends CompanyRecord>(records: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of records) {
    const slug = r.name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(r);
  }
  return out;
}

export async function runAcceleratorBatchFinder(
  opts: AcceleratorBatchFinderOpts,
): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const concurrency = opts.concurrency ?? 3;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const cohorts = normalizeCohorts(opts);
  // Source string reflects whether this is a sweep or a single-cohort run.
  // Keeps the per-target `source` column on the queue readable.
  const source =
    cohorts.length === 1
      ? `find:accelerator-batch:${cohorts[0]!.cohort}`
      : `find:accelerator-batch:sweep`;

  const result: FinderResult = {
    source,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  // Step 1: discover cohort companies — one adapter call per cohort entry.
  // Per-cohort failures (adapter throws, 0 hits) log and continue; we only
  // halt the run when EVERY cohort came back empty.
  //
  // Parallelized at `concurrency` to keep wall-clock reasonable: with 12
  // websearch cohorts at ~30s each, a sequential loop would burn 6+ minutes
  // of pure discovery before the first per-company pipeline starts. The
  // cost-cap check is best-effort under parallelism — workers in flight
  // can overshoot by ~(concurrency - 1) × (per-cohort cost) — acceptable
  // since the per-company loop also overshoots by the same factor.
  type CohortOutcome = {
    records: TaggedCompanyRecord[];
    summary: { cohort: string; records: number; error?: string };
  };
  const cohortResults = await parallelMap<CohortEntry, CohortOutcome>(
    cohorts,
    concurrency,
    async (entry) => {
      // Best-effort cost-cap check before we start the fetch. Workers in
      // flight at cap-trip time still finish their adapter call.
      if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
        return {
          records: [],
          summary: { cohort: entry.cohort, records: 0, error: "skipped: cost cap" },
        };
      }
      const adapterName = pickAdapter(entry.cohort, opts.adapter);
      try {
        const fetched =
          adapterName === "yc-oss"
            ? await fetchYcOssBatch(entry.cohort, limit)
            : await fetchAcceleratorSearch(entry.cohort, entry.cohortLabel, limit);
        result.costUsd += fetched.costUsd;
        if (fetched.records.length === 0) {
          return {
            records: [],
            summary: {
              cohort: entry.cohort,
              records: 0,
              error: fetched.diagnostic ?? "no records",
            },
          };
        }
        // Tag each record with its source cohort so the per-company callback
        // can build dedupe keys, rejection payloads, and final targets without
        // needing the cohort plumbed through opts.
        const tagged = fetched.records.map<TaggedCompanyRecord>((r) => ({
          ...r,
          cohort: entry.cohort,
          cohortLabel: entry.cohortLabel,
        }));
        return {
          records: tagged,
          summary: { cohort: entry.cohort, records: fetched.records.length },
        };
      } catch (err) {
        const message = ((err as Error).message ?? "").slice(0, 120);
        logEvent(
          "error.swallowed",
          { kind: "accelerator-batch.adapter", cohort: entry.cohort, message_120: message },
          "warn",
        );
        return {
          records: [],
          summary: { cohort: entry.cohort, records: 0, error: message },
        };
      }
    },
  );

  // Reassemble in registry order so the per-cohort summary lines up with
  // the operator's config visually.
  const allRecords: TaggedCompanyRecord[] = [];
  const perCohortOutcomes: Array<{ cohort: string; records: number; error?: string }> = [];
  for (const r of cohortResults) {
    allRecords.push(...r.records);
    perCohortOutcomes.push(r.summary);
  }
  result.perCohort = perCohortOutcomes;

  // Interleave + cross-cohort dedupe. Interleave first so the per-company
  // pipeline sees a balanced rotation; dedupe by slug after so a company
  // appearing in two cohorts gets enriched once (kept under its first
  // surfacing cohort).
  const deduped = dedupeRecordsBySlug(interleaveByCohort(allRecords));
  result.candidates = deduped.length;
  if (deduped.length === 0) {
    // Every cohort came back empty. Surface the right diagnostic:
    // - Single-cohort run → the adapter's own message
    // - All cohorts skipped due to cost cap → that
    // - Otherwise → generic sweep-empty
    if (cohorts.length === 1) {
      const first = perCohortOutcomes[0];
      result.halted = first?.error ?? "adapter returned 0 records";
    } else if (
      opts.maxCostUsd != null &&
      perCohortOutcomes.every((o) => o.error === "skipped: cost cap")
    ) {
      result.halted = `max-cost cap (${opts.maxCostUsd}) during discovery`;
    } else {
      result.halted = `all ${cohorts.length} cohorts returned 0 candidates`;
    }
    return result;
  }

  // Step 2: per-company pipeline (parallel, ICP-first like github-topics).
  // `halted` is a soft cap — workers may overshoot by up to (concurrency - 1)
  // candidates. Acceptable at our scale.
  let halted = false;

  await parallelMap(deduped, concurrency, async (record) => {
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

    const dedupeKey = makeDedupeKey(record, record.cohort);
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
        payload: rejectionPayload(record, record.cohort),
        dedupeKey,
        source,
        initialStatus: "rejected",
        notes: `auto: ICP — ${record.cohortLabel} — ${filter.reason}`,
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
      cohort: record.cohort,
      ...(record.ycUrl
        ? { launchUrl: record.ycUrl }
        : record.website
          ? { launchUrl: record.website }
          : {}),
      ...(record.oneLiner ? { productOneLiner: record.oneLiner } : {}),
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
      // Stamp the sender's own cohort (+ offer) onto the row so the play can
      // draft inline without a run-level senderCohort — mirrors yourEdge.
      ...(opts.senderCohort ? { senderCohort: opts.senderCohort } : {}),
      ...(opts.freeForCohortOffer ? { freeForCohortOffer: opts.freeForCohortOffer } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey,
      source,
      notes: `${record.cohortLabel} — ${filter.reason}`,
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
