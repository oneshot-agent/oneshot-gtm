import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../../core/src/ledger.ts";

/**
 * The finder reads from getLedger() (the singleton) but we can't swap that
 * out from a test. Instead, exercise the ledger-side contract the finder
 * depends on: listColdProspects + enqueueTarget dedupe + setQueueProspectId.
 * The full finder is tested in situ during dogfood runs.
 */
let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-breakup-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("breakup-revive finder contract", () => {
  it("enqueueTarget + setQueueProspectId link a queue row back to the prospect", () => {
    const pid = ledger.upsertProspect({ name: "Cold Lead", email: "cold@x.com", source: "old" });

    const qid = ledger.enqueueTarget({
      playName: "breakup-revive",
      payload: { name: "Cold Lead", email: "cold@x.com", company: null, daysCold: 75 },
      dedupeKey: `prospect:${pid}`,
      source: "find:breakup-revive",
      notes: "75d cold",
    });
    expect(qid).not.toBeNull();
    ledger.setQueueProspectId(qid!, pid);
    const row = ledger.getQueueRow(qid!);
    expect(row?.prospect_id).toBe(pid);
  });

  it("re-enqueuing the same prospect hits the (play, dedupe_key) unique index", () => {
    const pid = ledger.upsertProspect({ name: "x", email: "x@y.com", source: "t" });
    const first = ledger.enqueueTarget({
      playName: "breakup-revive",
      payload: {},
      dedupeKey: `prospect:${pid}`,
      source: "find:breakup-revive",
    });
    const second = ledger.enqueueTarget({
      playName: "breakup-revive",
      payload: {},
      dedupeKey: `prospect:${pid}`,
      source: "find:breakup-revive",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
