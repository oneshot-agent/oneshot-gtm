import { getLedger, type FindEmailInput } from "@oneshot-gtm/core";
import { findEmail, verifyEmail, webRead } from "@oneshot-gtm/core";
import type { ShowHnTarget } from "@oneshot-gtm/plays";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import type { FinderResult, RunOpts, ShowHnHit } from "./_types.ts";

const HN_ALGOLIA = "https://hn.algolia.com/api/v1/search_by_date";
const PLAY_NAME = "show-hn";
const SOURCE = "find:show-hn";

export interface ShowHnFinderOpts extends RunOpts {
  /** Look back this many days. Default 1. */
  sinceDays?: number;
  /** Skip posts with fewer points than this. Default 5. */
  minPoints?: number;
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
    enqueued: 0,
    costUsd: 0,
  };

  const sinceUnix = Math.floor((Date.now() - sinceDays * 24 * 3600 * 1000) / 1000);
  const url = `${HN_ALGOLIA}?tags=show_hn&numericFilters=created_at_i>${sinceUnix}&hitsPerPage=${Math.min(50, limit * 2)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HN Algolia fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as SearchHitsResponse;
  result.candidates = data.hits.length;

  for (const hit of data.hits) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    if (hit.points < minPoints) continue;

    // Dedupe BEFORE any LLM/OneShot spend.
    if (ledger.isQueueDuplicate(PLAY_NAME, hit.objectID)) {
      result.droppedDuplicate++;
      continue;
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
      continue;
    }

    if (opts.dryRun) {
      // Just count — don't enrich or enqueue.
      result.enqueued++;
      continue;
    }

    // Enrich: try to find the founder's email via the landing-page domain + author handle.
    const domain = urlDomain(hit.url);
    if (!domain) {
      result.droppedEnrichment++;
      continue;
    }

    // Read the landing page so we have content for the hookSummary fallback +
    // a crude "founder name" guess (use the HN handle as fullName if present).
    const fullName = hit.author && hit.author.length > 0 ? hit.author : undefined;
    const findInput: FindEmailInput = { companyDomain: domain };
    if (fullName) findInput.fullName = fullName;
    const found = await findEmail(findInput, { playName: PLAY_NAME });
    result.costUsd += extractCost(found.result) ?? 0.05;

    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      continue;
    }
    const email = found.result.email;

    // Verify deliverability.
    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += extractCost(verified.result) ?? 0.01;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      continue;
    }

    // Cross-table dedupe: same email already a known prospect?
    if (isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.objectID, prospectEmail: email })) {
      result.droppedDuplicate++;
      continue;
    }

    // Optional: read the landing page for a richer hookSummary.
    let hookSummary = (hit.story_text ?? "").trim().slice(0, 280);
    if (hookSummary.length < 40 && hit.url) {
      try {
        const read = await webRead({ url: hit.url }, { playName: PLAY_NAME });
        result.costUsd += extractCost(read.result) ?? 0.02;
        hookSummary = (read.result.markdown ?? "").trim().slice(0, 280);
      } catch {
        // best-effort; fall through to whatever we have
      }
    }
    if (!hookSummary || hookSummary.length < 20) {
      hookSummary = `Show HN post: ${hit.title}. ${hit.points} points.`;
    }

    const target: ShowHnTarget = {
      postTitle: hit.title,
      postUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      founderName: found.result.full_name ?? hit.author,
      founderEmail: email,
      hookSummary,
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
  }

  return result;
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
