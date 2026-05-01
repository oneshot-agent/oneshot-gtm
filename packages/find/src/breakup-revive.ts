import { getLedger } from "@oneshot-gtm/core";
import type { BreakupReviveTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "breakup-revive";
const SOURCE = "find:breakup-revive";

export interface BreakupReviveFinderOpts extends RunOpts {
  /** Min days since last activity to consider cold. Default 60. */
  minDays?: number;
  /** Max days since last activity to consider revivable. Default 90. */
  maxDays?: number;
}

/**
 * Scan the local ledger for cold prospects (no activity in the last
 * min/maxDays window) and enqueue them into target_queue. No LLM calls,
 * no OneShot spend — this is a ledger-only finder that reuses the same
 * review → approve → drain lifecycle as every other finder.
 */
export function runBreakupReviveFinder(opts: BreakupReviveFinderOpts): FinderResult {
  const limit = opts.limit ?? 25;
  const minDays = opts.minDays ?? 60;
  const maxDays = opts.maxDays ?? 90;
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

  const cold = ledger.listColdProspects({
    minDaysSinceLastEvent: minDays,
    maxDaysSinceLastEvent: maxDays,
    limit: limit * 2, // pull extra; we'll drop any already in the queue
  });
  result.candidates = cold.length;

  for (const p of cold) {
    if (result.enqueued >= limit) break;
    if (!p.email) {
      result.droppedEnrichment++;
      continue;
    }

    // Dedupe key = prospect id so re-running doesn't re-enqueue the same
    // person until their previous queue row is archived or expired.
    const dedupeKey = `prospect:${p.id}`;
    if (isDuplicate({ playName: PLAY_NAME, dedupeKey, prospectEmail: undefined })) {
      result.droppedDuplicate++;
      continue;
    }

    const daysCold = p.last_event_at
      ? Math.floor((Date.now() - new Date(p.last_event_at).getTime()) / (24 * 3600 * 1000))
      : 0;

    const target: BreakupReviveTarget = {
      name: p.name,
      email: p.email,
      company: p.company,
      daysCold,
      lastEventAt: p.last_event_at,
      linkedinUrl: p.linkedin_url ?? null,
      phone: p.phone ?? null,
    };

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey,
      source: SOURCE,
      notes: `${daysCold}d cold${p.company ? ` — ${p.company}` : ""}`,
    });
    if (id != null) {
      // Link the queue row to the prospect right away so the /queue page
      // can surface the connection without the drain-time backfill dance.
      try {
        ledger.setQueueProspectId(id, p.id);
      } catch {
        // best-effort — drain.ts will also try to backfill
      }
      result.enqueued++;
    } else {
      result.droppedDuplicate++;
    }
  }

  return result;
}
