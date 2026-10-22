import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// GET /api/cadences builds every row from reads made once for the page: the
// offer from the listed row (`offer_json`), the intro payloads by `queue_id`
// in one read, the saved plans in one read. No row re-reads its cadence,
// its plan, its offer record or its queue row. Real ledger, spied.

let ledger: Ledger;
const cfg = { productBrief: "Acme books crews into open slots.", cadenceOverrides: null };

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  loadConfig: () => cfg,
  logEvent: () => {},
  recentTouchElsewhere: () => null,
}));

const offerRecordCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    sequenceOfferRecord: (input: Parameters<typeof actual.sequenceOfferRecord>[0]) => {
      offerRecordCalls.n++;
      return actual.sequenceOfferRecord(input);
    },
  };
});

const { registerSequence, buildFollowUpEmail } = await import("@oneshot-gtm/plays");
const { listCadences } = await import("../src/api/cadences.ts");

const PLAY = "cadences-list-reads-play";
const step = (label: string) => ({
  dayOffset: 3,
  channel: "email" as const,
  breakOnReply: true,
  label,
  builder: buildFollowUpEmail({ playName: PLAY, promptName: "x", contextLines: [] }),
});
registerSequence({ playName: PLAY, steps: [step("value follow-up"), step("breakup")] });

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

/**
 * An active cadence with an offer, a saved plan of one step (the breakup
 * only, unlike the registered two) and a sent intro row: linked by
 * `queue_id`, or (`linked: false`) found only by its address.
 */
function cadence(i: number, linked = true): number {
  const email = `owner${i}@firm${i}.example`;
  const id = ledger.upsertProspect({ name: `Owner ${i}`, email, company: `Firm ${i}` });
  const rowId = ledger.enqueueTarget({
    playName: PLAY,
    payload: { name: `Owner ${i}`, email, company: `Firm ${i}`, signal: `signal ${i}` },
    dedupeKey: `k-${email}`,
    source: "find:test",
  })!;
  ledger.setQueueStatus({ id: rowId, status: "sent" });
  ledger.enrollCadence({
    prospectId: id,
    playName: PLAY,
    nextDueAt: "2026-10-25T00:00:00Z",
    ...(linked ? { queueId: rowId } : {}),
    offer: { offer: offer(`offer for firm ${i}`), candidates: [], origin: "derived" },
  });
  const enrolled = ledger.getCadence(id, PLAY)!;
  ledger.saveCadencePlan(id, PLAY, enrolled.enrolled_at, [
    { id: "base:2", dayOffset: 5, channel: "email", label: "breakup" },
  ]);
  return id;
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  offerRecordCalls.n = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

describe("listCadences reads", () => {
  it("reads nothing per row for the offer, the cadence, its plan or its queue row", async () => {
    const N = 6;
    const ids = Array.from({ length: N }, (_, i) => cadence(i, i !== N - 1));
    const spies = {
      getCadence: vi.spyOn(ledger, "getCadence"),
      getCadencePlan: vi.spyOn(ledger, "getCadencePlan"),
      cadenceQueueRow: vi.spyOn(ledger, "cadenceQueueRow"),
      getQueueRow: vi.spyOn(ledger, "getQueueRow"),
      latestSentQueueRow: vi.spyOn(ledger, "latestSentQueueRow"),
      getQueueRowsByIds: vi.spyOn(ledger, "getQueueRowsByIds"),
      latestSentQueuePayloads: vi.spyOn(ledger, "latestSentQueuePayloads"),
      cadencePlansFor: vi.spyOn(ledger, "cadencePlansFor"),
    };

    const res = listCadences(new Request("http://localhost/api/cadences"));
    const views = ((await res.json()) as { cadences: Array<Record<string, any>> }).cadences;

    expect(views).toHaveLength(N);
    expect(spies.getCadence).not.toHaveBeenCalled();
    expect(spies.getCadencePlan).not.toHaveBeenCalled();
    expect(spies.cadenceQueueRow).not.toHaveBeenCalled();
    expect(spies.getQueueRow).not.toHaveBeenCalled();
    expect(spies.latestSentQueueRow).not.toHaveBeenCalled();
    expect(offerRecordCalls.n).toBe(0);
    // One read each for the page.
    expect(spies.getQueueRowsByIds).toHaveBeenCalledTimes(1);
    expect(spies.getQueueRowsByIds.mock.calls[0]![0]).toHaveLength(N - 1);
    expect(spies.cadencePlansFor).toHaveBeenCalledTimes(1);
    // Only the cadence with no link looks its row up by address.
    expect(spies.latestSentQueuePayloads).toHaveBeenCalledTimes(1);
    expect(spies.latestSentQueuePayloads.mock.calls[0]![0]).toEqual([
      { playName: PLAY, email: `owner${N - 1}@firm${N - 1}.example` },
    ]);

    // And every row still carries what those reads hold.
    for (const [i, id] of ids.entries()) {
      const v = views.find((c) => c["prospectId"] === id)!;
      expect(v["offer"]).toMatchObject({ text: `offer for firm ${i}` });
      expect(v["queuePayload"]).toMatchObject({ signal: `signal ${i}` });
      // From the saved plan, not the registered sequence.
      expect(v["followupCount"]).toBe(1);
      expect(v["nextStepLabel"]).toBe("breakup");
    }
  });

  it("reads each row's cadence and plan itself when the page's plan read fails", async () => {
    const id = cadence(1);
    vi.spyOn(ledger, "cadencePlansFor").mockImplementation(() => {
      throw new Error("no such table");
    });
    const getCadence = vi.spyOn(ledger, "getCadence");
    const res = listCadences(new Request("http://localhost/api/cadences"));
    const views = ((await res.json()) as { cadences: Array<Record<string, any>> }).cadences;
    expect(views[0]).toMatchObject({ prospectId: id, followupCount: 1, nextStepLabel: "breakup" });
    expect(getCadence).toHaveBeenCalled();
  });
});
