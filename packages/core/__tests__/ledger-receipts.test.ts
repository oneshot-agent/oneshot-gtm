import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import { migrateLedgerSchema } from "../src/ledger-schema.ts";
import { ReceiptStore } from "../src/ledger-receipts.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-receipts-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("Ledger receipt methods delegate to ReceiptStore (issue #616)", () => {
  it("recordReceipt/getReceipt/listReceipts round-trip through Ledger exactly as before extraction", () => {
    const id = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      costUsd: 0.05,
      signedReceipt: { email: { id: "abc-123" } },
      oneshotRequestId: "abc-123",
      senderIdentity: "legacy-oneshot",
      memo: "custom memo",
      decisionContext: { goalId: "g-1", playName: "show-hn", callType: "email.send" },
    });
    expect(id).toBeGreaterThan(0);
    const r = ledger.getReceipt(id);
    expect(r?.play_name).toBe("show-hn");
    expect(r?.cost_usd).toBe(0.05);
    expect(r?.oneshot_request_id).toBe("abc-123");
    expect(r?.sender_identity).toBe("legacy-oneshot");
    expect(r?.memo).toBe("custom memo");
    expect(r?.goal_id).toBe("g-1");
    expect(ledger.listReceipts({ playName: "show-hn" }).map((row) => row.id)).toContain(id);
  });

  it("recordReceipt stays idempotent on a non-null oneshot_request_id after the move to ledger-receipts.ts", () => {
    const first = ledger.recordReceipt({
      playName: "inbox-reply",
      callType: "email.reply",
      costUsd: 0.01,
      oneshotRequestId: "job-xyz-616",
    });
    const replay = ledger.recordReceipt({
      playName: "inbox-reply",
      callType: "email.reply",
      costUsd: 0.01,
      oneshotRequestId: "job-xyz-616",
    });
    expect(replay).toBe(first);
    expect(ledger.countReceipts({ playName: "inbox-reply" })).toBe(1);
  });

  it("setReceiptValueTag/currentGoalValueTag/setReceiptValueTagByGoal/goalLabels delegate correctly", () => {
    const idA = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      decisionContext: { goalId: "goal-1", playName: "show-hn", prospectEmail: "a@x.dev" },
    });
    const idB = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.reply",
      decisionContext: { goalId: "goal-1", playName: "show-hn", prospectEmail: "a@x.dev" },
    });
    expect(ledger.currentGoalValueTag("goal-1")).toBeNull();
    const touched = ledger.setReceiptValueTagByGoal("goal-1", '{"type":"reply"}');
    expect(touched).toBe(2);
    expect(ledger.currentGoalValueTag("goal-1")).toBe('{"type":"reply"}');
    ledger.setReceiptValueTag(idA, '{"type":"meeting"}');
    expect(ledger.getReceipt(idA)?.value_tag).toBe('{"type":"meeting"}');
    expect(ledger.getReceipt(idB)?.value_tag).toBe('{"type":"reply"}');
    const labels = ledger.goalLabels(["goal-1", "missing-goal"]);
    expect(labels.get("goal-1")).toEqual({ playName: "show-hn", prospect: "a@x.dev" });
    expect(labels.has("missing-goal")).toBe(false);
  });

  it("spendByPlay/countReceipts/totalSpendUsd/spendSeriesByPlay/listValueTaggedReceipts delegate correctly", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "show-hn", callType: "research.deep", costUsd: 0.4 });
    ledger.recordReceipt({
      playName: "job-change",
      callType: "enrich.profile",
      costUsd: 0.2,
      decisionContext: { goalId: "goal-9" },
    });
    ledger.setReceiptValueTagByGoal("goal-9", '{"type":"qualified"}');

    const byPlay = ledger.spendByPlay();
    const showHn = byPlay.find((r) => r.play_name === "show-hn");
    expect(showHn?.calls).toBe(2);
    expect(showHn?.total_usd).toBeCloseTo(0.5);

    expect(ledger.countReceipts()).toBe(3);
    expect(ledger.countReceipts({ playName: "job-change" })).toBe(1);
    expect(ledger.totalSpendUsd()).toBeCloseTo(0.7);
    expect(ledger.totalSpendUsd({ playName: "show-hn" })).toBeCloseTo(0.5);

    const series = ledger.spendSeriesByPlay({ days: 7 });
    expect(series.some((row) => row.play_name === "show-hn")).toBe(true);

    const tagged = ledger.listValueTaggedReceipts();
    expect(tagged).toEqual([{ goal_id: "goal-9", value_tag: '{"type":"qualified"}' }]);
  });

  it("recordMailReceipt's transaction boundary is unchanged: dedupes on receipt_id and updates the signed receipt in place", () => {
    const input = { playName: "direct-mail", callType: "mail.send", costUsd: 1.2 };
    const first = ledger.recordMailReceipt("dm-receipt-1", input);
    expect(ledger.countReceipts({ playName: "direct-mail" })).toBe(1);
    // Re-recording the SAME direct-mail receipt id must not insert a second
    // receipt row — the transaction reuses the existing local_id and just
    // refreshes signed_receipt, exactly as before the extraction.
    const second = ledger.recordMailReceipt("dm-receipt-1", {
      ...input,
      signedReceipt: { stamped: true },
    });
    expect(second).toBe(first);
    expect(ledger.countReceipts({ playName: "direct-mail" })).toBe(1);
    expect(ledger.getReceipt(first)?.signed_receipt).toBe(JSON.stringify({ stamped: true }));
  });

  it("recordMailReceipt rolls back BOTH the receipts insert and the direct_mail_receipts insert when the transaction fails partway", () => {
    // Force the delegated ReceiptStore.recordReceipt call to throw AFTER
    // recordMailReceipt's db.transaction() has started, to prove the whole
    // transaction — spanning the receipts insert (now in ledger-receipts.ts)
    // and the direct_mail_receipts insert (still in ledger.ts) — rolls back
    // as one unit exactly like before the extraction, not just the
    // ledger.ts-owned half.
    const originalRecordReceipt = ledger.recordReceipt.bind(ledger);
    let calls = 0;
    ledger.recordReceipt = (input: Parameters<Ledger["recordReceipt"]>[0]) => {
      calls += 1;
      originalRecordReceipt(input);
      throw new Error("simulated failure after the receipts insert");
    };
    expect(() => ledger.recordMailReceipt("dm-rollback", { playName: "x", callType: "y" })).toThrow(
      "simulated failure after the receipts insert",
    );
    expect(calls).toBe(1);
    ledger.recordReceipt = originalRecordReceipt;
    // Neither half of the transaction may have persisted.
    expect(ledger.countReceipts({ playName: "x" })).toBe(0);
    const db = (ledger as unknown as { db: Database }).db;
    const row = db
      .query("SELECT * FROM direct_mail_receipts WHERE receipt_id = ?")
      .get("dm-rollback");
    expect(row).toBeNull();
  });
});

describe("ReceiptStore is a pure function of a raw Database handle (issue #616)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrateLedgerSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("can be constructed and exercised standalone, without the Ledger class", () => {
    const store = new ReceiptStore(db);
    const id = store.recordReceipt({ playName: "p", callType: "c", costUsd: 0.03 });
    expect(store.getReceipt(id)?.play_name).toBe("p");
    expect(store.countReceipts()).toBe(1);
    expect(store.totalSpendUsd()).toBeCloseTo(0.03);
  });

  it("shares the same underlying table as Ledger, so a row written via one is visible via the other", () => {
    const store = new ReceiptStore(db);
    const id = store.recordReceipt({ playName: "shared", callType: "c" });
    const viaRaw = db.query("SELECT play_name FROM receipts WHERE id = ?").get(id) as {
      play_name: string;
    };
    expect(viaRaw.play_name).toBe("shared");
  });
});
