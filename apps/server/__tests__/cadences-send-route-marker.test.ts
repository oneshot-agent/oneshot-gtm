import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The single-row Send route claims `sending_started_at` and sends in the
// background. A skipped step (the cross-workspace contact hold) returns
// without advancing the cadence, so the route itself must release the
// marker, or the row reads "sending…" until the stale sweep.

const sendMock = vi.fn();
const claimMarkerMock = vi.fn(() => true);
const clearMarkerMock = vi.fn();

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, sendCadenceStep: (input: unknown) => sendMock(input) };
});

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    getLedger: () => ({
      claimCadenceSendingMarker: claimMarkerMock,
      clearCadenceSendingMarker: clearMarkerMock,
      getCadenceDraft: () => ({
        subject: "s",
        body: "b",
        flags: [],
        payload: {},
        draftedAt: "now",
      }),
    }),
  };
});

const { sendCadenceStepRoute } = await import("../src/api/cadences.ts");

const request = () =>
  new Request("http://localhost/api/cadences/7/send?play=accelerator-batch", {
    method: "POST",
    headers: { host: "127.0.0.1:3030" },
  });
const params = { id: "7" };

/** Let the fire-and-forget send settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sendMock.mockReset();
  claimMarkerMock.mockReset();
  claimMarkerMock.mockReturnValue(true);
  clearMarkerMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("sendCadenceStepRoute releases the sending marker", () => {
  it("after a skipped step: the hold returns without advancing the cadence", async () => {
    sendMock.mockResolvedValue({
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: "held: sdk/accelerator-batch — retries after the 7-day window",
    });
    const res = await sendCadenceStepRoute(request(), params);
    expect(res.status).toBe(202);
    await settle();
    expect(clearMarkerMock).toHaveBeenCalledWith({ prospectId: 7, playName: "accelerator-batch" });
  });

  it("after a failed send", async () => {
    sendMock.mockRejectedValue(new Error("Tool request failed"));
    await sendCadenceStepRoute(request(), params);
    await settle();
    expect(clearMarkerMock).toHaveBeenCalledTimes(1);
  });

  it("after a sent step too (advanceCadence already cleared it; a second clear is harmless)", async () => {
    sendMock.mockResolvedValue({ action: "sent", payload: null, receiptIds: [1] });
    await sendCadenceStepRoute(request(), params);
    await settle();
    expect(clearMarkerMock).toHaveBeenCalledTimes(1);
  });

  it("never sends or clears when the marker is already held", async () => {
    claimMarkerMock.mockReturnValue(false);
    const res = await sendCadenceStepRoute(request(), params);
    expect(res.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
    expect(clearMarkerMock).not.toHaveBeenCalled();
  });
});
