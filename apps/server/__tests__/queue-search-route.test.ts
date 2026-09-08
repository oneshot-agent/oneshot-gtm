import { describe, expect, it, vi } from "vitest";

// GET /api/queue/search backs /prospects. What matters is the translation
// from a bookmarkable URL into ledger args — junk falls back rather than 400s,
// the page size is clamped, and the facet counts never see the status filter.

const searchCalls: Array<Record<string, unknown>> = [];
const countCalls: Array<Record<string, unknown>> = [];
let nextRows: unknown[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      searchQueue: (args: Record<string, unknown>) => {
        searchCalls.push(args);
        return { rows: nextRows, total: null };
      },
      searchQueueStatusCounts: (args: Record<string, unknown>) => {
        countCalls.push(args);
        return { pending: 12, approved: 473, rejected: 7764, sent: 728, expired: 205 };
      },
      listQueuePlayNames: () => ["luma-events", "show-hn"],
    }),
  };
});

const { searchQueueRoute } = await import("../src/api/queue.ts");

async function body(url: string): Promise<Record<string, unknown>> {
  searchCalls.length = 0;
  countCalls.length = 0;
  const res = searchQueueRoute(new Request(url));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const baseRow = {
  id: 9,
  play_name: "show-hn",
  payload_json: JSON.stringify({ founderName: "grace_h", founderEmail: "g@x.example" }),
  dedupe_key: "k",
  source: "find:show-hn",
  status: "rejected",
  found_at: "2026-09-01 10:00:00",
  reviewed_at: null,
  sent_at: null,
  notes: "auto: off-topic",
  prospect_id: null,
  last_draft_json: null,
  last_drafted_at: null,
  drain_claimed_at: null,
  send_started_at: null,
  priority_json: null,
  decision: "auto_reject",
  decided_at: "2026-09-01T10:00:01.000Z",
  decided_by: "machine",
};

describe("searchQueueRoute", () => {
  it("defaults to every status, newest first, 50 per page", async () => {
    const out = await body("http://x/api/queue/search");
    expect(searchCalls[0]).toEqual({
      limit: 50,
      offset: 0,
      sort: "found_at",
      dir: "desc",
      withTotal: false,
    });
    // No COUNT(*) pass: the total is the sum of the facet counts (all statuses here).
    expect(out).toMatchObject({
      total: 12 + 473 + 7764 + 728 + 205,
      limit: 50,
      offset: 0,
      plays: ["luma-events", "show-hn"],
    });
  });

  it("maps every filter onto the ledger call", async () => {
    await body(
      "http://x/api/queue/search?q=%20github%20cto%20&status=rejected,approved&play=show-hn&decided=machine&sort=name&dir=asc&limit=25&offset=50",
    );
    expect(searchCalls[0]).toEqual({
      q: "github cto",
      statuses: ["rejected", "approved"],
      playName: "show-hn",
      decidedBy: "machine",
      sort: "name",
      dir: "asc",
      limit: 25,
      offset: 50,
      withTotal: false,
    });
  });

  it("keeps the facet counts free of the status filter but under the others", async () => {
    const out = await body(
      "http://x/api/queue/search?q=ada&status=rejected,approved&play=show-hn&decided=human",
    );
    // …and the total is the selected statuses' share of those counts.
    expect(out["total"]).toBe(7764 + 473);
    expect(countCalls[0]).toEqual({ q: "ada", playName: "show-hn", decidedBy: "human" });
    expect(countCalls[0]).not.toHaveProperty("statuses");
  });

  it("drops junk statuses, sorts and decided values instead of failing", async () => {
    await body(
      "http://x/api/queue/search?status=bogus,sent,&decided=robot&sort=price&dir=sideways",
    );
    expect(searchCalls[0]).toMatchObject({ statuses: ["sent"], sort: "found_at", dir: "desc" });
    // The junk `decided` value is dropped, not forwarded — asserted on THIS
    // request, before the next call clears `searchCalls`.
    expect(searchCalls[0]).not.toHaveProperty("decidedBy");
    // Prototype names are not sort keys.
    await body("http://x/api/queue/search?sort=toString");
    expect(searchCalls[0]).toMatchObject({ sort: "found_at" });
    // Duplicates collapse: five copies of one status is one status, and the
    // total is that status's count alone.
    const dup = await body("http://x/api/queue/search?status=sent,sent,sent,sent,sent");
    expect(searchCalls[0]).toMatchObject({ statuses: ["sent", "sent", "sent", "sent", "sent"] });
    expect(dup["total"]).toBe(728);
    // A status list made only of junk is the same as no status filter.
    await body("http://x/api/queue/search?status=bogus");
    expect(searchCalls[0]).not.toHaveProperty("statuses");
  });

  it("clamps the page size and floors the offset", async () => {
    await body("http://x/api/queue/search?limit=5000&offset=-3");
    expect(searchCalls[0]).toMatchObject({ limit: 200, offset: 0 });
    await body("http://x/api/queue/search?limit=0&offset=abc");
    expect(searchCalls[0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it("truncates an over-long query rather than scanning on a paste", async () => {
    await body(`http://x/api/queue/search?q=${"a".repeat(500)}`);
    expect(searchCalls[0]).toMatchObject({ q: "a".repeat(200) });
  });

  it("carries the decision trail and the linked prospect onto each row", async () => {
    nextRows = [
      {
        ...baseRow,
        p_id: 44,
        p_name: "Grace H",
        p_email: "grace@x.example",
        p_company: "Navy",
        p_title: "CTO",
        p_icp_verdict: "pass",
        p_icp_verdict_reason: "builds",
        p_has_dossier: 1,
        p_linked_by_email: 1,
      },
      {
        ...baseRow,
        id: 10,
        p_id: null,
        p_name: null,
        p_title: null,
        p_icp_verdict: null,
        p_icp_verdict_reason: null,
        p_has_dossier: 0,
        p_linked_by_email: 0,
      },
    ];
    const out = await body("http://x/api/queue/search");
    const rows = out["rows"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      id: 9,
      status: "rejected",
      decision: "auto_reject",
      decidedBy: "machine",
      decidedAt: "2026-09-01T10:00:01.000Z",
      notes: "auto: off-topic",
      prospect: {
        id: 44,
        name: "Grace H",
        email: "grace@x.example",
        company: "Navy",
        title: "CTO",
        icpVerdict: "pass",
        hasDossier: true,
        linkedBy: "email",
      },
    });
    expect(rows[1]).toMatchObject({ id: 10, prospect: null });
    nextRows = [];
  });
});
