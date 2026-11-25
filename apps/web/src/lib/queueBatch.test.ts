import type { QueueListResponse, QueueRowView } from "@oneshot-gtm/shared-types";
import { describe, expect, it } from "vitest";
import { readQueueBatch } from "./queueBatch.ts";

const row = (id: number) => ({ id }) as QueueRowView;
const page = (ids: number[], more: { hasMore: boolean; nextOffset?: number }): QueueListResponse =>
  ({
    rows: ids.map(row),
    counts: { pending: 0, approved: 0, rejected: 0, sent: 0, expired: 0 },
    approvedByPlay: {},
    ...more,
  }) as QueueListResponse;

describe("readQueueBatch", () => {
  it("reads on past an empty or short page while the server has more", async () => {
    const offsets: number[] = [];
    const pages: Record<number, QueueListResponse> = {
      0: page([], { hasMore: true, nextOffset: 100 }),
      100: page([1, 2], { hasMore: true, nextOffset: 200 }),
      200: page([2, 3, 4, 5], { hasMore: true, nextOffset: 300 }),
    };
    const out = await readQueueBatch(async (offset) => {
      offsets.push(offset);
      return pages[offset]!;
    }, 4);
    expect(out.rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it("stops at the first page when it is full or the server has no more", async () => {
    let calls = 0;
    const full = await readQueueBatch(async () => {
      calls++;
      return page([1, 2], { hasMore: true, nextOffset: 2 });
    }, 2);
    expect(full.rows).toHaveLength(2);
    const done = await readQueueBatch(async () => {
      calls++;
      return page([1], { hasMore: false });
    }, 5);
    expect(done.rows).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("gives up after a bounded number of further reads", async () => {
    let calls = 0;
    const out = await readQueueBatch(async (offset) => {
      calls++;
      return page([], { hasMore: true, nextOffset: offset + 1 });
    }, 5);
    expect(out.rows).toEqual([]);
    expect(out.hasMore).toBe(true);
    expect(calls).toBe(21);
  });
});
