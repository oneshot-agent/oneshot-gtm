import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueListResponse, QueueRowView } from "@oneshot-gtm/shared-types";

// Demo mode holds one captured /queue document per status/order/play view.
// The page's Show and Channel filters and "show more" pages are cut from it
// client-side, so none of them asks for a fixture that was never captured.

const fixtures = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/api/demo.ts", () => ({
  IS_DEMO: true,
  demoGet: fixtures.read,
  demoWrite: () => {
    throw new Error("Read-only demo");
  },
}));

const { api } = await import("../src/api/client.ts");
const { DEMO_QUEUE_LIMIT, QUEUE_PAGE_SIZE, queueRequest } =
  await import("../src/lib/queue-helpers.ts");

const DRAFT: QueueRowView["lastDraft"] = {
  subject: "Hi",
  body: "Hello",
  flags: [],
  sent: false,
  receiptIds: [],
  dryRun: true,
  draftedAt: "2026-10-20T10:00:00Z",
};

function view(id: number, patch: Partial<QueueRowView>): QueueRowView {
  return {
    id,
    playName: "show-hn",
    channel: "email",
    payload: { name: `Dana ${id}` },
    lastDraft: null,
    sendHold: null,
    offerReady: false,
    status: "approved",
    ...patch,
  } as QueueRowView;
}

/** 120 approved rows: every third drafted and offer ready, every fourth on LinkedIn. */
const doc: QueueListResponse = {
  rows: Array.from({ length: 120 }, (_, i) =>
    view(i + 1, {
      ...(i % 3 === 0 ? { lastDraft: DRAFT, offerReady: true } : {}),
      ...(i % 4 === 0 ? { channel: "linkedin" } : {}),
    }),
  ),
  counts: { pending: 0, approved: 120, rejected: 0, sent: 0, expired: 0 },
  approvedByPlay: { "show-hn": 120 },
  playCounts: { "show-hn": 120 },
  total: 120,
  order: "newest",
};

afterEach(() => {
  vi.clearAllMocks();
});

/** The table's request for one page, as queue.tsx builds it. */
function page(opts: Partial<Parameters<typeof queueRequest>[0]>) {
  return api.queue(
    queueRequest({
      statusFilter: "approved",
      playFilter: "all",
      orderOverride: null,
      limit: QUEUE_PAGE_SIZE,
      ...opts,
    }),
  );
}

describe("demo /queue", () => {
  it("cuts Show, Channel and later pages from the one captured document", async () => {
    // The captured tree has exactly one document for this view.
    fixtures.read.mockImplementation(async (path: string) => {
      if (path !== `/queue?status=approved&limit=${DEMO_QUEUE_LIMIT}`) {
        throw new Error(`DemoMissingFixtureError: ${path}`);
      }
      return doc;
    });

    const ready = await page({ show: "ready" });
    expect(ready.rows.map((r) => r.id)).toEqual(
      doc.rows.filter((_, i) => i % 3 === 0).map((r) => r.id),
    );
    expect(ready.total).toBe(40);

    const linkedin = await page({ channel: "linkedin" });
    expect(linkedin.total).toBe(30);
    expect(linkedin.rows.every((r) => r.channel === "linkedin")).toBe(true);

    const first = await page({});
    const second = await page({ offset: QUEUE_PAGE_SIZE });
    const third = await page({ offset: 2 * QUEUE_PAGE_SIZE });
    expect(first.rows).toHaveLength(50);
    expect(second.rows.map((r) => r.id)).toEqual(doc.rows.slice(50, 100).map((r) => r.id));
    expect(third.rows).toHaveLength(20);
    expect(first.total).toBe(120);

    const both = await page({ show: "no-draft", channel: "email", offset: 10 });
    expect(both.total).toBe(doc.rows.filter((r, i) => i % 3 !== 0 && i % 4 !== 0).length);
    expect(both.rows).toHaveLength(both.total! - 10);
  });

  it("reads a filtered count over a capture that hit its limit as a floor", async () => {
    fixtures.read.mockResolvedValue({ ...doc, total: 900 });
    const ready = await page({ show: "ready" });
    expect(ready.total).toBe(40);
    expect(ready.totalIsLowerBound).toBe(true);
    // Unfiltered, the server's own total stands.
    expect((await page({})).total).toBe(900);
  });
});
