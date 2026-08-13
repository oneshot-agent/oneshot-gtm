import { describe, expect, it, vi } from "vitest";

// GET /api/queue carries `approvedByPlay` — whole-queue approved counts per
// play — alongside the filtered `rows`. /queue's drain button reads it, so the
// contract that matters is: the counts must NOT be narrowed by the request's
// status/play filters (the button has to work from the default `pending` view).

const listQueueCalls: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      listQueue: (args: Record<string, unknown>) => {
        listQueueCalls.push(args);
        return [];
      },
      queueCounts: () => ({ pending: 0, approved: 220, rejected: 0, sent: 0, expired: 0 }),
      approvedCountsByPlay: () => ({ "luma-events": 145, "repo-interest": 35 }),
    }),
  };
});

const { listQueueRoute } = await import("../src/api/queue.ts");

async function body(url: string): Promise<Record<string, unknown>> {
  const res = listQueueRoute(new Request(url));
  return (await res.json()) as Record<string, unknown>;
}

describe("listQueueRoute", () => {
  it("returns per-play approved counts", async () => {
    const out = await body("http://x/api/queue");
    expect(out["approvedByPlay"]).toEqual({ "luma-events": 145, "repo-interest": 35 });
  });

  it("passes an explicit ?ids= pick through to the row query", async () => {
    listQueueCalls.length = 0;
    await body("http://x/api/queue?ids=7,9,11&play=luma-events&status=approved");
    expect(listQueueCalls[0]).toMatchObject({
      ids: [7, 9, 11],
      playName: "luma-events",
      status: "approved",
    });
  });

  it("drops junk ids and raises the limit to cover the pick", async () => {
    listQueueCalls.length = 0;
    await body("http://x/api/queue?ids=7,abc,,-3,0,9&limit=1");
    // Only the two usable ids survive; limit can't be lower than the pick or
    // the tail of a big selection would silently vanish.
    expect(listQueueCalls[0]).toMatchObject({ ids: [7, 9], limit: 2 });
  });

  it("keeps those counts whole-queue even when rows are filtered", async () => {
    listQueueCalls.length = 0;
    const out = await body("http://x/api/queue?status=pending&play=show-hn");
    // The filters reach the row query…
    expect(listQueueCalls[0]).toMatchObject({ status: "pending", playName: "show-hn" });
    expect(out["rows"]).toEqual([]);
    // …but not the counts, which is the whole point.
    expect(out["approvedByPlay"]).toEqual({ "luma-events": 145, "repo-interest": 35 });
  });
});
