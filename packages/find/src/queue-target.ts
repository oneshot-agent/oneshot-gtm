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
 * the trigger has it, for callers that write new offers and angles.
 */
export function resolveQueueTarget(
  row: Pick<QueueRow, "payload_json" | "source">,
  opts: { offerAngles?: boolean } = {},
): unknown {
  const target: unknown = JSON.parse(row.payload_json);
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  const resolved = resolveTriggerOverlay(target as Record<string, unknown>, row.source, (name) =>
    getLedger().getTrigger(name),
  );
  return opts.offerAngles === false ? resolved : overlayOfferAngles(resolved);
}
