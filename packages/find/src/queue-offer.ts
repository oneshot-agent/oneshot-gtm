/**
 * Keep a queue row's prospect offer current (see plays/_prospect-offer.ts).
 *
 * Written after a finder's research stages, so the founder reviews the offer
 * with the row, and checked again before any draft, so a row researched
 * before offers existed, or whose research changed, gets one. Never throws:
 * a row without an offer drafts as before.
 *
 * Background paths (a finder run, a moved row) and Regenerate draft first
 * read the company's research when the row has a company to read and its
 * research is missing or lacks the outside half: offers written from a
 * homepage, or a one-line description, lean on industry words. A click waits
 * for that read at most `CLICK_RESEARCH_WAIT_MS` (the outside research takes
 * minutes); a read still running then lands on the row for the next pass.
 *
 * When the writer declines, or no offer passes the relevance judge in any
 * round, the reason is kept on the payload (`offerSkip`, with the hash of
 * the research it read) and shown on the row, and a stored offer that no
 * longer stands is deleted with it (`offerSkipPatch`); drafts do not ask
 * again until that research changes.
 */
import {
  getLedger,
  logEvent,
  parallelMap,
  resolveTriggerOverlay,
  type QueueRow,
} from "@oneshot-gtm/core";
import {
  activeOfferPatch,
  ensureOfferSet,
  isOfferSkipped,
  offerSkipPatch,
  playMakesOffer,
} from "@oneshot-gtm/plays";
import {
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

/**
 * Longest a click waits for company research before writing from what is
 * stored. Under the server's 255 s idle timeout, with room for the offers
 * and the draft after it.
 */
export const CLICK_RESEARCH_WAIT_MS = 120_000;

export interface QueueRowOfferOpts {
  /**
   * Read the company's research first when it is missing or incomplete
   * (`needsCompanyResearch`). It can take minutes: a click sets
   * `researchWaitMs`.
   */
  research?: boolean;
  /** Spend cap for that read. Default ROW_RESEARCH_BUDGET_USD. */
  researchBudgetUsd?: number;
  /**
   * Longest wait for that read. Past it the offers are written from what is
   * stored, and the read lands on the live row when it finishes.
   */
  researchWaitMs?: number;
  /** Told what the read cost, so a finder run can count it. */
  onResearchCost?: (usd: number) => void;
}

type OfferableRow = Pick<QueueRow, "id" | "play_name" | "payload_json"> &
  Partial<Pick<QueueRow, "source" | "notes">>;

function companyName(payload: JsonRecord): string | null {
  for (const key of ["company", "newCompany", "guestCompany"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim() && v.trim() !== "(unknown)") return v.trim();
  }
  return null;
}

/**
 * True when the row's company research should be read before offers are
 * written: it has a company to read (a domain or a name), and its research
 * is missing or lacks the outside half (`status` other than `complete`). A
 * homepage read alone is not enough: it is often a cookie banner. An attempt
 * in the last day is not repeated, so a read that keeps failing is not
 * bought again on every click.
 */
export function needsCompanyResearch(playName: string, payload: JsonRecord): boolean {
  if (productResearchSkipsPlay(playName)) return false;
  const prior = payload["productResearch"] as JsonRecord | undefined;
  if (prior && typeof prior === "object" && prior["status"] === "complete") return false;
  if (!queueRowCompanyDomain(payload) && !companyName(payload)) return false;
  const at = prior && typeof prior === "object" ? Date.parse(String(prior["researchedAt"])) : NaN;
  return !(Number.isFinite(at) && Date.now() - at < RESEARCH_RETRY_AFTER_MS);
}

/** What one company read gave the row. */
export interface RowResearch {
  /** The payload, with the new research when it came back. */
  payload: JsonRecord;
  /** True when the new research is on `payload`. */
  researched: boolean;
  /** True when it was also written to the live row. */
  written: boolean;
  costUsd: number;
}

/**
 * The payload with company research added, written to the live row (a sent
 * row keeps its payload). Errors, a refused budget and a read past
 * `researchWaitMs` leave the payload as it was: offers are then written from
 * what is stored. Never throws.
 */
export async function researchQueueRowCompany(
  row: OfferableRow,
  payload: JsonRecord,
  opts: QueueRowOfferOpts = {},
): Promise<RowResearch> {
  const unchanged: RowResearch = { payload, researched: false, written: false, costUsd: 0 };
  if (!needsCompanyResearch(row.play_name, payload)) return unchanged;
  const read = readCompany(row, payload, opts);
  if (opts.researchWaitMs === undefined) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.researchWaitMs);
  });
  const out = await Promise.race([read, late]);
  clearTimeout(timer);
  if (out) return out;
  // The read goes on, and writes the live row when it lands.
  logEvent("queue_offer.research_pending", { queue_id: row.id, wait_ms: opts.researchWaitMs });
  return unchanged;
}

async function readCompany(
  row: OfferableRow,
  payload: JsonRecord,
  opts: QueueRowOfferOpts,
): Promise<RowResearch> {
  const unchanged: RowResearch = { payload, researched: false, written: false, costUsd: 0 };
  try {
    const out = await researchQueueRowProduct(
      {
        id: row.id,
        play_name: row.play_name,
        source: row.source ?? "",
        notes: row.notes ?? null,
        // The payload as the caller holds it: a sequence's target has the
        // intro's offer taken off.
        payload_json: JSON.stringify(payload),
      },
      { remainingUsd: opts.researchBudgetUsd ?? ROW_RESEARCH_BUDGET_USD },
    );
    opts.onResearchCost?.(out.costUsd);
    const { dossier } = out;
    if (!out.cached && dossier.warning?.includes("cost cap reached")) {
      return { ...unchanged, costUsd: out.costUsd };
    }
    // Never replace research the row has with a read that found nothing.
    if (dossier.status === "unavailable" && payload["productResearch"]) {
      return { ...unchanged, costUsd: out.costUsd };
    }
    const written = writeLiveQueueProductResearch(row.id, dossier);
    logEvent("queue_offer.researched", {
      queue_id: row.id,
      status: dossier.status,
      pages: dossier.sources.filter((s) => s.excerpt).length,
      cached: out.cached,
      cost_usd: out.costUsd,
    });
    return {
      payload: { ...payload, productResearch: dossier },
      researched: true,
      written,
      costUsd: out.costUsd,
    };
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
    return unchanged;
  }
}

/**
 * What the row's payload should change to after an offer lookup, and the
 * payload as the draft in hand reads it should the write not land: a fresh
 * set, a fresh writer skip, or, when nothing could be written, no skip left
 * over from research that has since changed. Null: nothing to write.
 */
function offerPayloadChange(
  payload: JsonRecord,
  set: Awaited<ReturnType<typeof ensureOfferSet>>,
): { patch: JsonRecord; fallback: JsonRecord } | null {
  if (!set) {
    if (payload["offerSkip"] === undefined) return null;
    const { offerSkip: _stale, ...rest } = payload;
    return { patch: { offerSkip: null }, fallback: rest };
  }
  if (!set.changed) return null;
  if (isOfferSkipped(set)) {
    // A stale or weak set goes with it: the row is held `no-offer`, not shown one.
    const patch = offerSkipPatch(payload["offer"], set.skipped);
    const fallback: JsonRecord = { ...payload, offerSkip: set.skipped };
    if (patch.offer === null) {
      delete fallback["offer"];
      delete fallback["offerCandidates"];
    }
    return { patch, fallback };
  }
  // Replaces the old offer whole: none of its keys (an approval, a label) carry over.
  const { offerSkip: _cleared, ...rest } = payload;
  return {
    patch: activeOfferPatch(payload["offer"], set.offer, set.candidates),
    fallback: { ...rest, offer: set.offer, offerCandidates: set.candidates },
  };
}

/** The row as the offer writer's research hook takes it (`DeriveOfferInput.research`). */
export function offerResearchRow(
  row: Pick<OfferableRow, "id" | "source">,
  opts: Pick<QueueRowOfferOpts, "researchWaitMs"> = {},
): { queueRowId: number; source: string; waitMs?: number } {
  return {
    queueRowId: row.id,
    source: row.source ?? "",
    ...(opts.researchWaitMs !== undefined ? { waitMs: opts.researchWaitMs } : {}),
  };
}

/**
 * The row with a current offer on its payload, or the writer's current skip.
 * Writes only to a live row (pending or approved, not sending); a row that
 * moved on keeps its payload, and the returned row still carries the offer
 * for the draft in hand.
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
      ? await researchQueueRowCompany(row, stored, opts)
      : { payload: stored, written: false };
    const payload = researched.payload;
    // The trigger's current edge, not the offer's own angles: the angle
    // writer takes the founder's angles as material.
    const target = edgeTarget(payload, row);
    const set = await ensureOfferSet({
      target,
      playName: row.play_name,
      // A set the judge passes none of reads the research first, unless
      // this pass already asked for it (a read still running is not bought twice).
      ...(opts.research ? {} : { research: offerResearchRow(row, opts) }),
    });
    const ledger = getLedger();
    const change = offerPayloadChange(payload, set);
    if (!change) {
      if (!researched.written) return row;
      const fresh = ledger.getQueueRow(row.id);
      return { ...row, payload_json: fresh?.payload_json ?? JSON.stringify(payload) };
    }
    // Re-read after the write: callers compare payload_json against the
    // stored text to detect a concurrent change, so it must be the DB's own.
    const written = ledger.patchLiveQueuePayload({ id: row.id, patch: change.patch });
    const fresh = written ? ledger.getQueueRow(row.id) : null;
    return { ...row, payload_json: fresh?.payload_json ?? JSON.stringify(change.fallback) };
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
