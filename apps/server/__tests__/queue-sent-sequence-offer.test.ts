import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// GET /api/queue: a SENT row that started a sequence shows the offer the
// sequence carries now (what its follow-ups restate), not the intro's copy
// on the row, read for the whole page at once. Real ledger.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  logEvent: () => {},
}));

const { listQueueRoute } = await import("../src/api/queue.ts");

const PLAY = "queue-sent-sequence-offer-play";

const offer = (text: string) => ({
  offer: text,
  steps: "plans routes, books jobs",
  evidence: [],
  stage: "established",
  level: "researched",
  version: "v",
  inputHash: "h",
  derivedAt: "2026-10-01T00:00:00Z",
});

let n = 0;
function row(
  status: "sent" | "pending",
  rowOffer = "the intro's offer",
): { id: number; email: string } {
  const email = `owner${++n}@firm.example`;
  const id = ledger.enqueueTarget({
    playName: PLAY,
    payload: { name: "Owner", email, company: "Firm", offer: offer(rowOffer) },
    dedupeKey: `k-${email}`,
    source: "find:test",
  })!;
  if (status === "sent") ledger.setQueueStatus({ id, status: "sent" });
  return { id, email };
}

function enroll(email: string, text: string, queueId?: number): number {
  const prospectId = ledger.upsertProspect({ name: "Owner", email, company: "Firm" });
  ledger.enrollCadence({
    prospectId,
    playName: PLAY,
    nextDueAt: "2026-10-25T00:00:00Z",
    ...(queueId != null ? { queueId } : {}),
    offer: { offer: offer(text), candidates: [], origin: "derived" },
  });
  return prospectId;
}

async function list(status: string): Promise<Array<Record<string, any>>> {
  const res = listQueueRoute(new Request(`http://localhost/api/queue?status=${status}`));
  return ((await res.json()) as { rows: Array<Record<string, any>> }).rows;
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

describe("a sent row's sequence offer", () => {
  it("shows the sequence's offer on the row it started, read once for the page", async () => {
    const linked = row("sent");
    enroll(linked.email, "the sequence's rewritten offer", linked.id);
    // A cadence with no link, found by the row's prospect and play.
    const byProspect = row("sent");
    const pid = enroll(byProspect.email, "the unlinked sequence's offer");
    ledger.setQueueProspectId(byProspect.id, pid);
    const alone = row("sent");

    const bulk = vi.spyOn(ledger, "cadencesForQueueRows");
    const getCadence = vi.spyOn(ledger, "getCadence");
    const rows = await list("sent");

    expect(bulk).toHaveBeenCalledTimes(1);
    expect(getCadence).not.toHaveBeenCalled();
    const of = (id: number) => rows.find((r) => r["id"] === id)!;
    expect(of(linked.id)["sequenceOffer"]).toMatchObject({
      status: "active",
      offer: { text: "the sequence's rewritten offer", introCarriedOffer: false },
    });
    // The row's own copy is untouched: the view adds the sequence's beside it.
    expect(of(linked.id)["payload"]["offer"]["offer"]).toBe("the intro's offer");
    expect(of(byProspect.id)["sequenceOffer"]).toMatchObject({
      offer: { text: "the unlinked sequence's offer" },
    });
    expect(of(alone.id)).not.toHaveProperty("sequenceOffer");
  });

  it("keeps the offer of a sequence that ended, with its status", async () => {
    const r = row("sent");
    const pid = enroll(r.email, "the offer it ran with", r.id);
    ledger.stopCadence({ prospectId: pid, playName: PLAY, reason: "not_a_fit" });
    const [view] = await list("sent");
    expect(view!["sequenceOffer"]).toMatchObject({
      status: "stopped",
      offer: { text: "the offer it ran with" },
    });
  });

  it("reads no cadences for a page with no sent rows", async () => {
    row("pending");
    const bulk = vi.spyOn(ledger, "cadencesForQueueRows");
    const [view] = await list("pending");
    expect(bulk).not.toHaveBeenCalled();
    expect(view).not.toHaveProperty("sequenceOffer");
  });
});
