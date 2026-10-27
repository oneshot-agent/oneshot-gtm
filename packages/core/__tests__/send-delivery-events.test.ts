import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";

/*
 * Issue #929: `SendDeliveryStore.forSequenceEvents` answers, in one read,
 * what `forSequenceEvent` answers for each event: the newest check per event
 * id, nothing for an event without one, each of two events on the same
 * play|step keeping its own.
 */

let ledger: Ledger;
const PLAY = "delivery-events-play";

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => {
  ledger.close();
});

function step(prospectId: number, stepIndex: number): number {
  return ledger.recordSequenceEvent({
    prospectId,
    playName: PLAY,
    stepIndex,
    channel: "email",
    status: "sent",
  });
}

let receipt = 500;
function check(
  prospectId: number,
  sequenceEventId: number,
  status: "ok" | "duplicate" | "not_found",
  checkedAt: string,
): void {
  ledger.sendDelivery.record({
    candidate: {
      receiptId: ++receipt,
      sequenceEventId,
      queueId: null,
      prospectId,
      transport: "gmail",
      identity: "me@x.example",
      recipient: "owner@firm.example",
      subject: "quick one",
      sentAt: "2026-09-02T09:00:00.000Z",
    },
    status,
    expected: 1,
    observed: status === "not_found" ? 0 : status === "duplicate" ? 2 : 1,
    messageIds: [],
    deliveredAt: status === "not_found" ? [] : ["2026-09-02T09:00:05.000Z"],
    checkedAt,
    error: null,
  });
}

describe("SendDeliveryStore.forSequenceEvents (#929)", () => {
  it("answers per event what forSequenceEvent answers, including two events on one play|step", () => {
    const prospectId = ledger.upsertProspect({
      name: "Owner",
      email: "owner@firm.example",
      company: "Firm",
    });
    const first = step(prospectId, 0);
    const rerun = step(prospectId, 0);
    const unchecked = step(prospectId, 1);
    const rechecked = step(prospectId, 2);
    check(prospectId, first, "ok", "2026-09-02T09:10:00.000Z");
    check(prospectId, rerun, "duplicate", "2026-09-09T09:10:00.000Z");
    check(prospectId, rechecked, "not_found", "2026-09-04T09:10:00.000Z");
    check(prospectId, rechecked, "ok", "2026-09-04T09:20:00.000Z");

    const ids = [first, rerun, unchecked, rechecked, 999_999];
    const batched = ledger.sendDelivery.forSequenceEvents(ids);

    expect([...batched.keys()].toSorted()).toEqual([first, rerun, rechecked].toSorted());
    for (const id of ids) {
      expect(batched.get(id) ?? null).toEqual(ledger.sendDelivery.forSequenceEvent(id));
    }
    expect(batched.get(first)?.status).toBe("ok");
    expect(batched.get(rerun)?.status).toBe("duplicate");
    // The newest check wins for an event checked twice.
    expect(batched.get(rechecked)?.status).toBe("ok");
  });

  it("reads nothing for no ids and ignores a non-integer id", () => {
    expect(ledger.sendDelivery.forSequenceEvents([])).toEqual(new Map());
    expect(ledger.sendDelivery.forSequenceEvents([Number.NaN, 1.5])).toEqual(new Map());
  });
});
