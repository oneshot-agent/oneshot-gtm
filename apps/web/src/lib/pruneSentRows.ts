import type { RunPlayEvent } from "@oneshot-gtm/shared-types";

/**
 * After a /api/run SSE stream finishes, drop the row entries that
 * successfully sent (kind="send" with non-empty receiptIds) so the form
 * doesn't redisplay them — and a second submission can't fire another
 * email to the same prospect. Held drafts, errored rows, and unsent rows
 * stay so the founder can fix + retry.
 *
 * Returns parallel-aligned `rows` + `dedupeKeys` with the same length,
 * preserving the original founder-entered order minus the pruned indices.
 * In dry-run there are no `send` events, so the input passes through.
 */
export function pruneSentRows(
  events: RunPlayEvent[],
  rows: Record<string, string>[],
  dedupeKeys: (string | null)[],
): { rows: Record<string, string>[]; dedupeKeys: (string | null)[]; prunedCount: number } {
  const sentIndices = new Set<number>();
  for (const ev of events) {
    if (ev.kind === "send" && ev.receiptIds.length > 0) {
      sentIndices.add(ev.index);
    }
  }
  if (sentIndices.size === 0) {
    return { rows, dedupeKeys, prunedCount: 0 };
  }
  const survivingRows: Record<string, string>[] = [];
  const survivingKeys: (string | null)[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (sentIndices.has(i)) continue;
    survivingRows.push(rows[i] as Record<string, string>);
    survivingKeys.push(dedupeKeys[i] ?? null);
  }
  return {
    rows: survivingRows,
    dedupeKeys: survivingKeys,
    prunedCount: sentIndices.size,
  };
}
