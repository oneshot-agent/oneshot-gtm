import { beforeEach, describe, expect, it, vi } from "vitest";

// A queue row's offer is written once, stored on the live row, and re-read
// so callers compare against the stored payload text.

const ledger = {
  patchLiveQueuePayload: vi.fn(() => true),
  getQueueRow: vi.fn((id: number) => ({ id, payload_json: '{"stored":true}' })),
};
const ensureOffer = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, logEvent: () => {} };
});
vi.mock("@oneshot-gtm/plays", () => ({
  playMakesOffer: (play: string) => play !== "pmf-survey",
  ensureOffer: (...args: unknown[]) => ensureOffer(...args),
}));

const { ensureQueueRowOffer } = await import("../src/queue-offer.ts");

const row = { id: 7, play_name: "show-hn", payload_json: '{"name":"Dana"}' };

beforeEach(() => {
  ensureOffer.mockReset();
  ledger.patchLiveQueuePayload.mockClear();
  ledger.getQueueRow.mockClear();
});

describe("ensureQueueRowOffer", () => {
  it("stores a fresh offer on the live row and returns the stored payload", async () => {
    const offer = { offer: "x", steps: "a, b" };
    ensureOffer.mockResolvedValue(offer);
    const out = await ensureQueueRowOffer(row);
    expect(ledger.patchLiveQueuePayload).toHaveBeenCalledWith({ id: 7, patch: { offer } });
    expect(out.payload_json).toBe('{"stored":true}');
  });

  it("leaves a row alone when its offer is current", async () => {
    const offer = { offer: "x", steps: "a, b" };
    const current = { ...row, payload_json: JSON.stringify({ name: "Dana", offer }) };
    ensureOffer.mockImplementation(
      async ({ target }: { target: { offer: unknown } }) => target.offer,
    );
    expect(await ensureQueueRowOffer(current)).toBe(current);
    expect(ledger.patchLiveQueuePayload).not.toHaveBeenCalled();
  });

  it("skips a play that makes no offer", async () => {
    const survey = { ...row, play_name: "pmf-survey" };
    expect(await ensureQueueRowOffer(survey)).toBe(survey);
    expect(ensureOffer).not.toHaveBeenCalled();
  });

  it("never throws: a failure leaves the row as it was", async () => {
    ensureOffer.mockRejectedValue(new Error("model down"));
    expect(await ensureQueueRowOffer(row)).toBe(row);
  });
});
