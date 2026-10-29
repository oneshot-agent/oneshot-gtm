import { playMakesOffer } from "@oneshot-gtm/plays";
import {
  getLedger,
  overlayOfferAngles,
  resolveTriggerOverlay,
  type QueueRow,
} from "@oneshot-gtm/core";

/**
 * Refresh sender-authored edges at generation time without rewriting queue
 * history. The row's active offer, when it carries angles, then supplies the
 * angle pool (`overlayOfferAngles`); `offerAngles: false` leaves the edge as
 * the trigger has it, for callers that write new offers and angles. A row of
 * a play that makes no offer (`playMakesOffer`, the workspace's
 * `noOfferPlays` included) drafts from the trigger's edge: an offer stored on
 * it from before is dropped from the target, angles and all.
 */
export function resolveQueueTarget(
  row: Pick<QueueRow, "payload_json" | "source"> & { play_name?: string },
  opts: { offerAngles?: boolean } = {},
): unknown {
  const target: unknown = JSON.parse(row.payload_json);
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  const resolved = resolveTriggerOverlay(target as Record<string, unknown>, row.source, (name) =>
    getLedger().getTrigger(name),
  );
  if (row.play_name !== undefined && !playMakesOffer(row.play_name)) {
    const { offer: _offer, offerCandidates: _candidates, ...rest } = resolved;
    return rest;
  }
  return opts.offerAngles === false ? resolved : overlayOfferAngles(resolved);
}
