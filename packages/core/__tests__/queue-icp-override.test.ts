import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

// A person approving a row the finder's person gate rejected overrides that
// gate: both send-side gates refuse `reject`, so the approval would otherwise
// be skipped as off-ICP at send time.

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-icp-override-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function enqueueRejected(key: string, reason: string | null = "Account Executive"): number {
  const payload: Record<string, unknown> = {
    name: "Dana",
    email: `${key}@x.com`,
    icpVerdict: "reject",
  };
  if (reason !== null) payload["icpVerdictReason"] = reason;
  return ledger.enqueueTarget({
    playName: "luma-events",
    payload,
    dedupeKey: key,
    source: "find:luma-events",
    initialStatus: "rejected",
    notes: "auto: role — no",
  })!;
}

function payloadOf(id: number): Record<string, unknown> {
  return JSON.parse(ledger.getQueueRow(id)!.payload_json) as Record<string, unknown>;
}

describe("human approval of an ICP-rejected row", () => {
  it("rewrites the verdict to pass and keeps the machine verdict for audit", () => {
    const id = enqueueRejected("a");
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    const payload = payloadOf(id);
    expect(payload["icpVerdict"]).toBe("pass");
    expect(payload["icpVerdictReason"]).toBe("human override: Account Executive");
    expect(payload["icpOverride"]).toMatchObject({
      by: "human",
      verdict: "reject",
      reason: "Account Executive",
    });
    expect(ledger.getQueueRow(id)).toMatchObject({ status: "approved", decided_by: "human" });
  });

  it("handles a reject with no recorded reason", () => {
    const id = enqueueRejected("b", null);
    ledger.setQueueStatus({ id, status: "approved" });
    expect(payloadOf(id)["icpVerdictReason"]).toBe("human override: person gate rejected");
  });

  it("a machine approval never overrides", () => {
    const id = enqueueRejected("c");
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "machine" });
    expect(payloadOf(id)["icpVerdict"]).toBe("reject");
    expect(payloadOf(id)).not.toHaveProperty("icpOverride");
  });

  it("leaves a row the gate passed untouched", () => {
    const id = ledger.enqueueTarget({
      playName: "luma-events",
      payload: { name: "Pat", email: "pat@x.com", icpVerdict: "pass", icpVerdictReason: "founder" },
      dedupeKey: "d",
      source: "find:luma-events",
    })!;
    const before = ledger.getQueueRow(id)!.payload_json;
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    expect(ledger.getQueueRow(id)!.payload_json).toBe(before);
  });

  it("keeps notes working alongside the override", () => {
    const id = enqueueRejected("e");
    ledger.setQueueStatus({
      id,
      status: "approved",
      decidedBy: "human",
      notes: "event is on-topic",
    });
    expect(ledger.getQueueRow(id)!.notes).toBe("event is on-topic");
    expect(payloadOf(id)["icpVerdict"]).toBe("pass");
  });
});
