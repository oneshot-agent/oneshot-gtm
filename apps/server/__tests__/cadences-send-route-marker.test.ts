import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The single-row Send route claims `sending_started_at` and sends in the
// background. A skipped step (the cross-workspace contact hold) returns
// without advancing the cadence, so the route itself must release the
// marker, or the row reads "sending…" until the stale sweep.

const sendMock = vi.fn();
const claimMarkerMock = vi.fn(() => true);
const clearMarkerMock = vi.fn();
let held = false;
// The stored preview's payload kind and config key (absent: written before keys).
let preview: { kind: string; configKey?: string } = { kind: "" };

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
      getCadence: () =>
        held
          ? {
              held_until: new Date(Date.now() + 86_400_000).toISOString(),
              hold_reason: "out-of-office",
              return_date: "2026-11-09",
            }
          : { held_until: null },
      getCadenceDraft: () => ({
        subject: "s",
        body: "b",
        flags: [],
        payload: preview.kind ? { kind: preview.kind } : {},
        draftedAt: "now",
        ...(preview.configKey ? { configKey: preview.configKey } : {}),
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
  held = false;
  preview = { kind: "" };
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

const withBody = (body: unknown) =>
  new Request("http://localhost/api/cadences/7/send-next?play=accelerator-batch", {
    method: "POST",
    headers: { host: "127.0.0.1:3030", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("sendCadenceStepRoute on a row an out-of-office holds", () => {
  it("409s with the hold unless the founder confirms", async () => {
    held = true;
    const res = await sendCadenceStepRoute(withBody({}), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringMatching(/^away until 2026-11-09/),
      hold: { reason: "out-of-office", returnDate: "2026-11-09" },
    });
    expect(claimMarkerMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends through the hold with confirmHold: true", async () => {
    held = true;
    sendMock.mockResolvedValue({ action: "step-sent", payload: null, receiptIds: [1] });
    const res = await sendCadenceStepRoute(withBody({ confirmHold: true }), params);
    expect(res.status).toBe(202);
    await settle();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ confirmHold: true }));
  });

  it("400s on a confirmHold that is not a boolean", async () => {
    const res = await sendCadenceStepRoute(withBody({ confirmHold: "yes" }), params);
    expect(res.status).toBe(400);
  });
});

describe("sendCadenceStepRoute and a preview written under an older setup", () => {
  const send = (body?: unknown) =>
    sendCadenceStepRoute(
      new Request("http://localhost/api/cadences/7/send?play=accelerator-batch", {
        method: "POST",
        headers: { host: "127.0.0.1:3030", "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      params,
    );

  it("answers 409 stale unless the founder confirms, and claims nothing", async () => {
    for (const configKey of [undefined, "0ld0ld0ld0ld"]) {
      preview = { kind: "email", ...(configKey ? { configKey } : {}) };
      const res = await send();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        stale: true,
        error: "stale-config: draft written under an older setup; re-preview",
      });
    }
    expect(claimMarkerMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends with confirmStale, and passes it on", async () => {
    preview = { kind: "email" };
    sendMock.mockResolvedValue({ action: "sent", payload: null, receiptIds: [1] });
    const res = await send({ confirmStale: true });
    expect(res.status).toBe(202);
    await settle();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ confirmStale: true }));
  });

  it("refuses a confirmStale that is not a boolean", async () => {
    const res = await send({ confirmStale: "yes" });
    expect(res.status).toBe(400);
  });
});
