import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

// A phone lookup writes two payload keys and nothing else, on approved or
// sent rows only, never under a send or a live drain lease. A number found
// after the send also fills the prospect's empty phone.

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-queue-phone-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});
afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

function enqueue(payload: Record<string, unknown>, status: "pending" | "approved" = "approved") {
  const id = ledger.enqueueTarget({
    playName: "show-hn",
    payload,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:show-hn",
  })!;
  if (status === "approved") ledger.setQueueStatus({ id, status: "approved" });
  return id;
}

const payloadOf = (id: number) =>
  JSON.parse(ledger.getQueueRow(id)!.payload_json) as Record<string, unknown>;
const done = { status: "done" as const, at: "2026-11-17T10:00:00.000Z", costUsd: 0.1 };

describe("Ledger.setQueuePhoneLookup", () => {
  it("sets phone and phoneLookup and leaves every other key as it was", () => {
    const payload = { name: "Pat", email: "pat@acme.example", nested: { a: [1, 2] }, n: 3 };
    const id = enqueue(payload);
    const draftBefore = ledger.getQueueRow(id)!.last_draft_json;
    expect(ledger.setQueuePhoneLookup(id, { phone: " +15550100 ", lookup: done })).toBe("written");
    expect(payloadOf(id)).toEqual({ ...payload, phone: "+15550100", phoneLookup: done });
    expect(ledger.getQueueRow(id)!.last_draft_json).toBe(draftBefore);
  });

  it("writes only the lookup when there is no number, keeping a number already there", () => {
    const id = enqueue({ name: "Pat", phone: "+15550111" });
    const none = { status: "none" as const, at: "2026-11-17T10:00:00.000Z" };
    expect(ledger.setQueuePhoneLookup(id, { phone: null, lookup: none })).toBe("written");
    expect(payloadOf(id)).toEqual({ name: "Pat", phone: "+15550111", phoneLookup: none });
  });

  it("refuses a row mid-send or under a live drain lease, and a pending row", () => {
    const sending = enqueue({ name: "S" });
    ledger.claimQueueSendingMarker({ id: sending, startedAtIso: new Date().toISOString() });
    expect(ledger.setQueuePhoneLookup(sending, { phone: "+1", lookup: done })).toBe("busy");
    expect(payloadOf(sending)["phone"]).toBeUndefined();

    const claimed = enqueue({ name: "D" });
    expect(ledger.dequeueApproved({ playName: "show-hn" }).map((r) => r.id)).toContain(claimed);
    expect(ledger.setQueuePhoneLookup(claimed, { phone: "+1", lookup: done })).toBe("busy");
    expect(payloadOf(claimed)["phoneLookup"]).toBeUndefined();

    const pending = enqueue({ name: "P" }, "pending");
    expect(ledger.setQueuePhoneLookup(pending, { phone: "+1", lookup: done })).toBe("gone");
    expect(ledger.setQueuePhoneLookup(999_999, { phone: "+1", lookup: done })).toBe("gone");
  });

  it("takes the lookup off with null, leaving the number", () => {
    const id = enqueue({ name: "Pat", phone: "+15550111" });
    ledger.setQueuePhoneLookup(id, {
      lookup: { status: "running", at: "2026-11-17T10:00:00.000Z" },
    });
    expect(ledger.setQueuePhoneLookup(id, { lookup: null })).toBe("written");
    expect(payloadOf(id)).toEqual({ name: "Pat", phone: "+15550111" });
  });

  it("writes a sent row and fills its prospect's empty phone", () => {
    const id = enqueue({ name: "Pat", email: "pat@acme.example" });
    const prospectId = ledger.upsertProspect({ email: "pat@acme.example", name: "Pat" });
    ledger.setQueueProspectId(id, prospectId);
    ledger.setQueueStatus({ id, status: "sent" });
    expect(ledger.setQueuePhoneLookup(id, { phone: "+15550100", lookup: done })).toBe("written");
    expect(payloadOf(id)["phone"]).toBe("+15550100");
    expect(ledger.getProspectById(prospectId)?.phone).toBe("+15550100");
  });
});
