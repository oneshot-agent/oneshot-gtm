import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";

// The sequence owns its offer: `cadence_state.offer_json`, stamped at
// enrollment and changed only by `setCadenceOffer`, which lands only while
// the cadence is active and holds no send. The cadence links the queue row
// it started from (`queue_id`).

let ledger: Ledger;
const PLAY = "show-hn";
const offer = { offer: "get every renewal signed", steps: "drafts it", relevance: "weak" };
const other = { offer: "get every invoice chased", steps: "chases it" };

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => ledger.close());

function enrolled(
  opts: { offer?: Record<string, unknown>; candidates?: unknown[]; queueId?: number } = {},
): { prospectId: number; playName: string } {
  const prospectId = ledger.upsertProspect({ name: "A", email: "a@x.dev" });
  ledger.enrollCadence({
    prospectId,
    playName: PLAY,
    nextDueAt: "2026-10-25T00:00:00Z",
    ...(opts.offer
      ? { offer: { offer: opts.offer, candidates: opts.candidates ?? [], origin: "derived" } }
      : {}),
    ...(opts.queueId != null ? { queueId: opts.queueId } : {}),
  });
  return { prospectId, playName: PLAY };
}

function stored(c: { prospectId: number; playName: string }): Record<string, unknown> | null {
  const json = ledger.getCadence(c.prospectId, c.playName)?.offer_json;
  return json ? (JSON.parse(json) as Record<string, unknown>) : null;
}

describe("Ledger.enrollCadence", () => {
  it("stamps the offer and the queue row on a new cadence, and a re-enrolment keeps them", () => {
    const c = enrolled({ offer, candidates: [offer, other], queueId: 41 });
    expect(stored(c)).toEqual({ offer, candidates: [offer, other], origin: "derived" });
    expect(ledger.getCadence(c.prospectId, c.playName)?.queue_id).toBe(41);

    ledger.setCadenceStatus({ ...c, status: "completed" });
    ledger.enrollCadence({
      ...c,
      nextDueAt: "2026-11-01T00:00:00Z",
      offer: { offer: other, candidates: [], origin: "intro" },
      queueId: 99,
    });
    const again = ledger.getCadence(c.prospectId, c.playName)!;
    expect(again.status).toBe("active");
    expect(again.queue_id).toBe(41);
    expect(stored(c)).toEqual({ offer, candidates: [offer, other], origin: "derived" });
  });

  it("gives a re-enrolled cadence that had none the offer and the row", () => {
    const c = enrolled();
    expect(stored(c)).toBeNull();
    ledger.enrollCadence({
      ...c,
      nextDueAt: "2026-11-01T00:00:00Z",
      offer: { offer, candidates: [], origin: "intro" },
      queueId: 7,
    });
    expect(stored(c)).toEqual({ offer, candidates: [], origin: "intro" });
    expect(ledger.getCadence(c.prospectId, c.playName)?.queue_id).toBe(7);
  });
});

describe("Ledger.setCadenceOffer", () => {
  it("replaces the offer whole, keeping the candidates when not given", () => {
    const c = enrolled({ offer, candidates: [offer] });
    expect(ledger.setCadenceOffer({ ...c, offer: other })).toBe(true);
    expect(stored(c)).toEqual({ offer: other, candidates: [offer], origin: "derived" });
    expect(ledger.setCadenceOffer({ ...c, offer, candidates: [offer, other] })).toBe(true);
    expect(stored(c)).toEqual({ offer, candidates: [offer, other], origin: "derived" });
  });

  it("writes one onto a cadence that had none, as derived", () => {
    const c = enrolled();
    expect(ledger.setCadenceOffer({ ...c, offer })).toBe(true);
    expect(stored(c)).toEqual({ offer, candidates: [], origin: "derived" });
  });

  it("merges an approval key by key, a null deleting one, and needs a stored offer", () => {
    const c = enrolled({ offer, candidates: [offer] });
    expect(
      ledger.setCadenceOffer({
        ...c,
        offer: { weakApprovedAt: "2026-10-21T00:00:00Z", relevance: null },
        merge: true,
      }),
    ).toBe(true);
    expect(stored(c)).toEqual({
      offer: { offer: offer.offer, steps: offer.steps, weakApprovedAt: "2026-10-21T00:00:00Z" },
      candidates: [offer],
      origin: "derived",
    });
    const bare = { prospectId: ledger.upsertProspect({ email: "b@x.dev" }), playName: PLAY };
    ledger.enrollCadence({ ...bare, nextDueAt: "2026-10-25T00:00:00Z" });
    expect(ledger.setCadenceOffer({ ...bare, offer: { weakApprovedAt: "x" }, merge: true })).toBe(
      false,
    );
    expect(stored(bare)).toBeNull();
  });

  it("is a compare-and-set on the stored offer's keys", () => {
    const c = enrolled({ offer });
    const stamp = { weakApprovedAt: "now" };
    expect(
      ledger.setCadenceOffer({ ...c, offer: stamp, merge: true, expect: { offer: other.offer } }),
    ).toBe(false);
    expect(
      ledger.setCadenceOffer({ ...c, offer: stamp, merge: true, expect: { editedBy: "founder" } }),
    ).toBe(false);
    expect(
      ledger.setCadenceOffer({
        ...c,
        offer: stamp,
        merge: true,
        expect: { offer: offer.offer, relevance: "weak", editedBy: null },
      }),
    ).toBe(true);
    expect((stored(c)!["offer"] as Record<string, unknown>)["weakApprovedAt"]).toBe("now");
  });

  it("writes nothing while a send holds the cadence, or once it ended", () => {
    const c = enrolled({ offer });
    ledger.claimCadenceSendingMarker({ ...c, startedAtIso: new Date().toISOString() });
    expect(ledger.setCadenceOffer({ ...c, offer: other })).toBe(false);
    expect(stored(c)!["offer"]).toEqual(offer);
    ledger.clearCadenceSendingMarker(c);
    expect(ledger.setCadenceOffer({ ...c, offer: other })).toBe(true);

    ledger.setCadenceStatus({ ...c, status: "replied" });
    expect(ledger.setCadenceOffer({ ...c, offer })).toBe(false);
    expect(ledger.setCadenceOffer({ prospectId: 999, playName: PLAY, offer })).toBe(false);
  });

  it("refuses an expect key that is not a plain identifier", () => {
    const c = enrolled({ offer });
    expect(() =>
      ledger.setCadenceOffer({ ...c, offer, expect: { "offer') OR 1=1 --": null } }),
    ).toThrow(/unsafe offer key/);
  });
});

describe("the cadence keeps its offer and link as it moves and ends", () => {
  it("advanceCadence, setCadenceStatus and stopCadence leave offer_json and queue_id alone", () => {
    const c = enrolled({ offer, candidates: [offer], queueId: 5 });
    const before = ledger.getCadence(c.prospectId, c.playName)!.offer_json;
    ledger.advanceCadence({ ...c, newStep: 1, nextDueAt: "2026-10-28T00:00:00Z" });
    ledger.setCadenceStatus({ ...c, status: "active" });
    expect(ledger.stopCadence({ ...c, reason: "bad_timing" })).toBe(true);
    const after = ledger.getCadence(c.prospectId, c.playName)!;
    expect(after.status).toBe("stopped");
    expect(after.offer_json).toBe(before);
    expect(after.queue_id).toBe(5);
    expect(ledger.listAllCadences()[0]).toMatchObject({ offer_json: before, queue_id: 5 });
  });
});

describe("Ledger.cadenceQueueRow", () => {
  function sentRow(payload: Record<string, unknown>, source = "find:show-hn"): number {
    const id = ledger.enqueueTarget({
      playName: PLAY,
      payload,
      dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
      source,
    })!;
    ledger.setQueueStatus({ id, status: "sent" });
    return id;
  }

  it("reads the linked row, whatever its address", () => {
    const linked = sentRow({ founderEmail: "a@x.dev", signal: "launched" }, "find:linked");
    sentRow({ email: "a@x.dev" }, "find:newer");
    const c = enrolled({ queueId: linked });
    expect(ledger.cadenceQueueRow(c.prospectId, c.playName)).toEqual({
      id: linked,
      payload: { founderEmail: "a@x.dev", signal: "launched" },
      source: "find:linked",
    });
  });

  it("falls back to the newest sent row for the address when the cadence has no link", () => {
    sentRow({ email: "a@x.dev" }, "find:older");
    const newest = sentRow({ email: "A@x.dev " }, "find:newest");
    const c = enrolled();
    expect(ledger.cadenceQueueRow(c.prospectId, c.playName)).toMatchObject({
      id: newest,
      source: "find:newest",
    });
  });

  it("is null for a link to a row that is gone, and for no cadence and no row", () => {
    const c = enrolled({ queueId: 12345 });
    sentRow({ email: "a@x.dev" });
    expect(ledger.cadenceQueueRow(c.prospectId, c.playName)).toBeNull();
    const lone = ledger.upsertProspect({ email: "lone@x.dev" });
    expect(ledger.cadenceQueueRow(lone, PLAY)).toBeNull();
  });
});
