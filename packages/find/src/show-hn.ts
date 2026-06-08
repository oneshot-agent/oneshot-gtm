import { getLedger, logEvent, type FindEmailInput, webRead } from "@oneshot-gtm/core";
import { safeFindEmail, safeVerifyEmail } from "./_sdk-safe.ts";
import type { ShowHnTarget } from "@oneshot-gtm/plays";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { findLinkedInUrl } from "./_linkedin.ts";
import { parallelMap } from "./_parallel.ts";
import type { FinderResult, RunOpts, ShowHnHit } from "./_types.ts";

const HN_ALGOLIA = "https://hn.algolia.com/api/v1/search_by_date";
const PLAY_NAME = "show-hn";
const SOURCE = "find:show-hn";

export interface ShowHnFinderOpts extends RunOpts {
  /** Look back this many days. Default 1. */
  sinceDays?: number;
  /** Skip posts with fewer points than this. Default 5. */
  minPoints?: number;
  /** Max per-candidate pipelines in flight at once. Default 3. */
  concurrency?: number;
}

interface SearchHitsResponse {
  hits: ShowHnHit[];
}

/**
 * Pulls Show HN posts from HN Algolia, ICP-filters them, enriches founder
 * contact via OneShot, dedupes against the ledger, and enqueues into target_queue.
 */
export async function runShowHnFinder(opts: ShowHnFinderOpts): Promise<FinderResult> {
  const sinceDays = opts.sinceDays ?? 1;
  const minPoints = opts.minPoints ?? 5;
  const limit = opts.limit ?? 25;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    droppedLowSignal: 0,
    enqueued: 0,
    costUsd: 0,
  };

  logEvent("finder.start", { name: PLAY_NAME, since_days: sinceDays, limit });
  const sinceUnix = Math.floor((Date.now() - sinceDays * 24 * 3600 * 1000) / 1000);
  const url = `${HN_ALGOLIA}?tags=show_hn&numericFilters=created_at_i>${sinceUnix}&hitsPerPage=${Math.min(50, limit * 2)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HN Algolia fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as SearchHitsResponse;
  result.candidates = data.hits.length;
  logEvent("finder.fetched", { name: PLAY_NAME, candidates: result.candidates });

  // Per-candidate pipeline runs at `concurrency` (mirrors accelerator-batch /
  // github-topics) — the serial version spent ~70s on 50 candidates waiting on
  // findEmail/verify/enrich one at a time. `halted` is a soft cap: workers in
  // flight when the limit/cost-cap trips may overshoot by up to
  // (concurrency - 1) candidates. The `result.*` accumulators are mutated in
  // place; safe because JS interleaves (never truly parallel) between awaits.
  const concurrency = opts.concurrency ?? 3;
  let halted = false;

  await parallelMap(data.hits, concurrency, async (hit) => {
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
    if (hit.points < minPoints) {
      result.droppedLowSignal = (result.droppedLowSignal ?? 0) + 1;
      return;
    }

    // Dedupe BEFORE any LLM/OneShot spend.
    if (ledger.isQueueDuplicate(PLAY_NAME, hit.objectID)) {
      result.droppedDuplicate++;
      return;
    }

    // ICP filter.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: hit.title,
        url: hit.url,
        summary: hit.story_text?.slice(0, 800) ?? null,
        author: hit.author,
      },
    });
    // Rough cost: ~$0.001 per filter call (LLM tokens; not OneShot $).
    if (!filter.match) {
      result.droppedIcp++;
      // Persist the auto-rejection so the founder can review what got
      // dropped, override (set to approved) if it was a false negative,
      // and so the future learning loop has labeled examples.
      if (!opts.dryRun) {
        ledger.enqueueTarget({
          playName: PLAY_NAME,
          payload: { postTitle: hit.title, postUrl: hit.url, founderName: hit.author },
          dedupeKey: hit.objectID,
          source: SOURCE,
          initialStatus: "rejected",
          notes: `auto: ICP — ${filter.reason}`,
        });
      }
      return;
    }

    if (opts.dryRun) {
      // Just count — don't enrich or enqueue.
      result.enqueued++;
      return;
    }

    // Enrich: try to find the founder's email via the landing-page domain + author handle.
    const domain = urlDomain(hit.url);
    if (!domain) {
      result.droppedEnrichment++;
      return;
    }

    // Read the landing page so we have content for the hookSummary fallback +
    // a crude "founder name" guess (use the HN handle as fullName if present).
    const fullName = hit.author && hit.author.length > 0 ? hit.author : undefined;
    const skip = shouldSkipFindEmail({ fullName, companyDomain: domain });
    if (!skip.ok) {
      result.droppedEnrichment++;
      logEvent("finder.skipped_findemail", { name: PLAY_NAME, reason: skip.reason }, "info");
      return;
    }
    const findInput: FindEmailInput = { companyDomain: domain };
    if (fullName) findInput.fullName = fullName;
    const found = await safeFindEmail(findInput, { playName: PLAY_NAME });
    result.costUsd += found.result.cost ?? 0;

    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      return;
    }
    const email = found.result.email;

    // Verify deliverability.
    const verified = await safeVerifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += verified.result.cost ?? 0;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      return;
    }

    // Cross-table dedupe: same email already a known prospect?
    if (isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.objectID, prospectEmail: email })) {
      result.droppedDuplicate++;
      return;
    }

    // Optional: read the landing page for a richer hookSummary.
    let hookSummary = (hit.story_text ?? "").trim().slice(0, 280);
    if (hookSummary.length < 40 && hit.url) {
      try {
        const read = await webRead({ url: hit.url }, { playName: PLAY_NAME });
        result.costUsd += read.result.cost ?? 0;
        hookSummary = (read.result.markdown ?? "").trim().slice(0, 280);
      } catch (err) {
        // best-effort; fall through to whatever we have
        logEvent(
          "error.swallowed",
          {
            kind: "show-hn.hookSummary.webRead",
            message_120: ((err as Error).message ?? "").slice(0, 120),
          },
          "warn",
        );
      }
    }
    if (!hookSummary || hookSummary.length < 20) {
      hookSummary = `Show HN post: ${hit.title}. ${hit.points} points.`;
    }

    const founderName = found.result.full_name ?? hit.author;
    // Always enrich after verify to capture phone + linkedin from the SDK.
    const enr = await enrichVerifiedContact(email, {
      playName: PLAY_NAME,
      errKindPrefix: "show-hn",
    });
    result.costUsd += enr.costUsd;
    const phone = enr.phone;
    let linkedinUrl: string | null = enr.linkedinUrl;
    if (!linkedinUrl) {
      // Last-resort webSearch fallback when enrichProfile didn't surface one.
      linkedinUrl = await findLinkedInUrl({
        fullName: founderName,
        disambiguators: ["hacker news", domain],
        accumCost: (c) => {
          result.costUsd += c ?? 0;
        },
        errKindPrefix: "show-hn",
      });
    }

    const target: ShowHnTarget = {
      postTitle: hit.title,
      postUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      founderName,
      founderEmail: email,
      hookSummary,
      ...(linkedinUrl ? { linkedinUrl } : {}),
      ...(phone ? { phone } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: hit.objectID,
      source: SOURCE,
      notes: filter.reason,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  });

  logEvent("finder.done", {
    name: PLAY_NAME,
    candidates: result.candidates,
    enqueued: result.enqueued,
    dropped_icp: result.droppedIcp,
    dropped_dup: result.droppedDuplicate,
    dropped_enrich: result.droppedEnrichment,
    dropped_low_signal: result.droppedLowSignal ?? 0,
    cost_usd: result.costUsd,
    halted: result.halted ?? null,
  });
  return result;
}
