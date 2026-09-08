import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

/*
 * `searchQueue` backs the /prospects browse view: every queue row, any status,
 * searched, sorted and paged. The contracts that matter are the ones a
 * browse page silently breaks on — a stable `total` under OFFSET, no row
 * fan-out from the prospect join, and search that reads the same payload
 * keys the /queue row renders.
 */

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-search-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

function enqueue(
  playName: string,
  dedupeKey: string,
  payload: unknown,
  extra: { initialStatus?: "pending" | "rejected"; notes?: string } = {},
): number {
  const id = ledger.enqueueTarget({
    playName,
    payload,
    dedupeKey,
    source: `find:${playName}`,
    ...extra,
  });
  if (id == null) throw new Error(`enqueue failed for ${dedupeKey}`);
  return id;
}

/** Seed the shapes the real ledger holds: named, URL-only, auto-rejected, decided by hand. */
function seed(): Record<string, number> {
  const ids: Record<string, number> = {};
  ids["ada"] = enqueue("post-funding", "ada", {
    name: "Ada Lovelace",
    email: "Ada@Analytical.example",
    company: "Analytical Engines",
    title: "CTO",
  });
  ids["grace"] = enqueue("show-hn", "grace", {
    founderName: "grace_h",
    founderEmail: "grace@navy.example",
    postTitle: "Show HN: COBOL in the browser",
  });
  ids["repo"] = enqueue(
    "repo-interest",
    "repo",
    { repoUrl: "https://github.com/octo/engine_100%" },
    { initialStatus: "rejected" },
  );
  ids["linus"] = enqueue("hiring-signal", "linus", {
    name: "Linus T",
    email: "linus@kernel.example",
    company: "Kernel Co",
  });
  ledger.setQueueStatus({
    id: ids["linus"],
    status: "rejected",
    notes: "wrong industry",
    decidedBy: "human",
  });
  ids["bulk"] = enqueue("show-hn", "bulk", { name: "Bulk Approved", email: "bulk@x.example" });
  ledger.approveAllPending({ playName: "show-hn" });
  return ids;
}

describe("searchQueue", () => {
  it("returns every status by default with a total that ignores the page", () => {
    const ids = seed();
    const page = ledger.searchQueue({ limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.rows).toHaveLength(2);
    const rest = ledger.searchQueue({ limit: 2, offset: 4 });
    expect(rest.total).toBe(5);
    expect(rest.rows).toHaveLength(1);
    // Default order is newest-found first, id as the tie-break.
    expect(page.rows.map((r) => r.id)).toEqual([ids["bulk"], ids["linus"]]);
  });

  it("filters by status list, play and who decided", () => {
    const ids = seed();
    expect(ledger.searchQueue({ statuses: ["rejected"], limit: 50, offset: 0 }).total).toBe(2);
    expect(
      ledger.searchQueue({ statuses: ["rejected", "approved"], limit: 50, offset: 0 }).total,
    ).toBe(4);
    // A repeated status is one status, not "as many as there are statuses".
    expect(
      ledger.searchQueue({
        statuses: ["sent", "sent", "sent", "sent", "sent"],
        limit: 50,
        offset: 0,
      }).total,
    ).toBe(0);
    // Every status listed is the same as no status filter.
    expect(
      ledger.searchQueue({
        statuses: ["pending", "approved", "rejected", "sent", "expired"],
        limit: 50,
        offset: 0,
      }).total,
    ).toBe(5);
    expect(ledger.searchQueue({ playName: "show-hn", limit: 50, offset: 0 }).total).toBe(2);
    // `human` groups per-row and bulk decisions; `machine` is the auto-reject; `none` undecided.
    const human = ledger.searchQueue({ decidedBy: "human", limit: 50, offset: 0 });
    expect(human.rows.map((r) => r.id).toSorted()).toEqual(
      [ids["linus"], ids["bulk"], ids["grace"]].toSorted(),
    );
    expect(ledger.searchQueue({ decidedBy: "machine", limit: 50, offset: 0 }).rows).toEqual([
      expect.objectContaining({ id: ids["repo"] }),
    ]);
    expect(ledger.searchQueue({ decidedBy: "none", limit: 50, offset: 0 }).rows).toEqual([
      expect.objectContaining({ id: ids["ada"] }),
    ]);
  });

  it("matches the payload identity keys, notes and play, case-insensitively", () => {
    const ids = seed();
    const hits = (q: string): number[] =>
      ledger
        .searchQueue({ q, limit: 50, offset: 0 })
        .rows.map((r) => r.id)
        .toSorted();
    expect(hits("lovelace")).toEqual([ids["ada"]]); // name
    expect(hits("GRACE_H")).toEqual([ids["grace"]]); // founderName
    expect(hits("navy.example")).toEqual([ids["grace"]]); // founderEmail
    expect(hits("kernel co")).toEqual([ids["linus"]]); // company, two terms AND-ed
    expect(hits("cobol")).toEqual([ids["grace"]]); // postTitle
    expect(hits("octo/engine")).toEqual([ids["repo"]]); // repoUrl on a URL-only reject
    expect(hits("wrong industry")).toEqual([ids["linus"]]); // reviewer notes
    expect(hits("hiring-signal")).toEqual([ids["linus"]]); // play name
    expect(hits("nobody-here")).toEqual([]);
  });

  it("treats LIKE wildcards in a term literally", () => {
    const ids = seed();
    expect(ledger.searchQueue({ q: "100%", limit: 50, offset: 0 }).rows.map((r) => r.id)).toEqual([
      ids["repo"],
    ]);
    // `_` is a single-char wildcard in LIKE; escaped, it must not match "a".
    expect(ledger.searchQueue({ q: "engine_", limit: 50, offset: 0 }).total).toBe(1);
    expect(ledger.searchQueue({ q: "engine_z", limit: 50, offset: 0 }).total).toBe(0);
  });

  it("AND-s terms, so every term has to hit the same row", () => {
    seed();
    expect(ledger.searchQueue({ q: "ada kernel", limit: 50, offset: 0 }).total).toBe(0);
    expect(ledger.searchQueue({ q: "ada cto", limit: 50, offset: 0 }).total).toBe(1);
  });

  it("sorts by name with URL-only rows after named ones, and by decision time with undecided last", () => {
    const ids = seed();
    const byName = ledger.searchQueue({ sort: "name", dir: "asc", limit: 50, offset: 0 });
    expect(byName.rows.map((r) => r.id)).toEqual([
      ids["ada"], // Ada Lovelace
      ids["bulk"], // Bulk Approved
      ids["grace"], // grace_h (founderName fallback)
      ids["linus"], // Linus T
      ids["repo"], // URL-only, sorts last
    ]);
    const byNameDesc = ledger.searchQueue({ sort: "name", dir: "desc", limit: 50, offset: 0 });
    expect(byNameDesc.rows.at(-1)?.id).toBe(ids["repo"]);

    for (const dir of ["asc", "desc"] as const) {
      const decided = ledger.searchQueue({ sort: "decided_at", dir, limit: 50, offset: 0 });
      expect(decided.rows.at(-1)?.id).toBe(ids["ada"]); // the only undecided row
    }
  });

  it("links a prospect by prospect_id, else by payload email, without duplicating rows", () => {
    const ids = seed();
    // Two prospects can never share an email (unique index), but the fallback
    // must still be a scalar lookup: one queue row in, one row out.
    const adaId = ledger.upsertProspect({
      name: "Ada L.",
      email: "ada@analytical.example",
      title: "Chief Engineer",
      icp_verdict: "pass",
      icp_verdict_reason: "builds the thing",
      dossier_json: JSON.stringify({ person: { summary: "x" } }),
      source: "post-funding",
    });
    ledger.setProspectIcpVerdict(adaId, "pass", "builds the thing");
    const linusId = ledger.upsertProspect({
      name: "Linus",
      email: "linus@kernel.example",
      source: "hiring-signal",
    });
    ledger.setQueueProspectId(ids["linus"]!, linusId);

    const rows = ledger.searchQueue({ limit: 50, offset: 0 });
    expect(rows.total).toBe(5);
    const ada = rows.rows.find((r) => r.id === ids["ada"]);
    expect(ada).toMatchObject({
      p_id: adaId,
      p_name: "Ada L.",
      p_title: "Chief Engineer",
      p_icp_verdict: "pass",
      p_has_dossier: 1,
      p_linked_by_email: 1,
    });
    const linus = rows.rows.find((r) => r.id === ids["linus"]);
    expect(linus).toMatchObject({ p_id: linusId, p_linked_by_email: 0, p_has_dossier: 0 });
    // The joined prospect is searchable too.
    expect(ledger.searchQueue({ q: "chief engineer", limit: 50, offset: 0 }).total).toBe(1);
    // A row with no prospect carries nulls, not a phantom join.
    const grace = rows.rows.find((r) => r.id === ids["grace"]);
    expect(grace).toMatchObject({ p_id: null, p_linked_by_email: 0 });
  });

  it("finds non-ASCII names in any case, without ICU", () => {
    // bun's SQLite folds ASCII only: LOWER('É') is 'É' and 'É' LIKE 'é' is false,
    // so a lowercased term alone would never find an accented capital.
    enqueue("post-funding", "emile", { name: "Émile Durand", email: "e@d.example" });
    for (const q of ["émile", "ÉMILE", "Émile", "durand émile"]) {
      expect(ledger.searchQueue({ q, limit: 50, offset: 0 }).total, q).toBe(1);
    }
    expect(ledger.searchQueue({ q: "émilie", limit: 50, offset: 0 }).total).toBe(0);
  });

  it("carries the linked prospect's email and company, and can skip the count", () => {
    const ids = seed();
    ledger.upsertProspect({
      name: "Ada L.",
      email: "ada@analytical.example",
      company: "Analytical Engines Ltd",
      source: "post-funding",
    });
    const { rows, total } = ledger.searchQueue({
      q: "ada",
      limit: 50,
      offset: 0,
      withTotal: false,
    });
    expect(total).toBeNull();
    expect(rows.find((r) => r.id === ids["ada"])).toMatchObject({
      p_email: "ada@analytical.example",
      p_company: "Analytical Engines Ltd",
    });
    // The prospect's company is part of the haystack.
    expect(ledger.searchQueue({ q: "engines ltd", limit: 50, offset: 0 }).total).toBe(1);
  });

  it("clamps limit and offset defensively", () => {
    seed();
    expect(ledger.searchQueue({ limit: 0, offset: -5 }).rows).toHaveLength(1);
    expect(ledger.searchQueue({ limit: 10_000, offset: 0 }).rows).toHaveLength(5);
  });
});

describe("searchQueueStatusCounts", () => {
  it("counts every status under the search/play/decided filters, ignoring the status filter", () => {
    seed();
    expect(ledger.searchQueueStatusCounts({})).toEqual({
      pending: 1,
      approved: 2,
      rejected: 2,
      sent: 0,
      expired: 0,
    });
    expect(ledger.searchQueueStatusCounts({ playName: "show-hn" })).toMatchObject({
      approved: 2,
      rejected: 0,
    });
    expect(ledger.searchQueueStatusCounts({ q: "kernel" })).toMatchObject({
      rejected: 1,
      approved: 0,
      pending: 0,
    });
    expect(ledger.searchQueueStatusCounts({ decidedBy: "machine" })).toMatchObject({
      rejected: 1,
      approved: 0,
    });
  });
});

describe("per-prospect detail getters", () => {
  it("lists play names, channel events and deal outcomes in stable order", () => {
    seed();
    expect(ledger.listQueuePlayNames()).toEqual([
      "hiring-signal",
      "post-funding",
      "repo-interest",
      "show-hn",
    ]);
    const pid = ledger.upsertProspect({ name: "P", email: "p@x.example", source: "t" });
    ledger.recordLinkedInReply({
      prospectId: pid,
      source: "expandi",
      externalEventId: "b",
      occurredAt: "2026-02-02T00:00:00Z",
      body: "later",
    });
    ledger.recordLinkedInReply({
      prospectId: pid,
      source: "expandi",
      externalEventId: "a",
      occurredAt: "2026-01-01T00:00:00Z",
      body: "earlier",
    });
    expect(ledger.listChannelEventsForProspect(pid).map((e) => e.body)).toEqual([
      "earlier",
      "later",
    ]);
    expect(ledger.listChannelEventsForProspect(pid + 1)).toEqual([]);
    // The history getter keeps bounced/failed steps the conversation getter drops.
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 1,
      channel: "email",
      status: "bounced",
    });
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 2,
      channel: "email",
      status: "queued",
    });
    expect(ledger.listSequenceEventsForProspect(pid).map((e) => e.status)).toEqual(["sent"]);
    expect(ledger.listAllSequenceEventsForProspect(pid).map((e) => e.status)).toEqual([
      "sent",
      "bounced",
    ]);
    ledger.recordOutcome({ prospectId: pid, outcome: "meeting_booked", playName: "show-hn" });
    ledger.recordOutcome({ prospectId: pid, outcome: "deal_won", amountUsd: 1200 });
    expect(ledger.listDealOutcomesForProspect(pid).map((o) => [o.outcome, o.amount_usd])).toEqual([
      ["meeting_booked", null],
      ["deal_won", 1200],
    ]);
  });
});
