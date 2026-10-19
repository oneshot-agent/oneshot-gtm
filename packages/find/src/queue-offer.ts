/**
 * Keep a queue row's prospect offer current (see plays/_prospect-offer.ts).
 *
 * Written after a finder's research stages, so the founder reviews the offer
 * with the row, and checked again before any draft, so a row researched
 * before offers existed, or whose research changed, gets one. Never throws:
 * a row without an offer drafts as before.
 *
 * Background paths (a finder run, a moved row) first read the company's own
 * pages when the row has a company domain and none were read: offers written
 * from a one-line description lean on industry words. A click never waits on
 * that read (one page takes about a minute).
 */
import {
  getLedger,
  logEvent,
  parallelMap,
  resolveTriggerOverlay,
  type QueueRow,
} from "@oneshot-gtm/core";
import { activeOfferPatch, ensureOfferSet, playMakesOffer } from "@oneshot-gtm/plays";
import {
  hasCompanyPages,
  productResearchSkipsPlay,
  queueRowCompanyDomain,
  researchQueueRowProduct,
  writeLiveQueueProductResearch,
} from "./_product-research.ts";
import type { FinderResult } from "./_types.ts";
import { resolveQueueTarget } from "./queue-target.ts";

type JsonRecord = Record<string, unknown>;

function parsePayload(row: Pick<QueueRow, "payload_json">): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

/** The payload with the trigger's current edge; the stored one when the trigger can't be read. */
function edgeTarget(payload: JsonRecord, row: Partial<Pick<QueueRow, "source">>): JsonRecord {
  try {
    return resolveTriggerOverlay(payload, row.source ?? null, (name) =>
      getLedger().getTrigger(name),
    );
  } catch {
    return payload;
  }
}

/** Spend cap for one row's company research on a background path, in USD. */
export const ROW_RESEARCH_BUDGET_USD = 1;
/** A research attempt this recent (the finder's own, moments ago) is not repeated. */
const RESEARCH_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface QueueRowOfferOpts {
  /**
   * Read the company's own pages first when the row has a company domain and
   * no page text yet. Background paths only: it can take minutes.
   */
  research?: boolean;
  /** Spend cap for that read. Default ROW_RESEARCH_BUDGET_USD. */
  researchBudgetUsd?: number;
  /** Told what the read cost, so a finder run can count it. */
  onResearchCost?: (usd: number) => void;
}

type OfferableRow = Pick<QueueRow, "id" | "play_name" | "payload_json"> &
  Partial<Pick<QueueRow, "source" | "notes">>;

/** True when a background pass should read the company's pages before writing offers. */
export function needsCompanyResearch(playName: string, payload: JsonRecord): boolean {
  if (productResearchSkipsPlay(playName) || hasCompanyPages(payload)) return false;
  if (!queueRowCompanyDomain(payload)) return false;
  const prior = payload["productResearch"] as JsonRecord | undefined;
  const at = prior && typeof prior === "object" ? Date.parse(String(prior["researchedAt"])) : NaN;
  return !(Number.isFinite(at) && Date.now() - at < RESEARCH_RETRY_AFTER_MS);
}

/**
 * The payload with company research added, written to the live row. Errors
 * and a refused budget leave the payload as it was: offers are then written
 * from what is stored.
 */
async function researchCompany(
  row: OfferableRow,
  payload: JsonRecord,
  opts: QueueRowOfferOpts,
): Promise<{ payload: JsonRecord; written: boolean }> {
  if (!needsCompanyResearch(row.play_name, payload)) return { payload, written: false };
  try {
    const out = await researchQueueRowProduct(
      {
        id: row.id,
        play_name: row.play_name,
        source: row.source ?? "",
        notes: row.notes ?? null,
        payload_json: row.payload_json,
      },
      { remainingUsd: opts.researchBudgetUsd ?? ROW_RESEARCH_BUDGET_USD },
    );
    opts.onResearchCost?.(out.costUsd);
    const { dossier } = out;
    if (!out.cached && dossier.warning?.includes("cost cap reached")) {
      return { payload, written: false };
    }
    // Never replace research the row has with a read that found nothing.
    if (dossier.status === "unavailable" && payload["productResearch"]) {
      return { payload, written: false };
    }
    const written = writeLiveQueueProductResearch(row.id, dossier);
    logEvent("queue_offer.researched", {
      queue_id: row.id,
      status: dossier.status,
      pages: dossier.sources.filter((s) => s.excerpt).length,
      cached: out.cached,
      cost_usd: out.costUsd,
    });
    return { payload: { ...payload, productResearch: dossier }, written };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "queue-offer-research",
        queue_id: row.id,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return { payload, written: false };
  }
}

/**
 * The row with a current offer on its payload. Writes only to a live row
 * (pending or approved, not sending); a row that moved on keeps its payload,
 * and the returned row still carries the offer for the draft in hand.
 */
export async function ensureQueueRowOffer<R extends OfferableRow>(
  row: R,
  opts: QueueRowOfferOpts = {},
): Promise<R> {
  const stored = parsePayload(row);
  if (!stored) return row;
  try {
    if (!playMakesOffer(row.play_name)) return row;
    const researched = opts.research
      ? await researchCompany(row, stored, opts)
      : { payload: stored, written: false };
    const payload = researched.payload;
    // The trigger's current edge, not the offer's own angles: the angle
    // writer takes the founder's angles as material.
    const target = edgeTarget(payload, row);
    const set = await ensureOfferSet({ target, playName: row.play_name });
    const ledger = getLedger();
    if (!set?.changed) {
      if (!researched.written) return row;
      const fresh = ledger.getQueueRow(row.id);
      return { ...row, payload_json: fresh?.payload_json ?? JSON.stringify(payload) };
    }
    // Replaces the old offer whole: none of its keys (an approval, a label) carry over.
    const patch = activeOfferPatch(payload["offer"], set.offer, set.candidates);
    // Re-read after the write: callers compare payload_json against the
    // stored text to detect a concurrent change, so it must be the DB's own.
    const written = ledger.patchLiveQueuePayload({ id: row.id, patch });
    const fresh = written ? ledger.getQueueRow(row.id) : null;
    return {
      ...row,
      payload_json:
        fresh?.payload_json ??
        JSON.stringify({ ...payload, offer: set.offer, offerCandidates: set.candidates }),
    };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "queue-offer",
        queue_id: row.id,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return row;
  }
}

/** `resolveQueueTarget` for a row about to be drafted: its offer made current first. */
export async function resolveQueueTargetWithOffer(row: QueueRow): Promise<unknown> {
  return resolveQueueTarget(await ensureQueueRowOffer(row));
}

/**
 * Write offers for the rows the just-finished finder run created. With
 * `research`, a row the run's research stage left without company pages is
 * read first, within the run's remaining budget.
 */
export async function offerNewQueueRows(input: {
  afterId: number;
  result: FinderResult;
  research?: { enabled: boolean; maxCostUsd?: number };
}): Promise<void> {
  const ledger = getLedger();
  const ownsSource = (source: string): boolean =>
    source === input.result.source ||
    source.startsWith(`${input.result.source}:`) ||
    input.result.source.startsWith(`${source}:`);
  const rows = ledger
    .listPendingQueueAfterId(input.afterId)
    .filter((row) => ownsSource(row.source));
  const research = input.research?.enabled === true;
  const cap = input.research?.maxCostUsd;
  // Each row's budget comes from the running total; concurrent workers would
  // all see the same remainder and could overspend the cap together.
  const concurrency = research && cap !== undefined ? 1 : 3;
  await parallelMap(rows, concurrency, async (row) => {
    await ensureQueueRowOffer(row, {
      research,
      researchBudgetUsd:
        cap === undefined
          ? ROW_RESEARCH_BUDGET_USD
          : Math.min(
              ROW_RESEARCH_BUDGET_USD,
              Math.max(0, cap - (input.result.sdkCostUsd ?? input.result.costUsd)),
            ),
      onResearchCost: (usd) => {
        input.result.costUsd += usd;
        if (input.result.sdkCostUsd !== undefined) input.result.sdkCostUsd += usd;
      },
    });
  });
}
