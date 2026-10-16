/**
 * Keep a queue row's prospect offer current (see plays/_prospect-offer.ts).
 *
 * Written after a finder's research stages, so the founder reviews the offer
 * with the row, and checked again before any draft, so a row researched
 * before offers existed, or whose research changed, gets one. Never throws:
 * a row without an offer drafts as before.
 */
import {
  getLedger,
  logEvent,
  parallelMap,
  resolveTriggerOverlay,
  type QueueRow,
} from "@oneshot-gtm/core";
import { ensureOfferSet, playMakesOffer } from "@oneshot-gtm/plays";
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

/**
 * The row with a current offer on its payload. Writes only to a live row
 * (pending or approved, not sending); a row that moved on keeps its payload,
 * and the returned row still carries the offer for the draft in hand.
 */
export async function ensureQueueRowOffer<
  R extends Pick<QueueRow, "id" | "play_name" | "payload_json"> & Partial<Pick<QueueRow, "source">>,
>(row: R): Promise<R> {
  const payload = parsePayload(row);
  if (!payload) return row;
  try {
    if (!playMakesOffer(row.play_name)) return row;
    // The trigger's current edge, not the offer's own angles: the angle
    // writer takes the founder's angles as material.
    const target = edgeTarget(payload, row);
    const set = await ensureOfferSet({ target, playName: row.play_name });
    if (!set?.changed) return row;
    const patch = { offer: set.offer, offerCandidates: set.candidates };
    const ledger = getLedger();
    // Re-read after the write: callers compare payload_json against the
    // stored text to detect a concurrent change, so it must be the DB's own.
    const written = ledger.patchLiveQueuePayload({ id: row.id, patch });
    const fresh = written ? ledger.getQueueRow(row.id) : null;
    return {
      ...row,
      payload_json: fresh?.payload_json ?? JSON.stringify({ ...payload, ...patch }),
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

/** Write offers for the rows the just-finished finder run created. */
export async function offerNewQueueRows(input: {
  afterId: number;
  result: FinderResult;
}): Promise<void> {
  const ledger = getLedger();
  const ownsSource = (source: string): boolean =>
    source === input.result.source ||
    source.startsWith(`${input.result.source}:`) ||
    input.result.source.startsWith(`${source}:`);
  const rows = ledger
    .listPendingQueueAfterId(input.afterId)
    .filter((row) => ownsSource(row.source));
  await parallelMap(rows, 3, async (row) => {
    await ensureQueueRowOffer(row);
  });
}
