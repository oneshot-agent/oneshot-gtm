import type { RunPlayEvent } from "@oneshot-gtm/shared-types";

type IndexedRunPlayEvent = Extract<RunPlayEvent, { index: number }>;

/**
 * Verification removes invalid targets before dispatch, so draft/send/error
 * indexes refer to the filtered target array. Translate them back to indexes
 * in the original rows before using them to mutate the form.
 *
 * Older persisted verify events may not contain dropped indexes. Recover those
 * by email; if any drop is still ambiguous, discard indexed events so callers
 * fail safe instead of treating filtered indexes as original indexes.
 */
export function remapFilteredEventIndexes(
  events: RunPlayEvent[],
  rows: Record<string, string>[],
): RunPlayEvent[] {
  const verifyEvent = events.find(
    (event): event is Extract<RunPlayEvent, { kind: "verify" }> => event.kind === "verify",
  );
  if (!verifyEvent) return events;

  const droppedIndexes = new Set<number>();
  const unresolvedDrops: typeof verifyEvent.dropped = [];
  for (const dropped of verifyEvent.dropped) {
    if (
      typeof dropped.index === "number" &&
      dropped.index >= 0 &&
      dropped.index < rows.length &&
      !droppedIndexes.has(dropped.index)
    ) {
      droppedIndexes.add(dropped.index);
    } else {
      unresolvedDrops.push(dropped);
    }
  }

  for (const dropped of unresolvedDrops) {
    const droppedEmail = dropped.email.trim().toLowerCase();
    const originalIndex = rows.findIndex((row, index) => {
      if (droppedIndexes.has(index)) return false;
      const rowEmail = (row["email"] ?? row["founderEmail"] ?? "").trim().toLowerCase();
      return rowEmail === droppedEmail;
    });
    if (originalIndex === -1) {
      return events.filter((event): event is Exclude<RunPlayEvent, IndexedRunPlayEvent> => {
        return event.kind !== "draft" && event.kind !== "send" && event.kind !== "error";
      });
    }
    droppedIndexes.add(originalIndex);
  }

  const postDropToOriginal = new Map<number, number>();
  let postDropIndex = 0;
  for (let originalIndex = 0; originalIndex < rows.length; originalIndex++) {
    if (!droppedIndexes.has(originalIndex)) {
      postDropToOriginal.set(postDropIndex, originalIndex);
      postDropIndex++;
    }
  }

  return events
    .map((event) => {
      if (event.kind === "draft" || event.kind === "send" || event.kind === "error") {
        const originalIndex = postDropToOriginal.get(event.index);
        if (originalIndex !== undefined) return { ...event, index: originalIndex };
        // Drop unmappable indexed events instead of returning them unchanged
        // with a filtered index that pruneSentRows will misinterpret.
        return null;
      }
      return event;
    })
    .filter((event): event is RunPlayEvent => event !== null);
}

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
