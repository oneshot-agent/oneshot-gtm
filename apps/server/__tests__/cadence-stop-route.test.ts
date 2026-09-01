import { beforeEach, describe, expect, it, vi } from "vitest";

const stopCadenceMock = vi.fn();
const getCadenceMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({ stopCadence: stopCadenceMock, getCadence: getCadenceMock }),
  };
});

const { stopCadence } = await import("../src/api/cadences.ts");

function request(body: unknown, play = "show-hn"): Request {
  return new Request(`http://localhost/api/cadences/7/stop?play=${play}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("stopCadence", () => {
  beforeEach(() => {
    stopCadenceMock.mockReset();
    stopCadenceMock.mockReturnValue(true);
    getCadenceMock.mockReset();
    getCadenceMock.mockReturnValue({ status: "active", sending_started_at: null });
  });

  it("records a structured reason and trimmed note", async () => {
    const response = await stopCadence(
      request({ reason: "bad_timing", note: "  revisit after launch  " }),
      { id: "7" },
    );
    expect(response.status).toBe(200);
    expect(stopCadenceMock).toHaveBeenCalledWith({
      prospectId: 7,
      playName: "show-hn",
      reason: "bad_timing",
      note: "revisit after launch",
    });
  });

  it("requires a valid reason and a note for other", async () => {
    expect((await stopCadence(request({ reason: "unknown" }), { id: "7" })).status).toBe(400);
    expect((await stopCadence(request({ reason: "other" }), { id: "7" })).status).toBe(400);
    expect(stopCadenceMock).not.toHaveBeenCalled();
  });

  it("requires a play so the stop remains cadence-scoped", async () => {
    expect((await stopCadence(request({ reason: "not_a_fit" }, ""), { id: "7" })).status).toBe(400);
  });

  it("refuses to race an in-flight send", async () => {
    getCadenceMock.mockReturnValue({ status: "active", sending_started_at: "2026-09-01 10:00:00" });
    const response = await stopCadence(request({ reason: "bad_timing" }), { id: "7" });
    expect(response.status).toBe(409);
    expect(stopCadenceMock).not.toHaveBeenCalled();
  });
});
