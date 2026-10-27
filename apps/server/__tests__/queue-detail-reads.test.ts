import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// GET /api/queue/:id against a real ledger (issue #929): the prospect's
// delivery checks are read once for every sequence event, not once per event,
// and each check still lands on its own step; the `replied` flag is answered
// from the history the timeline already read, not from three more reads.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  logEvent: () => {},
}));

const { queueRowDetailRoute } = await import("../src/api/queue.ts");

const PLAY = "queue-detail-reads-play";

let n = 0;
/** A queue row and the prospect it resolves to by payload email. */
function rowFor(): { id: number; prospectId: number; email: string } {
  const email = `owner${++n}@firm.example`;
  const id = ledger.enqueueTarget({
    playName: PLAY,
    payload: { name: "Owner", email, company: "Firm" },
    dedupeKey: `k-${email}`,
    source: "find:test",
  })!;
  const prospectId = ledger.upsertProspect({ name: "Owner", email, company: "Firm" });
  return { id, prospectId, email };
}

function step(prospectId: number, stepIndex: number, status: "sent" | "replied" = "sent"): number {
  return ledger.recordSequenceEvent({
    prospectId,
    playName: PLAY,
    stepIndex,
    channel: "email",
    status,
  });
}

let receipt = 100;
function check(
  prospectId: number,
  sequenceEventId: number,
  status: "ok" | "duplicate" | "not_found",
  deliveredAt: string[],
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
    observed: status === "not_found" ? 0 : deliveredAt.length,
    messageIds: [],
    deliveredAt,
    checkedAt: `2026-09-02T09:10:0${receipt % 10}.000Z`,
    error: null,
  });
}

async function detail(id: number): Promise<Record<string, any>> {
  const res = queueRowDetailRoute(new Request(`http://localhost/api/queue/${id}`), {
    id: String(id),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

function deliveryNotes(body: Record<string, any>): Array<{ at: string; label: string }> {
  return (body["timeline"] as Array<{ at: string; label: string }>)
    .filter((e) => /mail provider|not found in Sent/.test(e.label))
    .map(({ at, label }) => ({ at, label }));
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

describe("GET /api/queue/:id delivery checks", () => {
  it("reads the prospect's checks once and lands each on its own step", async () => {
    const { id, prospectId } = rowFor();
    const [s0, s1, s2] = [step(prospectId, 0), step(prospectId, 1), step(prospectId, 2)];
    check(prospectId, s0, "ok", ["2026-09-02T09:00:05.000Z"]);
    check(prospectId, s1, "duplicate", ["2026-09-04T09:00:05.000Z", "2026-09-04T09:00:09.000Z"]);
    check(prospectId, s2, "not_found", []);
    const perStep = vi.spyOn(ledger.sendDelivery, "forProspectSteps");
    const perEvent = vi.spyOn(ledger.sendDelivery, "forSequenceEvent");

    const notes = deliveryNotes(await detail(id));

    expect(perStep).toHaveBeenCalledTimes(1);
    expect(perEvent).not.toHaveBeenCalled();
    // Exactly what a per-event read says for each step, dated by its own delivery.
    expect(notes.toSorted((a, b) => a.label.localeCompare(b.label))).toEqual([
      { at: "2026-09-04T09:00:09.000Z", label: "delivered 2× by the mail provider" },
      { at: expect.any(String), label: "not found in Sent" },
    ]);
  });

  it("keeps the per-event read for a play|step two events share, which the per-prospect map folds into one", async () => {
    const { id, prospectId } = rowFor();
    const first = step(prospectId, 0);
    const rerun = step(prospectId, 0);
    const other = step(prospectId, 1);
    check(prospectId, first, "ok", ["2026-09-02T09:00:05.000Z"]);
    check(prospectId, rerun, "duplicate", ["2026-09-09T09:00:05.000Z", "2026-09-09T09:00:09.000Z"]);
    check(prospectId, other, "ok", ["2026-09-04T09:00:05.000Z"]);
    // Why the fallback: the map is keyed play|step, so the two events share one
    // entry (the newest check), and nothing in it says which event it belongs to.
    const folded = ledger.sendDelivery.forProspectSteps(prospectId);
    expect([...folded.keys()]).toEqual([`${PLAY}|0`, `${PLAY}|1`]);
    expect(folded.get(`${PLAY}|0`)?.status).toBe("duplicate");
    const perStep = vi.spyOn(ledger.sendDelivery, "forProspectSteps");
    const perEvent = vi.spyOn(ledger.sendDelivery, "forSequenceEvent");

    const notes = deliveryNotes(await detail(id));

    expect(perStep).toHaveBeenCalledTimes(1);
    expect(perEvent.mock.calls.map(([eventId]) => eventId).toSorted()).toEqual([first, rerun]);
    // The duplicate is the re-run's alone: one note, not one per sharing event.
    expect(notes).toEqual([
      { at: "2026-09-09T09:00:09.000Z", label: "delivered 2× by the mail provider" },
    ]);
  });
});

describe("GET /api/queue/:id replied flag", () => {
  it("is answered from the history the timeline read, with no second read of any table", async () => {
    const { id, prospectId } = rowFor();
    // Legacy evidence only: a step whose status flipped to `replied`, which the
    // conversation view and the full history both carry.
    step(prospectId, 0, "replied");
    const replies = vi.spyOn(ledger, "listInboxRepliesForProspect");
    const channel = vi.spyOn(ledger, "listChannelEventsForProspect");
    const conversation = vi.spyOn(ledger, "listSequenceEventsForProspect");
    const history = vi.spyOn(ledger, "listAllSequenceEventsForProspect");

    const body = await detail(id);

    expect(body["flags"]).toMatchObject({ replied: true });
    expect(replies).toHaveBeenCalledTimes(1);
    expect(channel).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(1);
    expect(conversation).not.toHaveBeenCalled();
  });

  it("counts a human email reply and not an automatic one", async () => {
    const human = rowFor();
    const auto = rowFor();
    for (const [row, kind] of [
      [human, "human"],
      [auto, "auto"],
    ] as const) {
      ledger.recordInboxReply({
        id: `m-${row.prospectId}`,
        threadKey: `t-${row.prospectId}`,
        prospectId: row.prospectId,
        playName: PLAY,
        fromEmail: row.email,
        body: "thanks",
        receivedAt: "2026-09-03T12:00:00.000Z",
        kind,
      });
    }
    expect((await detail(human.id))["flags"]).toMatchObject({ replied: true });
    expect((await detail(auto.id))["flags"]).toMatchObject({ replied: false });
  });
});
