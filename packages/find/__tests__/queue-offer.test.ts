import { beforeEach, describe, expect, it, vi } from "vitest";

// A queue row's offer is written once, stored on the live row, and re-read
// so callers compare against the stored payload text.

const ledger = {
  patchLiveQueuePayload: vi.fn(() => true),
  getQueueRow: vi.fn((id: number) => ({ id, payload_json: '{"stored":true}' })),
};
const ensureOfferSet = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, logEvent: () => {} };
});
vi.mock("@oneshot-gtm/plays", () => ({
  playMakesOffer: (play: string) => play !== "pmf-survey",
  ensureOfferSet: (...args: unknown[]) => ensureOfferSet(...args),
}));

const { ensureQueueRowOffer } = await import("../src/queue-offer.ts");

const row = { id: 7, play_name: "show-hn", payload_json: '{"name":"Dana"}' };

beforeEach(() => {
  ensureOfferSet.mockReset();
  ledger.patchLiveQueuePayload.mockClear();
  ledger.getQueueRow.mockClear();
});

describe("ensureQueueRowOffer", () => {
  it("stores the active offer and the ranked list on the live row, returning the stored payload", async () => {
    const offer = { offer: "x", steps: "a, b", angles: ["why 1", "why 2"] };
    const candidates = [offer, { offer: "y", steps: "c, d" }];
    ensureOfferSet.mockResolvedValue({ offer, candidates, changed: true });
    const out = await ensureQueueRowOffer(row);
    expect(ledger.patchLiveQueuePayload).toHaveBeenCalledWith({
      id: 7,
      patch: { offer, offerCandidates: candidates },
    });
    expect(out.payload_json).toBe('{"stored":true}');
  });

  it("leaves a row alone when its offers are current", async () => {
    const offer = { offer: "x", steps: "a, b" };
    const current = { ...row, payload_json: JSON.stringify({ name: "Dana", offer }) };
    ensureOfferSet.mockResolvedValue({ offer, candidates: [offer], changed: false });
    expect(await ensureQueueRowOffer(current)).toBe(current);
    expect(ledger.patchLiveQueuePayload).not.toHaveBeenCalled();
  });

  it("skips a play that makes no offer", async () => {
    const survey = { ...row, play_name: "pmf-survey" };
    expect(await ensureQueueRowOffer(survey)).toBe(survey);
    expect(ensureOfferSet).not.toHaveBeenCalled();
  });

  it("never throws: a failure leaves the row as it was", async () => {
    ensureOfferSet.mockRejectedValue(new Error("model down"));
    expect(await ensureQueueRowOffer(row)).toBe(row);
  });
});
