import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import {
  CONTACT_TOUCH_WINDOW_MS,
  getSharedDb,
  recentTouchElsewhere,
  recordContactTouch,
  SharedDb,
} from "../src/shared-db.ts";

// ONESHOT_GTM_SHARED is pointed at a temp dir by vitest.setup.ts, so
// getSharedDb() here is isolated. Direct SharedDb instances use their own file.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-shared-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["ONESHOT_GTM_WORKSPACE"];
});

describe("SharedDb caches", () => {
  it("round-trips enrichment + failure + linkedin with the ledger's contracts", () => {
    const db = new SharedDb(join(dir, "s.sqlite"));
    db.setCachedEnrichment("a@b.dev", '{"x":1}');
    expect(db.getCachedEnrichment("a@b.dev")).toMatchObject({
      result_json: '{"x":1}',
      status: null,
    });
    db.setCachedEnrichmentFailure("a@b.dev", "boom");
    expect(db.getCachedEnrichment("a@b.dev")?.status).toBe("failed");
    // A fresh success clears the negative marker.
    db.setCachedEnrichment("a@b.dev", '{"x":2}');
    expect(db.getCachedEnrichment("a@b.dev")?.status).toBeNull();
    db.setCachedLinkedIn("k", "https://linkedin.com/in/x");
    expect(db.getCachedLinkedIn("k")).toMatchObject({ status: "hit" });
    db.setCachedLinkedIn("k2", null);
    expect(db.getCachedLinkedIn("k2")).toMatchObject({ status: "miss", url: null });
    db.close();
  });
});

describe("contact touches", () => {
  it("reports a touch by ANOTHER workspace inside the window, never its own", () => {
    const db = new SharedDb(join(dir, "s.sqlite"));
    db.recordTouch({ email: "Jane@Acme.dev", workspace: "sdk", playName: "show-hn" });
    expect(db.recentTouchElsewhere("jane@acme.dev", "gtm")).toMatchObject({
      workspace: "sdk",
      play_name: "show-hn",
    });
    // The same workspace's own touch is not "elsewhere".
    expect(db.recentTouchElsewhere("jane@acme.dev", "sdk")).toBeNull();
    db.close();
  });

  it("ignores touches older than the window", () => {
    const db = new SharedDb(join(dir, "s.sqlite"));
    const old = new Date(Date.now() - CONTACT_TOUCH_WINDOW_MS - 60_000).toISOString();
    db.recordTouch({ email: "jane@acme.dev", workspace: "sdk", playName: "show-hn", sentAt: old });
    expect(db.recentTouchElsewhere("jane@acme.dev", "gtm")).toBeNull();
    db.close();
  });

  it("returns the most recent foreign touch when several exist", () => {
    const db = new SharedDb(join(dir, "s.sqlite"));
    db.recordTouch({
      email: "jane@acme.dev",
      workspace: "sdk",
      playName: "show-hn",
      sentAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    db.recordTouch({
      email: "jane@acme.dev",
      workspace: "other",
      playName: "job-change",
      sentAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    });
    expect(db.recentTouchElsewhere("jane@acme.dev", "gtm")?.workspace).toBe("other");
    expect(db.touchesFor("jane@acme.dev")).toHaveLength(2);
    db.close();
  });

  it("module helpers attribute to the current workspace name", () => {
    process.env["ONESHOT_GTM_WORKSPACE"] = "gtm";
    recordContactTouch("x@y.dev", "show-hn");
    // Same workspace → not elsewhere.
    expect(recentTouchElsewhere("x@y.dev")).toBeNull();
    process.env["ONESHOT_GTM_WORKSPACE"] = "sdk";
    expect(recentTouchElsewhere("x@y.dev")).toMatchObject({ workspace: "gtm" });
  });
});

describe("Ledger cache delegation + legacy import", () => {
  it("Ledger cache methods read/write the shared DB", () => {
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    ledger.setCachedEnrichment("p@q.dev", '{"via":"ledger"}');
    expect(getSharedDb().getCachedEnrichment("p@q.dev")?.result_json).toBe('{"via":"ledger"}');
    expect(ledger.getCachedEnrichment("p@q.dev")?.result_json).toBe('{"via":"ledger"}');
    ledger.close();
  });

  it("copies pre-existing rows from a legacy ledger cache table once, shared rows winning", () => {
    const path = join(dir, "legacy.sqlite");
    const ledger = new Ledger(path);
    // Simulate rows written by a pre-shared-DB version: go straight to the
    // ledger's own table, bypassing the delegating methods.
    (ledger as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare(
        "INSERT INTO enrichment_cache(email, result_json, fetched_at, status) VALUES(?, ?, ?, NULL)",
      )
      .run("legacy@old.dev", '{"legacy":true}', "2026-08-01T00:00:00.000Z");
    (ledger as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare(
        "INSERT INTO linkedin_lookup_cache(query_key, url, status, fetched_at) VALUES(?, ?, ?, ?)",
      )
      .run("k-legacy", "https://linkedin.com/in/legacy", "hit", "2026-08-01T00:00:00.000Z");
    // Shared already knows a newer answer for one of them — it must win.
    getSharedDb().setCachedEnrichment("legacy@old.dev", '{"legacy":false}');

    // First cache access triggers the import.
    expect(ledger.getCachedLinkedIn("k-legacy")?.url).toBe("https://linkedin.com/in/legacy");
    expect(ledger.getCachedEnrichment("legacy@old.dev")?.result_json).toBe('{"legacy":false}');
    ledger.close();
  });
});

describe("atomic reservations (review findings on #36)", () => {
  it("claimTouch: first claim reserves, a concurrent claim from elsewhere is held", () => {
    const db = new SharedDb(join(dir, "s.sqlite"));
    const a = db.claimTouch({ email: "x@y.dev", workspace: "sdk", playName: "p1" });
    expect("reservationId" in a).toBe(true);
    // Reserved but not yet confirmed: the OTHER workspace must already see it.
    const b = db.claimTouch({ email: "x@y.dev", workspace: "gtm", playName: "p2" });
    expect("held" in b && b.held.workspace).toBe("sdk");
    expect("held" in b && b.held.status).toBe("reserved");
    db.close();
  });

  it("release makes the address claimable again; confirm turns it into a sent touch", () => {
    const db = new SharedDb(join(dir, "s.sqlite"));
    const a = db.claimTouch({ email: "x@y.dev", workspace: "sdk", playName: "p1" });
    db.releaseTouch((a as { reservationId: number }).reservationId);
    expect(db.recentTouchElsewhere("x@y.dev", "gtm")).toBeNull();
    const c = db.claimTouch({ email: "x@y.dev", workspace: "sdk", playName: "p1" });
    db.confirmTouch((c as { reservationId: number }).reservationId);
    expect(db.recentTouchElsewhere("x@y.dev", "gtm")?.status).toBe("sent");
    // release is a no-op on a confirmed row
    db.releaseTouch((c as { reservationId: number }).reservationId);
    expect(db.recentTouchElsewhere("x@y.dev", "gtm")?.status).toBe("sent");
    db.close();
  });

  it("an orphaned reservation expires after RESERVATION_TTL_MS", () => {
    const db = new SharedDb(join(dir, "s.sqlite"));
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare(
        "INSERT INTO contact_touches(email, workspace, play_name, sent_at, status) VALUES(?, ?, ?, ?, 'reserved')",
      )
      .run("x@y.dev", "sdk", "p1", stale);
    expect(db.recentTouchElsewhere("x@y.dev", "gtm")).toBeNull();
    expect(
      "reservationId" in db.claimTouch({ email: "x@y.dev", workspace: "gtm", playName: "p2" }),
    ).toBe(true);
    db.close();
  });

  it("ensureImported survives two handles racing on the same ledger", () => {
    const path = join(dir, "shared.sqlite");
    const ledger = new Ledger(join(dir, "ledger.sqlite"));
    const ledgerDb = (ledger as unknown as { db: import("bun:sqlite").Database }).db;
    const one = new SharedDb(path);
    const two = new SharedDb(path);
    expect(() => {
      one.ensureImported(ledgerDb, "/same/ledger.sqlite");
      two.ensureImported(ledgerDb, "/same/ledger.sqlite");
    }).not.toThrow();
    one.close();
    two.close();
    ledger.close();
  });
});
