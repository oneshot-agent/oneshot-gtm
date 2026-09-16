import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLedgerSchema } from "../src/ledger-schema.ts";
import { ProspectStore, type ProspectMailAddress } from "../src/ledger-prospects.ts";
import type { PostalAddress } from "../src/direct-mail.ts";

/**
 * Focused coverage for the module extracted in #643 (re-filed from #632):
 * prospect CRUD, research-backlog queries, dossier merges and stored ICP
 * verdicts, moved out of `ledger.ts` into `ledger-prospects.ts`'s
 * `ProspectStore`.
 *
 * `prospect-research.test.ts` and `prospect-identity.test.ts` already
 * exercise this behavior end-to-end through the public `Ledger` API — that
 * coverage predates this extraction (#570/#355) and continues to pass
 * unchanged, which is exactly the parity signal the extraction promises.
 * What's new here is exercising `ProspectStore` DIRECTLY, against a raw
 * `Database` handle with no `Ledger` in the loop at all — mirroring the
 * precedent set by `ledger-receipts.ts`'s "is a pure function of a raw
 * Database handle" section. That is only possible once the code is its own
 * module, so it is coverage this extraction adds, not coverage it inherits.
 */

/** In-memory stand-in for Ledger's mail-address tables, matching the ProspectMailAddress contract. */
function fakeMailAddress(): ProspectMailAddress {
  const addresses = new Map<string, PostalAddress>();
  const metadata = new Map<string, Record<string, unknown>>();
  return {
    get: (key) => addresses.get(key) ?? null,
    set: (key, address, source) => {
      addresses.set(key, address);
      metadata.set(key, { source: source ?? "prospect input" });
    },
    getMetadata: (key) => metadata.get(key) ?? null,
  };
}

describe("ProspectStore is a pure function of a raw Database handle (issue #643)", () => {
  let db: Database;
  let store: ProspectStore;

  beforeEach(() => {
    db = new Database(":memory:");
    migrateLedgerSchema(db);
    store = new ProspectStore(db, fakeMailAddress());
  });

  afterEach(() => {
    db.close();
  });

  it("can be constructed and exercised standalone, without the Ledger class", () => {
    const id = store.upsertProspect({ name: "Standalone", email: "standalone@x.dev" });
    expect(store.getProspectById(id)?.name).toBe("Standalone");
    expect(store.findProspectByEmail("Standalone@X.dev")?.id).toBe(id);
  });

  it("shares the same underlying table as Ledger, so a row written via one is visible via the other", () => {
    const id = store.upsertProspect({ name: "Shared", email: "shared@x.dev" });
    const viaRaw = db.query("SELECT name FROM prospects WHERE id = ?").get(id) as {
      name: string;
    };
    expect(viaRaw.name).toBe("Shared");
  });
});

/**
 * Backlog-eligibility scoping for `listProspectsForResearch` /
 * `listProspectsForAngle`, exercised directly against `ProspectStore` with a
 * bare `Database` — no `Ledger` construction, no mail-address plumbing. Pins
 * the union-of-scopes contract and the "already researched/synthesized"
 * exclusion at the module boundary this extraction created.
 */
describe("ProspectStore backlog eligibility (issue #643 parity)", () => {
  let db: Database;
  let store: ProspectStore;

  beforeEach(() => {
    db = new Database(":memory:");
    migrateLedgerSchema(db);
    store = new ProspectStore(db, fakeMailAddress());
  });

  afterEach(() => {
    db.close();
  });

  function addProspect(email: string, extra: Record<string, unknown> = {}): number {
    return store.upsertProspect({ email, name: "Pat", source: "repo-interest", ...extra });
  }

  function enrollActive(prospectId: number): void {
    db.prepare(
      `INSERT INTO cadence_state(prospect_id, play_name, status, next_due_at)
       VALUES (?, 'repo-interest', 'active', ?)`,
    ).run(prospectId, new Date().toISOString());
  }

  function recordReply(prospectId: number): void {
    db.prepare(
      `INSERT INTO inbox_replies(id, thread_key, prospect_id, from_email, body, received_at)
       VALUES (?, 't1', ?, 'someone@x.dev', 'hi', ?)`,
    ).run(`msg-${prospectId}`, prospectId, new Date().toISOString());
  }

  it("listProspectsForResearch unions active/replied/unjudged scopes rather than intersecting them", () => {
    const unjudged = addProspect("research-a@x.dev", {
      source_profile_url: "https://github.com/a",
    });
    const active = addProspect("research-b@x.dev", { source_profile_url: "https://github.com/b" });
    store.setProspectIcpVerdict(active, "pass"); // judged, so 'unjudged' alone would miss it
    enrollActive(active);
    const noSignal = addProspect("research-c@x.dev"); // unjudged but nothing to chase

    const ids = store.listProspectsForResearch({ scopes: ["active", "unjudged"] }).map((r) => r.id);
    expect(ids.toSorted()).toEqual([unjudged, active].toSorted());
    expect(ids).not.toContain(noSignal);
  });

  it("listProspectsForResearch excludes rows that already carry person-research signal, unless includeResearched", () => {
    const done = addProspect("research-d@x.dev", {
      source_profile_url: "https://github.com/d",
      dossier_json: JSON.stringify({ person: { title: "CTO" } }),
    });
    expect(store.listProspectsForResearch({ scopes: ["unjudged"] }).map((r) => r.id)).toEqual([]);
    expect(
      store
        .listProspectsForResearch({ scopes: ["unjudged"], includeResearched: true })
        .map((r) => r.id),
    ).toEqual([done]);
  });

  it("listProspectsForAngle's 'replied' scope picks up inbox_replies but does NOT require a social URL/email (unlike listProspectsForResearch)", () => {
    const replied = store.upsertProspect({ name: "No URL", email: null, source: "reply" });
    recordReply(replied);
    expect(store.listProspectsForAngle({ scopes: ["replied"] }).map((r) => r.id)).toEqual([
      replied,
    ]);
    // The equivalent research scope requires a URL or email — this row has neither.
    expect(store.listProspectsForResearch({ scopes: ["all"] }).map((r) => r.id)).not.toContain(
      replied,
    );
  });

  it("listProspectsForAngle excludes rows that already hold an angle, unless includeSynthesized", () => {
    const done = addProspect("angle-a@x.dev", { source_profile_url: "https://github.com/a" });
    store.setProspectAngle(done, JSON.stringify({ hook: "shipped v2" }));
    expect(store.listProspectsForAngle({ scopes: ["unjudged"] }).map((r) => r.id)).toEqual([]);
    expect(
      store
        .listProspectsForAngle({ scopes: ["unjudged"], includeSynthesized: true })
        .map((r) => r.id),
    ).toEqual([done]);
  });

  it("both list* methods honour limit AFTER applying the eligibility filter, not before", () => {
    for (const e of ["limit-a@x.dev", "limit-b@x.dev", "limit-c@x.dev"]) {
      addProspect(e, { source_profile_url: `https://github.com/${e}` });
    }
    expect(store.listProspectsForResearch({ scopes: ["unjudged"], limit: 2 })).toHaveLength(2);
    expect(store.listProspectsForAngle({ scopes: ["unjudged"], limit: 2 })).toHaveLength(2);
  });
});

/**
 * `mergeProspectDossierHalf`'s core invariant — writing one half (person or
 * product) must never erase the other — exercised directly against
 * `ProspectStore`'s own transaction, with no `Ledger` involved. Complements
 * (does not replace) `prospect-research.test.ts`'s Ledger-level coverage of
 * the same behavior.
 */
describe("ProspectStore.mergeProspectDossierHalf (issue #643 parity)", () => {
  let db: Database;
  let store: ProspectStore;

  beforeEach(() => {
    db = new Database(":memory:");
    migrateLedgerSchema(db);
    store = new ProspectStore(db, fakeMailAddress());
  });

  afterEach(() => {
    db.close();
  });

  it("a person-half write does not erase a previously-written product half", () => {
    const id = store.upsertProspect({ name: "Merge Test", email: "merge-a@x.dev" });
    store.mergeProspectDossierHalf(id, "product", {
      version: 1,
      status: "partial",
      researchedAt: "2026-09-01T00:00:00.000Z",
      subject: { company: "Taxheaven" },
      sources: [],
    });
    store.mergeProspectDossierHalf(id, "person", { title: "CTO" });

    const stored = JSON.parse(store.getProspectById(id)!.dossier_json!) as {
      person: { title: string };
      product: { subject: { company: string } };
    };
    expect(stored.person.title).toBe("CTO");
    expect(stored.product.subject.company).toBe("Taxheaven");
  });

  it("a product-half write does not erase a previously-written person half (the reverse order)", () => {
    const id = store.upsertProspect({ name: "Merge Test 2", email: "merge-b@x.dev" });
    store.mergeProspectDossierHalf(id, "person", { title: "Staff Engineer" });
    store.mergeProspectDossierHalf(id, "product", {
      version: 1,
      status: "complete",
      researchedAt: "2026-09-02T00:00:00.000Z",
      subject: { company: "Acme" },
      sources: [],
    });

    const stored = JSON.parse(store.getProspectById(id)!.dossier_json!) as {
      person: { title: string };
      product: { subject: { company: string } };
    };
    expect(stored.person.title).toBe("Staff Engineer");
    expect(stored.product.subject.company).toBe("Acme");
  });

  it("re-reads the row inside its own transaction rather than trusting a value read before the call", () => {
    const id = store.upsertProspect({ name: "Race", email: "merge-c@x.dev" });
    // Simulate two independent writers landing back-to-back, each calling
    // straight into the module (no shared in-memory state between calls) —
    // the second call must still see the first call's write.
    store.mergeProspectDossierHalf(id, "product", {
      version: 1,
      status: "complete",
      researchedAt: "2026-09-03T00:00:00.000Z",
      subject: { company: "Acme" },
      sources: [],
    });
    store.mergeProspectDossierHalf(id, "person", { title: "CTO" });

    const stored = JSON.parse(store.getProspectById(id)!.dossier_json!) as {
      person: { title: string };
      product: { status: string } | null;
    };
    expect(stored.person.title).toBe("CTO");
    expect(stored.product?.status).toBe("complete");
  });

  it("is a no-op for a prospect id that does not exist", () => {
    expect(() => store.mergeProspectDossierHalf(999_999, "person", { title: "x" })).not.toThrow();
    expect(db.query("SELECT COUNT(*) as n FROM prospects").get() as { n: number }).toEqual({
      n: 0,
    });
  });
});

/**
 * Round-1 review finding: the tests above only proved sequential behavior on
 * ONE connection — a fresh read on each call, and both write orders
 * preserving the other half. That leaves the actual concurrency claim
 * ("BEGIN IMMEDIATE takes the write lock before the re-read, so no one can
 * interleave") unproven, because a single connection can never race itself.
 *
 * These tests open a SECOND real `bun:sqlite` connection to the SAME
 * on-disk file — not just a second call through the same `ProspectStore` —
 * mirroring the precedent `daily-spend.test.ts`'s "cross-connection
 * atomicity" describe block and `shared-people.test.ts` already set for
 * proving SQLite-level (not just JS-level) serialization. A `:memory:`
 * database is per-connection in `bun:sqlite`, so this needs a real file.
 */
describe("ProspectStore.mergeProspectDossierHalf — cross-connection concurrency (issue #643 round 1)", () => {
  let dir: string;
  let dbPath: string;
  let dbA: Database;
  let dbB: Database;
  let storeA: ProspectStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-prospects-lock-"));
    dbPath = join(dir, "ledger.sqlite");
    dbA = new Database(dbPath);
    dbA.exec("PRAGMA journal_mode = WAL");
    // Short on purpose: the assertions below want a fast, deterministic
    // SQLITE_BUSY rather than waiting out a production-sized timeout.
    dbA.exec("PRAGMA busy_timeout = 200");
    migrateLedgerSchema(dbA);
    storeA = new ProspectStore(dbA, fakeMailAddress());

    dbB = new Database(dbPath);
    dbB.exec("PRAGMA journal_mode = WAL");
    dbB.exec("PRAGMA busy_timeout = 200");
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a concurrent writer holding the write lock blocks mergeProspectDossierHalf instead of letting it interleave", () => {
    const id = storeA.upsertProspect({ name: "Lock Test", email: "lock-a@x.dev" });
    storeA.mergeProspectDossierHalf(id, "product", {
      version: 1,
      status: "complete",
      researchedAt: "2026-09-01T00:00:00.000Z",
      subject: { company: "Acme" },
      sources: [],
    });

    // Connection B simulates an independent writer mid-merge: it has taken
    // the write lock (BEGIN IMMEDIATE) but not committed yet — exactly the
    // "read-to-write promotion" window mergeProspectDossierHalf's own
    // BEGIN IMMEDIATE exists to close.
    dbB.exec("BEGIN IMMEDIATE");
    dbB
      .prepare("UPDATE prospects SET dossier_json = ? WHERE id = ?")
      .run(JSON.stringify({ person: { title: "In Flight" }, product: null }), id);

    // If mergeProspectDossierHalf's transaction were DEFERRED (the bug this
    // finding flags), connection A's SELECT could still slip in here, read
    // the pre-B value, and either silently interleave or fail AFTER already
    // computing a merge from stale data. With `.immediate()`, A cannot even
    // start its transaction while B holds the RESERVED lock — it fails fast,
    // proving the two writers serialize rather than race.
    expect(() => storeA.mergeProspectDossierHalf(id, "person", { title: "From A" })).toThrow(
      /locked|busy/i,
    );

    dbB.exec("COMMIT");

    // Once B releases the lock, A's merge proceeds, re-reads B's now-committed
    // state, and preserves it rather than trusting the value read before B's
    // write landed.
    storeA.mergeProspectDossierHalf(id, "person", { title: "From A" });
    const stored = JSON.parse(storeA.getProspectById(id)!.dossier_json!) as {
      person: { title: string };
      product: unknown;
    };
    expect(stored.person.title).toBe("From A");
    expect(stored.product).toBeNull(); // B's in-flight write, now committed, is what A re-read and preserved
  });

  it("two independent connections' merges of different halves both land, whichever acquires the lock first", () => {
    const id = storeA.upsertProspect({ name: "Lock Test 2", email: "lock-b@x.dev" });
    const storeB = new ProspectStore(dbB, fakeMailAddress());

    // Genuine cross-connection call, not two calls on one store: each of
    // these opens its own BEGIN IMMEDIATE on a separate `bun:sqlite` handle
    // to the same file. Run back-to-back rather than truly parallel (bun is
    // single-threaded per connection), but the lock hand-off between them is
    // enforced by SQLite itself, not by JS call ordering.
    storeA.mergeProspectDossierHalf(id, "product", {
      version: 1,
      status: "complete",
      researchedAt: "2026-09-01T00:00:00.000Z",
      subject: { company: "Acme" },
      sources: [],
    });
    storeB.mergeProspectDossierHalf(id, "person", { title: "Via B" });

    const stored = JSON.parse(storeA.getProspectById(id)!.dossier_json!) as {
      person: { title: string };
      product: { subject: { company: string } };
    };
    expect(stored.person.title).toBe("Via B");
    expect(stored.product.subject.company).toBe("Acme");
  });
});
