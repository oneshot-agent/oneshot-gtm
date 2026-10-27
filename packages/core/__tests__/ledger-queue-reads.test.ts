import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { QueueStore } from "../src/ledger-queue.ts";
import { runLedgerMigrations } from "../src/ledger-schema.ts";

/*
 * Issue #929: the queue read path does only the work a request needs. These
 * tests assert the statements the store issues, not only its output: a plain
 * browse (no free text) never runs the per-row prospect join, and a projected
 * `listQueue` reads only the named columns. The output must not change, so
 * the plain path is compared row for row against the joined one.
 */

let db: Database;
let store: QueueStore;
let statements: string[];

beforeEach(() => {
  db = new Database(":memory:");
  runLedgerMigrations(db);
  statements = [];
  const query = db.query.bind(db);
  // Record every statement the store prepares; the reads still run for real.
  db.query = ((sql: string) => {
    statements.push(sql);
    return query(sql);
  }) as typeof db.query;
  store = new QueueStore(db);
});

afterEach(() => {
  db.close();
});

/** The join over every row's prospect, and the per-row email lookup inside it. */
const JOIN_MARK = "LEFT JOIN prospects";
const LOOKUP_MARK = "SELECT p2.id FROM prospects p2";

function enqueue(
  playName: string,
  dedupeKey: string,
  payload: unknown,
  initialStatus?: "pending" | "rejected",
): number {
  const id = store.enqueueTarget({
    playName,
    payload,
    dedupeKey,
    source: `find:${playName}`,
    ...(initialStatus ? { initialStatus } : {}),
  });
  if (id == null) throw new Error(`enqueue failed for ${dedupeKey}`);
  return id;
}

function prospect(name: string, email: string): number {
  return Number(
    db.prepare("INSERT INTO prospects (name, email) VALUES (?, ?)").run(name, email)
      .lastInsertRowid,
  );
}

describe("searchQueueStatusCounts (#929)", () => {
  it("without free text counts with a plain GROUP BY over target_queue, never the prospect join", () => {
    enqueue("show-hn", "a", { name: "A", email: "a@x.example" });
    enqueue("show-hn", "b", { name: "B" }, "rejected");
    enqueue("luma-events", "c", { name: "C" });
    statements = [];
    expect(store.searchQueueStatusCounts({})).toEqual({
      pending: 2,
      approved: 0,
      rejected: 1,
      sent: 0,
      expired: 0,
    });
    expect(store.searchQueueStatusCounts({ playName: "show-hn" })).toEqual({
      pending: 1,
      approved: 0,
      rejected: 1,
      sent: 0,
      expired: 0,
    });
    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).toMatch(/FROM target_queue\s+(WHERE play_name = \?\s+)?GROUP BY status/);
      expect(sql).not.toContain(JOIN_MARK);
      expect(sql).not.toContain(LOOKUP_MARK);
    }
  });

  it("with free text still joins the prospect, which the terms read", () => {
    prospect("Ada Lovelace", "ada@x.example");
    enqueue("show-hn", "ada", { name: "Ada", email: "ada@x.example" });
    enqueue("show-hn", "other", { name: "Other" });
    statements = [];
    expect(store.searchQueueStatusCounts({ q: "lovelace" })).toEqual({
      pending: 1,
      approved: 0,
      rejected: 0,
      sent: 0,
      expired: 0,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(JOIN_MARK);
  });
});

describe("searchQueue without free text (#929)", () => {
  it("pages target_queue alone, joins the prospect for the page's ids only, and returns the joined path's rows", () => {
    const adaProspect = prospect("Ada Lovelace", "ada@x.example");
    const ada = enqueue("show-hn", "ada", { name: "Ada", email: "Ada@x.example" });
    const graceProspect = prospect("Grace", "grace@x.example");
    const grace = enqueue("show-hn", "grace", { name: "Grace" });
    db.prepare("UPDATE target_queue SET prospect_id = ? WHERE id = ?").run(graceProspect, grace);
    const loner = enqueue("show-hn", "loner", { name: "Loner" });
    enqueue("luma-events", "other", { name: "Other" });

    statements = [];
    const plain = store.searchQueue({ playName: "show-hn", limit: 2, offset: 0 });
    // The page's ids, the page's join, the total: nothing over every row's prospect.
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/SELECT b\.id FROM target_queue b WHERE play_name = \?/);
    expect(statements[0]).not.toContain(JOIN_MARK);
    expect(statements[1]).toContain("WHERE id IN (?,?)");
    expect(statements[1]).toContain(JOIN_MARK);
    expect(statements[2]).toMatch(/SELECT COUNT\(\*\) AS n FROM target_queue WHERE play_name = \?/);
    expect(statements[2]).not.toContain(JOIN_MARK);

    // Row for row what the joined path returns: `q` = the play name matches
    // every show-hn row (the haystack carries the play) and nothing else.
    expect(plain).toEqual(store.searchQueue({ q: "show-hn", limit: 2, offset: 0 }));
    expect(plain.total).toBe(3);
    expect(plain.rows.map((r) => [r.id, r.p_id, r.p_linked_by_email])).toEqual([
      [loner, null, 0],
      [grace, graceProspect, 0],
    ]);
    const rest = store.searchQueue({ playName: "show-hn", limit: 2, offset: 2 });
    expect(rest).toEqual(store.searchQueue({ q: "show-hn", limit: 2, offset: 2 }));
    expect(rest.rows.map((r) => [r.id, r.p_id, r.p_name, r.p_linked_by_email])).toEqual([
      [ada, adaProspect, "Ada Lovelace", 1],
    ]);
  });

  it("runs no join for an empty page and no count when the total is not wanted", () => {
    enqueue("show-hn", "a", { name: "A" });
    statements = [];
    expect(
      store.searchQueue({ statuses: ["sent"], limit: 50, offset: 0, withTotal: false }),
    ).toEqual({ rows: [], total: null });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain(JOIN_MARK);
  });

  it("keeps the join for the name sort, which orders by the joined prospect's name", () => {
    enqueue("show-hn", "a", { name: "A" });
    statements = [];
    store.searchQueue({ sort: "name", limit: 1, offset: 0, withTotal: false });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(JOIN_MARK);
  });
});

describe("listQueue({ columns }) (#929)", () => {
  const RANK_COLUMNS = ["id", "play_name", "dedupe_key", "found_at", "priority_json", "event_city"];

  it("reads only the named columns, with Luma's city projected in SQL as the ranker parses it", () => {
    const sf = enqueue("luma-events", "sf", { eventCity: "San Francisco" });
    const numeric = enqueue("luma-events", "num", { eventCity: 42 });
    const noCity = enqueue("luma-events", "none", { name: "no city" });
    const malformed = enqueue("luma-events", "bad", { eventCity: "Lost" });
    db.prepare("UPDATE target_queue SET payload_json = ? WHERE id = ?").run("{not json", malformed);
    const otherPlay = enqueue("show-hn", "other", { eventCity: "Paris" });

    statements = [];
    const rows = store.listQueue({ status: "pending", columns: RANK_COLUMNS });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain("*");
    expect(statements[0]).not.toContain("last_draft_json");
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(Object.keys(row).toSorted()).toEqual(RANK_COLUMNS.toSorted());
    const city = new Map(
      rows.map((r) => [r.id, (r as unknown as { event_city: string | null }).event_city]),
    );
    expect(city.get(sf)).toBe("San Francisco");
    expect(city.get(numeric)).toBeNull();
    expect(city.get(noCity)).toBeNull();
    expect(city.get(malformed)).toBeNull();
    expect(city.get(otherPlay)).toBeNull();
  });

  it("keeps the whole row without a projection and refuses a column it does not know", () => {
    enqueue("show-hn", "a", { name: "A" });
    const [row] = store.listQueue({});
    expect(row).toHaveProperty("last_draft_json");
    expect(row).toHaveProperty("payload_json");
    expect(() =>
      store.listQueue({ columns: ["id", "payload_json; DROP TABLE target_queue"] }),
    ).toThrow(/unknown column/);
    expect(() => store.listQueue({ columns: [] })).toThrow(/at least one column/);
  });
});
