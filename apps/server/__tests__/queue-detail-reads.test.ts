import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// GET /api/queue/:id and POST /api/queue/:id/approve against a real ledger
// (issue #929): the delivery checks of every sequence event are read once,
// not once per event, and each check still lands on its own event; the
// detail's `replied` flag is answered from the history the timeline already
// read, and the approve guard's from one existence probe, not three
// collections read in full.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  logEvent: () => {},
}));

const { approveQueueRoute, queueRowDetailRoute } = await import("../src/api/queue.ts");

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
  it("reads every event's check in one read and lands each on its own step", async () => {
    const { id, prospectId } = rowFor();
    const [s0, s1, s2] = [step(prospectId, 0), step(prospectId, 1), step(prospectId, 2)];
    check(prospectId, s0, "ok", ["2026-09-02T09:00:05.000Z"]);
    check(prospectId, s1, "duplicate", ["2026-09-04T09:00:05.000Z", "2026-09-04T09:00:09.000Z"]);
    check(prospectId, s2, "not_found", []);
    const batched = vi.spyOn(ledger.sendDelivery, "forSequenceEvents");
    const perEvent = vi.spyOn(ledger.sendDelivery, "forSequenceEvent");
    const perStep = vi.spyOn(ledger.sendDelivery, "forProspectSteps");

    const notes = deliveryNotes(await detail(id));

    expect(batched).toHaveBeenCalledTimes(1);
    expect(batched.mock.calls[0]?.[0]?.toSorted()).toEqual([s0, s1, s2]);
    expect(perEvent).not.toHaveBeenCalled();
    expect(perStep).not.toHaveBeenCalled();
    // Exactly what a per-event read says for each step, dated by its own delivery.
    expect(notes.toSorted((a, b) => a.label.localeCompare(b.label))).toEqual([
      { at: "2026-09-04T09:00:09.000Z", label: "delivered 2× by the mail provider" },
      { at: expect.any(String), label: "not found in Sent" },
    ]);
  });

  it("gives each of two events on one play|step its own check, in the same one read", async () => {
    const { id, prospectId } = rowFor();
    const first = step(prospectId, 0);
    const rerun = step(prospectId, 0);
    const other = step(prospectId, 1);
    check(prospectId, first, "ok", ["2026-09-02T09:00:05.000Z"]);
    check(prospectId, rerun, "duplicate", ["2026-09-09T09:00:05.000Z", "2026-09-09T09:00:09.000Z"]);
    check(prospectId, other, "ok", ["2026-09-04T09:00:05.000Z"]);
    // What a play|step-keyed read would lose: the two events share one entry.
    const folded = ledger.sendDelivery.forProspectSteps(prospectId);
    expect([...folded.keys()]).toEqual([`${PLAY}|0`, `${PLAY}|1`]);
    const batched = vi.spyOn(ledger.sendDelivery, "forSequenceEvents");
    const perEvent = vi.spyOn(ledger.sendDelivery, "forSequenceEvent");

    const notes = deliveryNotes(await detail(id));

    expect(batched).toHaveBeenCalledTimes(1);
    expect(perEvent).not.toHaveBeenCalled();
    // The read answers per event id, as a per-event read did for each.
    const byEvent = batched.mock.results[0]!.value as Map<number, { status: string }>;
    expect([first, rerun, other].map((e) => byEvent.get(e)?.status)).toEqual([
      "ok",
      "duplicate",
      "ok",
    ]);
    // The duplicate is the re-run's alone: one note, not one per sharing event.
    expect(notes).toEqual([
      { at: "2026-09-09T09:00:09.000Z", label: "delivered 2× by the mail provider" },
    ]);
  });
});

describe("POST /api/queue/:id/approve replied guard", () => {
  async function approve(id: number): Promise<Response> {
    return approveQueueRoute(
      new Request(`http://localhost/api/queue/${id}/approve`, { method: "POST" }),
      { id: String(id) },
    );
  }

  it("probes the ledger once and never reads the three collections", async () => {
    const { id, prospectId } = rowFor();
    ledger.setQueueStatus({ id, status: "expired" });
    step(prospectId, 0, "replied");
    const probe = vi.spyOn(ledger, "prospectHasReplied");
    const replies = vi.spyOn(ledger, "listInboxRepliesForProspect");
    const channel = vi.spyOn(ledger, "listChannelEventsForProspect");
    const conversation = vi.spyOn(ledger, "listSequenceEventsForProspect");

    const res = await approve(id);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/replied/);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(prospectId);
    expect(replies).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();
    expect(ledger.getQueueRow(id)?.status).toBe("expired");
  });

  it("refuses on a human email reply, approves past an automatic one", async () => {
    const human = rowFor();
    const auto = rowFor();
    for (const [row, kind] of [
      [human, "human"],
      [auto, "auto"],
    ] as const) {
      ledger.setQueueStatus({ id: row.id, status: "expired" });
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
    expect((await approve(human.id)).status).toBe(409);
    expect((await approve(auto.id)).status).toBe(200);
    expect(ledger.getQueueRow(auto.id)?.status).toBe("approved");
  });

  it("refuses on a LinkedIn reply, approves a prospect with no answer on any channel", async () => {
    const linkedin = rowFor();
    const quiet = rowFor();
    ledger.setQueueStatus({ id: linkedin.id, status: "rejected" });
    ledger.setQueueStatus({ id: quiet.id, status: "rejected" });
    ledger.recordLinkedInReply({
      prospectId: linkedin.prospectId,
      source: "linkedin",
      externalEventId: `e-${linkedin.prospectId}`,
      occurredAt: "2026-09-03T12:00:00.000Z",
    });
    expect((await approve(linkedin.id)).status).toBe(409);
    expect((await approve(quiet.id)).status).toBe(200);
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
