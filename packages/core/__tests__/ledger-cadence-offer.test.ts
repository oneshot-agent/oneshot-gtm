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

describe("Ledger.setCadenceOfferSkip", () => {
  const skip = { why: "left the firm", inputHash: "h1", version: "v", skippedAt: "t" };

  it("keeps the writer's skip on a cadence with no offer; any offer written drops it", () => {
    const c = enrolled();
    expect(ledger.setCadenceOfferSkip({ ...c, skip })).toBe(true);
    expect(stored(c)).toEqual({ offer: null, candidates: [], origin: "derived", skip });
    const fresher = { ...skip, why: "still gone", inputHash: "h2" };
    expect(ledger.setCadenceOfferSkip({ ...c, skip: fresher })).toBe(true);
    expect(stored(c)?.["skip"]).toEqual(fresher);
    expect(ledger.setCadenceOffer({ ...c, offer })).toBe(true);
    expect(stored(c)).toEqual({ offer, candidates: [], origin: "derived" });
  });

  it("never stands beside an offer, nor lands while a send holds the cadence or once it ended", () => {
    const withOffer = enrolled({ offer });
    expect(ledger.setCadenceOfferSkip({ ...withOffer, skip })).toBe(false);
    expect(stored(withOffer)).not.toHaveProperty("skip");

    ledger.close();
    ledger = new Ledger(":memory:");
    const c = enrolled();
    ledger.claimCadenceSendingMarker({ ...c, startedAtIso: new Date().toISOString() });
    expect(ledger.setCadenceOfferSkip({ ...c, skip })).toBe(false);
    ledger.clearCadenceSendingMarker(c);
    ledger.setCadenceStatus({ ...c, status: "completed" });
    expect(ledger.setCadenceOfferSkip({ ...c, skip })).toBe(false);
    expect(stored(c)).toBeNull();
  });

  it("with `replacing`, takes the place of that derived offer and its candidates, never the intro's", () => {
    const c = enrolled({ offer, candidates: [offer, other] });
    // Bound to the offer read: another text leaves it.
    expect(ledger.setCadenceOfferSkip({ ...c, skip, replacing: other.offer })).toBe(false);
    expect(ledger.setCadenceOfferSkip({ ...c, skip, replacing: offer.offer })).toBe(true);
    expect(stored(c)).toEqual({ offer: null, candidates: [], origin: "derived", skip });

    ledger.close();
    ledger = new Ledger(":memory:");
    const intro = enrolled();
    ledger.enrollCadence({
      ...intro,
      nextDueAt: "2026-11-01T00:00:00Z",
      offer: { offer, candidates: [], origin: "intro" },
    });
    expect(ledger.setCadenceOfferSkip({ ...intro, skip, replacing: offer.offer })).toBe(false);
    expect(stored(intro)).toEqual({ offer, candidates: [], origin: "intro" });
  });

  it("a re-enrolment that brings an offer replaces a skip; one that brings none keeps it", () => {
    const c = enrolled();
    ledger.setCadenceOfferSkip({ ...c, skip });
    ledger.enrollCadence({ ...c, nextDueAt: "2026-11-01T00:00:00Z" });
    expect(stored(c)?.["skip"]).toEqual(skip);
    ledger.enrollCadence({
      ...c,
      nextDueAt: "2026-11-01T00:00:00Z",
      offer: { offer, candidates: [], origin: "intro" },
    });
    expect(stored(c)).toEqual({ offer, candidates: [], origin: "intro" });
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

describe("page reads", () => {
  function sentRow(email: string, prospectId?: number): number {
    const id = ledger.enqueueTarget({
      playName: PLAY,
      payload: { email },
      dedupeKey: `k-${email}`,
      source: "find:test",
    })!;
    ledger.setQueueStatus({ id, status: "sent" });
    if (prospectId != null) ledger.setQueueProspectId(id, prospectId);
    return id;
  }

  it("getQueueRowsByIds reads rows by id across chunks, missing ids absent", () => {
    const ids = Array.from({ length: 450 }, (_, i) => sentRow(`r${i}@x.dev`));
    const got = ledger.getQueueRowsByIds([...ids, ids[0]!, 999_999]);
    expect(got.size).toBe(450);
    expect(JSON.parse(got.get(ids[449]!)!.payload_json)).toEqual({ email: "r449@x.dev" });
    expect(got.has(999_999)).toBe(false);
    expect(ledger.getQueueRowsByIds([]).size).toBe(0);
  });

  it("cadencesForQueueRows finds each row's cadence by its link, else its prospect and play", () => {
    const a = ledger.upsertProspect({ email: "a@x.dev" });
    const b = ledger.upsertProspect({ email: "b@x.dev" });
    const rowA = sentRow("a@x.dev");
    const rowB = sentRow("b@x.dev", b);
    const rowNone = sentRow("c@x.dev");
    ledger.enrollCadence({
      prospectId: a,
      playName: PLAY,
      nextDueAt: "2026-10-25T00:00:00Z",
      queueId: rowA,
      offer: { offer, candidates: [], origin: "intro" },
    });
    ledger.enrollCadence({ prospectId: b, playName: PLAY, nextDueAt: "2026-10-25T00:00:00Z" });
    const rows = [rowA, rowB, rowNone].map((id) => ledger.getQueueRow(id)!);
    const got = ledger.cadencesForQueueRows(rows);
    expect(got.get(rowA)).toMatchObject({ prospect_id: a, status: "active", queue_id: rowA });
    expect(JSON.parse(got.get(rowA)!.offer_json!)).toMatchObject({ origin: "intro" });
    expect(got.get(rowB)).toMatchObject({ prospect_id: b, queue_id: null, offer_json: null });
    expect(got.has(rowNone)).toBe(false);
    expect(ledger.cadencesForQueueRows([]).size).toBe(0);
  });

  it("cadencesForQueueRows never gives a linked cadence to another row of the same prospect", () => {
    const a = ledger.upsertProspect({ email: "a@x.dev" });
    const older = sentRow("a@x.dev", a);
    const newer = sentRow("a@x.dev-2", a);
    ledger.enrollCadence({
      prospectId: a,
      playName: PLAY,
      nextDueAt: "2026-10-25T00:00:00Z",
      queueId: newer,
      offer: { offer, candidates: [], origin: "intro" },
    });
    const got = ledger.cadencesForQueueRows([older, newer].map((id) => ledger.getQueueRow(id)!));
    expect(got.get(newer)).toMatchObject({ queue_id: newer });
    expect(got.has(older)).toBe(false);
  });

  it("cadencesForQueueRows gives an unlinked cadence to its prospect's row only when it is the only one", () => {
    const a = ledger.upsertProspect({ email: "a@x.dev" });
    const one = sentRow("a@x.dev", a);
    const two = sentRow("a@x.dev-2", a);
    ledger.enrollCadence({ prospectId: a, playName: PLAY, nextDueAt: "2026-10-25T00:00:00Z" });
    const both = ledger.cadencesForQueueRows([one, two].map((id) => ledger.getQueueRow(id)!));
    expect(both.size).toBe(0);
    const alone = ledger.cadencesForQueueRows([ledger.getQueueRow(one)!]);
    expect(alone.get(one)).toMatchObject({ prospect_id: a, queue_id: null });
  });

  it("cadencePlansFor reads the plan of each cadence's current enrolment only", () => {
    const c = enrolled();
    const cad = ledger.getCadence(c.prospectId, c.playName)!;
    const plan = [{ id: "base:1", dayOffset: 3, channel: "email" as const, label: "breakup" }];
    ledger.saveCadencePlan(c.prospectId, PLAY, "2026-01-01T00:00:00Z", [
      { ...plan[0]!, label: "an older enrolment" },
    ]);
    expect(ledger.cadencePlansFor([cad]).size).toBe(0);
    ledger.saveCadencePlan(c.prospectId, PLAY, cad.enrolled_at, plan);
    expect(ledger.cadencePlansFor([cad]).get(`${c.prospectId}|${PLAY}`)).toEqual(plan);
    expect(ledger.cadencePlansFor([]).size).toBe(0);
  });
});
