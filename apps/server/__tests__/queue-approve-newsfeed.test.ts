import { beforeEach, describe, expect, it, vi } from "vitest";

// Approval is when recent posts are bought: both approve routes hand the
// approved ids to the background capture, after the status write, and the
// response never waits on it. A refused approval schedules nothing.

const queueRows = new Map<number, Record<string, unknown>>();
const order: string[] = [];
const scheduled: number[][] = [];
let bulkApproved = 0;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getQueueRow: (id: number) => queueRows.get(id) ?? null,
      findProspectByEmail: () => null,
      setQueueStatus: (input: { id: number }) => order.push(`status:${input.id}`),
      listQueue: (opts: { status?: string; playName?: string }) =>
        [...queueRows.values()].filter(
          (r) =>
            r["status"] === opts.status &&
            (opts.playName === undefined || r["play_name"] === opts.playName),
        ),
      approveAllPending: () => {
        order.push("bulk");
        return bulkApproved;
      },
    }),
  };
});

vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  return {
    ...actual,
    scheduleNewsfeedOnApproval: (ids: number[]) => {
      order.push("newsfeed");
      scheduled.push([...ids]);
    },
  };
});

const { approveQueueRoute, approveAllRoute } = await import("../src/api/queue.ts");

function row(id: number, status: string, play = "show-hn"): Record<string, unknown> {
  return {
    id,
    play_name: play,
    payload_json: JSON.stringify({ name: "Ada Lovelace", email: `ada${id}@x.example` }),
    dedupe_key: `k${id}`,
    source: `find:${play}`,
    status,
    found_at: "2026-09-01 10:00:00",
    sent_at: null,
    notes: null,
    prospect_id: null,
  };
}

beforeEach(() => {
  queueRows.clear();
  order.length = 0;
  scheduled.length = 0;
  bulkApproved = 0;
});

describe("approve schedules the newsfeed capture", () => {
  it("single approve: after the status write, for that row only", async () => {
    queueRows.set(5, row(5, "pending"));
    const res = await approveQueueRoute(
      new Request("http://x/api/queue/5/approve", { method: "POST" }),
      { id: "5" },
    );
    expect(res.status).toBe(200);
    expect(order).toEqual(["status:5", "newsfeed"]);
    expect(scheduled).toEqual([[5]]);
  });

  it("a refused approval schedules nothing", async () => {
    queueRows.set(6, row(6, "sent"));
    const res = await approveQueueRoute(
      new Request("http://x/api/queue/6/approve", { method: "POST" }),
      { id: "6" },
    );
    expect(res.status).toBe(409);
    expect(scheduled).toEqual([]);
  });

  it("bulk approve: the pending ids taken before the update, scoped to the play", async () => {
    queueRows.set(1, row(1, "pending", "show-hn"));
    queueRows.set(2, row(2, "pending", "luma-events"));
    queueRows.set(3, row(3, "pending", "show-hn"));
    queueRows.set(4, row(4, "approved", "show-hn"));
    bulkApproved = 2;
    const res = await approveAllRoute(
      new Request("http://x/api/queue/approve-all", {
        method: "POST",
        body: JSON.stringify({ play: "show-hn" }),
      }),
    );
    expect(await res.json()).toEqual({ approved: 2 });
    expect(order).toEqual(["bulk", "newsfeed"]);
    expect(scheduled).toEqual([[1, 3]]);
  });

  it("bulk approve that approves nothing schedules nothing", async () => {
    bulkApproved = 0;
    await approveAllRoute(new Request("http://x/api/queue/approve-all", { method: "POST" }));
    expect(scheduled).toEqual([]);
  });
});
