import { getLedger, resolveTriggerOverlay, type QueueRow } from "@oneshot-gtm/core";

/** Refresh sender-authored edges at generation time without rewriting queue history. */
export function resolveQueueTarget(row: Pick<QueueRow, "payload_json" | "source">): unknown {
  const target: unknown = JSON.parse(row.payload_json);
  if (!target || typeof target !== "object" || Array.isArray(target)) return target;
  return resolveTriggerOverlay(target as Record<string, unknown>, row.source, (name) =>
    getLedger().getTrigger(name),
  );
}
