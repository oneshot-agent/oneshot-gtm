import { describe, expect, it, vi } from "vitest";

// GET /api/queue carries `approvedByPlay` — whole-queue approved counts per
// play — alongside the filtered `rows`. /queue's drain button reads it, so the
// contract that matters is: the counts must NOT be narrowed by the request's
// status/play filters (the button has to work from the default `pending` view).

const listQueueCalls: Array<Record<string, unknown>> = [];
let nextRows: unknown[] = [];
let configOrder: "ranked" | "newest" = "newest";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), queueReviewOrder: configOrder }),
    getLedger: () => ({
      listQueue: (args: Record<string, unknown>) => {
        listQueueCalls.push(args);
        return nextRows;
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

  it("keeps a present-but-empty ?ids= as an explicit empty pick", async () => {
    // Regression: `?ids=` used to read as absent, so the route dropped the
    // filter and returned the ordinary batch — a mangled drain-selected URL
    // would hydrate rows the founder never picked.
    for (const url of ["http://x/api/queue?ids=", "http://x/api/queue?ids=abc"]) {
      listQueueCalls.length = 0;
      await body(url);
      expect(listQueueCalls[0], url).toHaveProperty("ids", []);
    }
  });

  it("still lists normally when ?ids= is absent entirely", async () => {
    listQueueCalls.length = 0;
    await body("http://x/api/queue?status=approved");
    expect(listQueueCalls[0]).not.toHaveProperty("ids");
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

// Shadow-mode priority (issue #410): the view must carry a shape-checked
// `priority` or null — malformed stored JSON must never 500 the listing.

const VALID_PRIORITY = {
  version: "heuristic-v1",
  total: 72,
  components: {
    personFit: 90,
    accountFit: 55,
    intentStrength: 80,
    timingFreshness: 60,
    signalConfidence: 65,
    contactability: 85,
  },
  reasons: ["title: CTO"],
  finder: "post-funding",
  scoredAt: "2026-09-01T12:00:00.000Z",
};

function queueRow(priorityJson: string | null): Record<string, unknown> {
  return {
    id: 1,
    play_name: "post-funding",
    payload_json: JSON.stringify({ name: "Ada" }),
    dedupe_key: "k",
    source: "find:post-funding",
    status: "pending",
    found_at: "2026-09-01 10:00:00",
    reviewed_at: null,
    sent_at: null,
    notes: null,
    prospect_id: null,
    last_draft_json: null,
    last_drafted_at: null,
    send_started_at: null,
    priority_json: priorityJson,
  };
}

describe("listQueueRoute — priority projection", () => {
  async function priorityOf(priorityJson: string | null): Promise<unknown> {
    nextRows = [queueRow(priorityJson)];
    try {
      const out = await body("http://x/api/queue");
      return (out["rows"] as Array<Record<string, unknown>>)[0]!["priority"];
    } finally {
      nextRows = [];
    }
  }

  it("passes a valid artifact through intact", async () => {
    expect(await priorityOf(JSON.stringify(VALID_PRIORITY))).toEqual(VALID_PRIORITY);
  });

  it("reads an absent artifact as null", async () => {
    expect(await priorityOf(null)).toBeNull();
  });

  it("nulls out malformed or foreign artifacts instead of failing the listing", async () => {
    expect(await priorityOf("{not json")).toBeNull();
    expect(await priorityOf(JSON.stringify({ ...VALID_PRIORITY, version: "v2" }))).toBeNull();
    expect(await priorityOf(JSON.stringify({ ...VALID_PRIORITY, total: "72" }))).toBeNull();
    expect(
      await priorityOf(JSON.stringify({ ...VALID_PRIORITY, components: { personFit: 90 } })),
    ).toBeNull();
    expect(await priorityOf(JSON.stringify({ ...VALID_PRIORITY, reasons: "nope" }))).toBeNull();
  });

  it("rejects out-of-range and fractional scores as corruption", async () => {
    expect(await priorityOf(JSON.stringify({ ...VALID_PRIORITY, total: -1 }))).toBeNull();
    expect(await priorityOf(JSON.stringify({ ...VALID_PRIORITY, total: 72.5 }))).toBeNull();
    expect(
      await priorityOf(
        JSON.stringify({
          ...VALID_PRIORITY,
          components: { ...VALID_PRIORITY.components, personFit: 999 },
        }),
      ),
    ).toBeNull();
  });

  it("drops non-string entries from reasons", async () => {
    const got = (await priorityOf(
      JSON.stringify({ ...VALID_PRIORITY, reasons: ["ok", 42, null] }),
    )) as { reasons: string[] };
    expect(got.reasons).toEqual(["ok"]);
  });
});

// Ranked review order (Phase 2 PR-3): ranked applies ONLY to the pending
// review view, is config-defaulted, param-overridable, and echoed back.

function pendingRow(id: number, play: string, total: number | null): Record<string, unknown> {
  return {
    ...queueRow(
      total === null
        ? null
        : JSON.stringify({
            ...VALID_PRIORITY,
            total,
            components: { ...VALID_PRIORITY.components },
          }),
    ),
    id,
    play_name: play,
    dedupe_key: `k${id}`,
    found_at: `2026-09-01 10:00:${String(id).padStart(2, "0")}`,
  };
}

describe("listQueueRoute — ranked review order", () => {
  async function idsOf(url: string): Promise<{ ids: number[]; order: unknown }> {
    const out = await body(url);
    return {
      ids: (out["rows"] as Array<{ id: number }>).map((r) => r.id),
      order: out["order"],
    };
  }

  it("?order=ranked interleaves finders on the pending view and echoes the mode", async () => {
    listQueueCalls.length = 0;
    nextRows = [pendingRow(1, "aaa", 90), pendingRow(2, "aaa", 80), pendingRow(3, "zzz", 85)];
    try {
      const { ids, order } = await idsOf("http://x/api/queue?status=pending&order=ranked");
      expect(order).toBe("ranked");
      // zzz interleaves at slot 2 despite the lower (incomparable) total;
      // aaa's 80 is the bottom decile here and rotates to the exploration tail.
      expect(ids).toEqual([1, 3, 2]);
      // Ranked mode reads the wider window, not the page limit.
      expect(listQueueCalls[0]).toMatchObject({ status: "pending", limit: 1000 });
    } finally {
      nextRows = [];
    }
  });

  it("the configured default applies when no param is given", async () => {
    configOrder = "ranked";
    nextRows = [pendingRow(1, "aaa", 10), pendingRow(2, "zzz", 90)];
    try {
      const ranked = await idsOf("http://x/api/queue?status=pending");
      expect(ranked.order).toBe("ranked");
      const overridden = await idsOf("http://x/api/queue?status=pending&order=newest");
      expect(overridden.order).toBe("newest");
      expect(overridden.ids).toEqual([1, 2]);
    } finally {
      configOrder = "newest";
      nextRows = [];
    }
  });

  it("never ranks other statuses or explicit id picks", async () => {
    nextRows = [pendingRow(1, "aaa", 10), pendingRow(2, "zzz", 90)];
    try {
      const approved = await idsOf("http://x/api/queue?status=approved&order=ranked");
      expect(approved.order).toBe("newest");
      expect(approved.ids).toEqual([1, 2]);
      const picked = await idsOf("http://x/api/queue?status=pending&order=ranked&ids=1,2");
      expect(picked.order).toBe("newest");
      expect(picked.ids).toEqual([1, 2]);
    } finally {
      nextRows = [];
    }
  });
});
