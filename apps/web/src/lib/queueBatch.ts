import type { QueueListResponse } from "@oneshot-gtm/shared-types";

/** Requests a batch may make past its first: a filtered scan reads up to 10,000 candidates each. */
const MAX_FOLLOW_UPS = 20;

/**
 * A run's batch from the queue list: the first page, then the next ones from
 * `nextOffset` while the server says there is more and the batch is short. A
 * filtered scan can stop at its read limit with a short or empty page, and
 * that must not end the batch early.
 */
export async function readQueueBatch(
  request: (offset: number) => Promise<QueueListResponse>,
  limit: number,
): Promise<QueueListResponse> {
  const res = await request(0);
  const rows = [...res.rows];
  let page = res;
  for (let n = 0; page.hasMore && rows.length < limit && n < MAX_FOLLOW_UPS; n++) {
    if (page.nextOffset == null) break;
    page = await request(page.nextOffset);
    const seen = new Set(rows.map((r) => r.id));
    rows.push(...page.rows.filter((r) => !seen.has(r.id)).slice(0, limit - rows.length));
  }
  return { ...res, rows, hasMore: page.hasMore ?? false, nextOffset: page.nextOffset };
}
