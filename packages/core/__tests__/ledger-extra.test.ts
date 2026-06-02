import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-ledger-extra-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("listReceipts filters", () => {
  it("filters by playName", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "job-change", callType: "enrich.profile", costUsd: 0.2 });
    ledger.recordReceipt({ playName: "show-hn", callType: "email.find", costUsd: 0.05 });

    const only = ledger.listReceipts({ playName: "show-hn" });
    expect(only).toHaveLength(2);
    expect(only.every((r) => r.play_name === "show-hn")).toBe(true);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i++) {
      ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    }
    expect(ledger.listReceipts({ limit: 2 })).toHaveLength(2);
  });

  it("sinceIso excludes older receipts", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    // future cutoff → no receipts qualify
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(ledger.listReceipts({ sinceIso: future })).toHaveLength(0);
  });
});

describe("recordReceipt — cost handling", () => {
  // Post-SDK-0.15.2 + post-wrapper-cleanup: every wrapper in core/oneshot.ts
  // forwards `result.cost` as explicit costUsd. recordReceipt no longer
  // re-reads cost from the signedReceipt JSON (one source of truth).
  // Anything not a finite number → NULL in the column.

  it("persists an explicit numeric costUsd", () => {
    const id = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      costUsd: 0.0123,
    });
    expect(ledger.getReceipt(id)?.cost_usd).toBeCloseTo(0.0123);
  });

  it("ignores any `cost` field on signedReceipt — only explicit costUsd counts", () => {
    // Verifies the cleanup: the JSON-extract fallback path is gone.
    const id = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      signedReceipt: { cost: 0.05 },
      // no explicit costUsd
    });
    expect(ledger.getReceipt(id)?.cost_usd).toBeNull();
  });

  it("leaves cost_usd NULL when costUsd is omitted entirely", () => {
    const id = ledger.recordReceipt({ playName: "p", callType: "web.search" });
    expect(ledger.getReceipt(id)?.cost_usd).toBeNull();
  });

  it("rejects non-finite costUsd (Infinity / NaN) as NULL", () => {
    // Number.isFinite guard — undefined / Infinity / NaN never get coerced
    // into a number that distorts CAC math.
    const id1 = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      costUsd: Infinity,
    });
    const id2 = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      costUsd: Number.NaN,
    });
    expect(ledger.getReceipt(id1)?.cost_usd).toBeNull();
    expect(ledger.getReceipt(id2)?.cost_usd).toBeNull();
  });

  it("persists signedReceipt JSON for forensic queries even when costUsd is null", () => {
    const id = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      signedReceipt: { found: true, email: "x@y.dev" },
    });
    const row = ledger.getReceipt(id);
    expect(row?.cost_usd).toBeNull();
    expect(row?.signed_receipt).toContain('"email":"x@y.dev"');
  });
});

describe("totalSpendUsd", () => {
  it("sums explicit cost_usd values; NULL rows are excluded", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.25 });
    // No explicit cost AND no signedReceipt → NULL → excluded from the sum.
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send" });
    expect(ledger.totalSpendUsd()).toBeCloseTo(0.35);
  });

  it("filters by playName", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "job-change", callType: "email.send", costUsd: 0.9 });
    expect(ledger.totalSpendUsd({ playName: "show-hn" })).toBeCloseTo(0.1);
  });

  it("returns 0 when no receipts exist", () => {
    expect(ledger.totalSpendUsd()).toBe(0);
  });
});

describe("countSends", () => {
  it("counts sent/delivered/replied, skips bounced/failed/queued", () => {
    const pid = ledger.upsertProspect({ name: "A", email: "a@x.com", source: "t" });
    for (const status of ["sent", "delivered", "replied", "bounced", "queued", "failed"] as const) {
      ledger.recordSequenceEvent({
        prospectId: pid,
        playName: "show-hn",
        stepIndex: 0,
        channel: "email",
        status,
      });
    }
    expect(ledger.countSends()).toBe(3);
    expect(ledger.countSends({ playName: "show-hn" })).toBe(3);
    expect(ledger.countSends({ playName: "other" })).toBe(0);
  });
});

describe("expirePendingOlderThan", () => {
  it("flips only pending rows older than the cutoff", () => {
    // Fresh pending row — should NOT be expired.
    const freshId = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "fresh",
      source: "x",
    });

    // Approved row — should NOT be expired regardless of age.
    const approvedId = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "approved",
      source: "x",
    });
    ledger.setQueueStatus({ id: approvedId!, status: "approved" });

    // 100-day-old pending row — should be expired. Backdate via raw sql.
    const oldId = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "old",
      source: "x",
    });
    const oldIso = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE target_queue SET found_at = ? WHERE id = ?")
      .run(oldIso, oldId);

    const n = ledger.expirePendingOlderThan(30);
    expect(n).toBe(1);
    expect(ledger.getQueueRow(freshId!)?.status).toBe("pending");
    expect(ledger.getQueueRow(approvedId!)?.status).toBe("approved");
    expect(ledger.getQueueRow(oldId!)?.status).toBe("expired");
  });
});

describe("dequeueApproved atomic lease", () => {
  function enqueueApproved(dedupe: string): number {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: dedupe,
      source: "x",
    });
    ledger.setQueueStatus({ id: id!, status: "approved" });
    return id!;
  }

  it("marks claimed rows with drain_claimed_at", () => {
    const id = enqueueApproved("a");
    const rows = ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    expect(rows.map((r) => r.id)).toEqual([id]);
    const fresh = ledger.getQueueRow(id) as { drain_claimed_at: string | null } | null;
    expect(fresh?.drain_claimed_at).not.toBeNull();
  });

  it("two sequential calls return disjoint row sets (second sees first's lease)", () => {
    const idA = enqueueApproved("a");
    const idB = enqueueApproved("b");
    const idC = enqueueApproved("c");
    const first = ledger.dequeueApproved({ playName: "show-hn", limit: 2 });
    const second = ledger.dequeueApproved({ playName: "show-hn", limit: 5 });
    const firstIds = new Set(first.map((r) => r.id));
    const secondIds = new Set(second.map((r) => r.id));
    expect(firstIds.size).toBe(2);
    expect(secondIds.size).toBe(1);
    for (const id of firstIds) expect(secondIds.has(id)).toBe(false);
    expect([...firstIds, ...secondIds].toSorted((a, b) => a - b)).toEqual(
      [idA, idB, idC].toSorted((a, b) => a - b),
    );
  });

  it("an expired claim (lease elapsed) becomes re-claimable", () => {
    const id = enqueueApproved("a");
    ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    // Backdate the claim to 20 min ago — older than the 15 min default lease.
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE target_queue SET drain_claimed_at = ? WHERE id = ?")
      .run(stale, id);
    const second = ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    expect(second.map((r) => r.id)).toEqual([id]);
  });

  it("setQueueStatus({sent}) excludes the row even when drain_claimed_at is set", () => {
    const id = enqueueApproved("a");
    ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    ledger.setQueueStatus({ id, status: "sent" });
    const second = ledger.dequeueApproved({ playName: "show-hn", limit: 1, leaseSeconds: 0 });
    expect(second).toEqual([]);
  });
});

describe("cadence next-step draft round-trip", () => {
  it("set/get round-trip + advanceCadence clears it", () => {
    const pid = ledger.upsertProspect({ name: "P", email: "p@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "stack-consolidation",
      nextDueAt: new Date().toISOString(),
    });
    ledger.setCadenceDraft({
      prospectId: pid,
      playName: "stack-consolidation",
      draft: {
        subject: "follow-up",
        body: "the value angle",
        flags: [],
        payload: { kind: "email", subject: "follow-up", body: "the value angle" },
      },
    });
    const stored = ledger.getCadenceDraft({
      prospectId: pid,
      playName: "stack-consolidation",
    });
    expect(stored?.subject).toBe("follow-up");
    expect(stored?.body).toBe("the value angle");
    expect(stored?.flags).toEqual([]);
    expect(stored?.draftedAt).toBeTruthy();

    // advanceCadence atomically clears the draft (stale for the new step).
    ledger.advanceCadence({
      prospectId: pid,
      playName: "stack-consolidation",
      newStep: 1,
      nextDueAt: null,
    });
    const after = ledger.getCadenceDraft({
      prospectId: pid,
      playName: "stack-consolidation",
    });
    expect(after).toBeNull();
  });

  it("clearCadenceDraft is a no-op when no draft exists", () => {
    const pid = ledger.upsertProspect({ name: "P2", email: "p2@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    expect(() =>
      ledger.clearCadenceDraft({ prospectId: pid, playName: "show-hn" }),
    ).not.toThrow();
  });

  it("setCadenceStatus to a non-active state clears the persisted draft", () => {
    const pid = ledger.upsertProspect({ name: "P3", email: "p3@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.setCadenceDraft({
      prospectId: pid,
      playName: "show-hn",
      draft: { subject: "s", body: "b", flags: [], payload: {} },
    });
    expect(ledger.getCadenceDraft({ prospectId: pid, playName: "show-hn" })).not.toBeNull();
    ledger.setCadenceStatus({
      prospectId: pid,
      playName: "show-hn",
      status: "replied",
    });
    expect(ledger.getCadenceDraft({ prospectId: pid, playName: "show-hn" })).toBeNull();
  });
});

describe("recordInterview", () => {
  it("round-trips an interview record", () => {
    const id = ledger.recordInterview({
      person: "sam-acme.txt",
      transcript_path: "/tmp/sam-acme.txt",
      jtbd: "ship faster",
      pain_quotes_json: JSON.stringify(["we waste a day/week on ops"]),
    });
    expect(id).toBeGreaterThan(0);
  });
});

describe("countOutcomes filters", () => {
  it("filters by outcome + play", () => {
    const pid = ledger.upsertProspect({ name: "A", email: "a@x.com", source: "t" });
    ledger.recordOutcome({ prospectId: pid, playName: "show-hn", outcome: "meeting_booked" });
    ledger.recordOutcome({ prospectId: pid, playName: "show-hn", outcome: "deal_won" });
    ledger.recordOutcome({ prospectId: pid, playName: "job-change", outcome: "meeting_booked" });
    expect(ledger.countOutcomes()).toBe(3);
    expect(ledger.countOutcomes({ outcome: "meeting_booked" })).toBe(2);
    expect(ledger.countOutcomes({ playName: "show-hn" })).toBe(2);
    expect(ledger.countOutcomes({ playName: "show-hn", outcome: "deal_won" })).toBe(1);
  });
});

describe("spendByPlay with sinceIso", () => {
  it("excludes receipts older than the cutoff", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(ledger.spendByPlay({ sinceIso: future })).toEqual([]);
  });
});

describe("triggers listing", () => {
  it("listTriggers returns upserted rows sorted by name", () => {
    ledger.upsertTrigger({ name: "zeta", configJson: "{}" });
    ledger.upsertTrigger({ name: "alpha", configJson: "{}" });
    ledger.upsertTrigger({ name: "mu", configJson: "{}" });
    const names = ledger.listTriggers().map((t) => t.name);
    expect(names).toEqual(["alpha", "mu", "zeta"]);
  });

  it("upsertTrigger is idempotent: second call replaces config/enabled", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: JSON.stringify({ a: 1 }), enabled: true });
    ledger.upsertTrigger({ name: "show-hn", configJson: JSON.stringify({ a: 2 }), enabled: false });
    const t = ledger.getTrigger("show-hn");
    expect(t?.enabled).toBe(0);
    expect(JSON.parse(t!.config_json ?? "{}")).toEqual({ a: 2 });
  });
});

describe("addColumnIfMissing identifier guards", () => {
  it("rejects unsafe table names", () => {
    // The only way to reach this code path is the private method; we access it
    // via the instance to verify the guard is in place (defense-in-depth).
    const priv = ledger as unknown as {
      addColumnIfMissing(t: string, c: string, tp: string): void;
    };
    expect(() => priv.addColumnIfMissing("receipts; DROP TABLE receipts", "x", "TEXT")).toThrow(
      /unsafe identifier/,
    );
    expect(() => priv.addColumnIfMissing("receipts", "x; DROP TABLE y", "TEXT")).toThrow(
      /unsafe identifier/,
    );
    expect(() => priv.addColumnIfMissing("receipts", "x", "TEXT); DROP")).toThrow(
      /unsafe column type/,
    );
  });
});
