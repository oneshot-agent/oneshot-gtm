import type { ProspectBrowseRow } from "@oneshot-gtm/shared-types";
import { describe, expect, it } from "vitest";
import { describeDecision } from "@oneshot-gtm/shared-types";
import {
  decisionLine,
  applyProspectFilters,
  pageSummary,
  parseProspectsSearch,
  pastEnd,
  toApiQuery,
} from "./prospects-helpers.ts";

function row(overrides: Partial<ProspectBrowseRow> & { id: number }): ProspectBrowseRow {
  return {
    playName: "show-hn",
    payload: null,
    dedupeKey: `k${overrides.id}`,
    source: "find:show-hn",
    status: "pending",
    foundAt: `2026-09-0${overrides.id} 10:00:00`,
    reviewedAt: null,
    sentAt: null,
    notes: null,
    prospectId: null,
    lastDraft: null,
    lastDraftedAt: null,
    isSending: false,
    priority: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    prospect: null,
    ...overrides,
  };
}

describe("parseProspectsSearch", () => {
  it("keeps well-formed values and drops defaults and junk", () => {
    expect(
      parseProspectsSearch({
        q: "  ada ",
        status: "rejected",
        play: "show-hn",
        decided: "machine",
        sort: "name",
        dir: "asc",
        page: "3",
      }),
    ).toEqual({
      q: "ada",
      status: "rejected",
      play: "show-hn",
      decided: "machine",
      sort: "name",
      dir: "asc",
      page: 3,
    });
    expect(
      parseProspectsSearch({
        q: " ",
        status: "bogus",
        decided: "robot",
        sort: "x",
        dir: "desc",
        page: "1",
      }),
    ).toEqual({});
    expect(parseProspectsSearch({ page: 2.7 })).toEqual({ page: 2 });
    expect(parseProspectsSearch({ page: "-4" })).toEqual({});
  });
});

describe("toApiQuery", () => {
  it("omits defaults, sorts keys and turns page into offset", () => {
    expect(toApiQuery({})).toBe("limit=50");
    expect(toApiQuery({ page: 1, dir: "desc" })).toBe("limit=50");
    expect(
      toApiQuery({ q: "ada cto", status: "rejected", page: 3, sort: "name", dir: "asc" }),
    ).toBe("dir=asc&limit=50&offset=100&q=ada+cto&sort=name&status=rejected");
  });
});

describe("pageSummary", () => {
  it("describes the visible window", () => {
    expect(pageSummary(7764, 0, 50)).toEqual({ from: 1, to: 50, page: 1, pages: 156 });
    expect(pageSummary(7764, 7750, 50)).toEqual({ from: 7751, to: 7764, page: 156, pages: 156 });
    expect(pageSummary(0, 0, 50)).toEqual({ from: 0, to: 0, page: 1, pages: 1 });
    // An offset past the end reads as the last page — never "showing 101–95".
    expect(pageSummary(10, 500, 50)).toEqual({ from: 1, to: 10, page: 1, pages: 1 });
    expect(pageSummary(95, 100, 50)).toEqual({ from: 51, to: 95, page: 2, pages: 2 });
    expect(pastEnd(95, 100)).toBe(true);
    expect(pastEnd(95, 50)).toBe(false);
    expect(pastEnd(0, 0)).toBe(false);
  });
});

describe("describeDecision", () => {
  it("names the decision and who made it", () => {
    expect(
      describeDecision({ status: "rejected", decision: "auto_reject", decidedBy: "machine" }),
    ).toBe("auto-rejected");
    expect(describeDecision({ status: "rejected", decision: "reject", decidedBy: "human" })).toBe(
      "rejected by you",
    );
    expect(
      describeDecision({ status: "approved", decision: "approve", decidedBy: "human_bulk" }),
    ).toBe("bulk-approved");
    expect(describeDecision({ status: "sent", decision: "approve", decidedBy: "human" })).toBe(
      "approved by you",
    );
    expect(describeDecision({ status: "expired", decision: null, decidedBy: null })).toBe(
      "expired",
    );
    expect(describeDecision({ status: "pending", decision: null, decidedBy: null })).toBe(
      "undecided",
    );
  });
});

describe("applyProspectFilters (demo mode)", () => {
  const rows = [
    row({
      id: 1,
      payload: {
        name: "Ada Lovelace",
        email: "ada@x.example",
        company: "Analytical",
        title: "CTO",
      },
      status: "rejected",
      decision: "auto_reject",
      decidedBy: "machine",
      decidedAt: "2026-09-01T12:00:00Z",
      notes: "auto: off-topic",
    }),
    row({
      id: 2,
      playName: "luma-events",
      payload: { founderName: "grace_h" },
      status: "approved",
      decision: "approve",
      decidedBy: "human_bulk",
      decidedAt: "2026-09-02T12:00:00Z",
      prospect: {
        id: 9,
        name: "Grace Hopper",
        email: "grace@navy.example",
        company: "US Navy",
        title: "Rear Admiral",
        icpVerdict: null,
        icpVerdictReason: null,
        hasDossier: false,
        linkedBy: "email",
      },
    }),
    row({
      id: 3,
      payload: { repoUrl: "https://github.com/octo/engine", postTitle: "Show HN: COBOL" },
      status: "sent",
    }),
  ];

  it("searches, counts before the status filter, and pages", () => {
    const out = applyProspectFilters(rows, { q: "ada cto" });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
    expect(out.total).toBe(1);
    // The linked prospect is searchable, like the server.
    expect(applyProspectFilters(rows, { q: "hopper admiral" }).rows.map((r) => r.id)).toEqual([2]);
    expect(applyProspectFilters(rows, { q: "off-topic" }).total).toBe(1);
    // Parity with the server haystack: post title, repo URL, prospect email/company.
    expect(applyProspectFilters(rows, { q: "cobol" }).rows.map((r) => r.id)).toEqual([3]);
    expect(applyProspectFilters(rows, { q: "octo/engine" }).rows.map((r) => r.id)).toEqual([3]);
    expect(applyProspectFilters(rows, { q: "navy.example" }).rows.map((r) => r.id)).toEqual([2]);
    expect(applyProspectFilters(rows, { q: "us navy" }).rows.map((r) => r.id)).toEqual([2]);
    const byStatus = applyProspectFilters(rows, { status: "sent", play: "show-hn" });
    expect(byStatus.rows.map((r) => r.id)).toEqual([3]);
    expect(byStatus.counts).toEqual({ pending: 0, approved: 0, rejected: 1, sent: 1, expired: 0 });
    expect(byStatus.plays).toEqual(["luma-events", "show-hn"]);
    expect(applyProspectFilters(rows, { page: 2 })).toMatchObject({
      rows: [],
      total: 3,
      offset: 50,
    });
  });

  it("filters by who decided", () => {
    expect(applyProspectFilters(rows, { decided: "human" }).rows.map((r) => r.id)).toEqual([2]);
    expect(applyProspectFilters(rows, { decided: "machine" }).rows.map((r) => r.id)).toEqual([1]);
    expect(applyProspectFilters(rows, { decided: "none" }).rows.map((r) => r.id)).toEqual([3]);
  });

  it("sorts the same three ways as the server", () => {
    expect(applyProspectFilters(rows, {}).rows.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(applyProspectFilters(rows, { dir: "asc" }).rows.map((r) => r.id)).toEqual([1, 2, 3]);
    // Named rows first (Ada, Grace), the URL-only row last in both directions.
    expect(applyProspectFilters(rows, { sort: "name", dir: "asc" }).rows.map((r) => r.id)).toEqual([
      1, 2, 3,
    ]);
    expect(applyProspectFilters(rows, { sort: "name" }).rows.map((r) => r.id)).toEqual([2, 1, 3]);
    // Undecided last in both directions.
    expect(applyProspectFilters(rows, { sort: "decided" }).rows.map((r) => r.id)).toEqual([
      2, 1, 3,
    ]);
    expect(
      applyProspectFilters(rows, { sort: "decided", dir: "asc" }).rows.map((r) => r.id),
    ).toEqual([1, 2, 3]);
  });
});

const ago = (iso: string): string => `on ${iso.slice(0, 10)}`;

describe("decisionLine (#601)", () => {
  it("is the decision, then when it was made", () => {
    expect(
      decisionLine(
        {
          decision: "approve",
          decidedBy: "human",
          status: "approved",
          decidedAt: "2026-09-01T10:00:00Z",
        },
        ago,
      ),
    ).toBe("approved by you on 2026-09-01");
    expect(
      decisionLine(
        {
          decision: "auto_reject",
          decidedBy: "machine",
          status: "rejected",
          decidedAt: "2026-08-20T10:00:00Z",
        },
        ago,
      ),
    ).toBe("auto-rejected on 2026-08-20");
  });
  it("is the decision alone when nothing was decided", () => {
    expect(
      decisionLine({ decision: null, decidedBy: null, status: "pending", decidedAt: null }, ago),
    ).toBe("undecided");
  });
});
