import { describe, expect, it, vi } from "vitest";

const listRunsMock = vi.fn();
const listReceiptsMock = vi.fn();
const eventsByPlayMock = vi.fn();
const listActiveCadencesMock = vi.fn();
const totalSpendUsdMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      listReceipts: listReceiptsMock,
      eventsByPlay: eventsByPlayMock,
      listActiveCadences: listActiveCadencesMock,
      totalSpendUsd: totalSpendUsdMock,
      listRuns: listRunsMock,
    }),
  };
});

const { homeMetrics } = await import("../src/api/home.ts");

function req(): Request {
  return new Request("http://localhost/api/home", { headers: { host: "127.0.0.1:3030" } });
}

describe("homeMetrics — currentRuns surfacing", () => {
  it("includes currentRuns from listRuns({status:'running', limit:5})", async () => {
    listReceiptsMock.mockReturnValue([{}, {}, {}]);
    eventsByPlayMock.mockReturnValue([
      { sent: 5, replied: 1 },
      { sent: 3, replied: 0 },
    ]);
    listActiveCadencesMock.mockReturnValue([{}, {}]);
    totalSpendUsdMock.mockReturnValue(1.23);
    listRunsMock.mockReturnValue([
      {
        id: 7,
        playName: "show-hn",
        status: "running",
        startedAt: "2026-06-06T22:00:00Z",
        completedAt: null,
        targetCount: 10,
        draftedCount: 3,
        sentCount: 1,
        errorCount: 0,
      },
    ]);
    const res = homeMetrics(req());
    const body = (await res.json()) as {
      currentRuns: Array<{ id: number; playName: string; status: string }>;
      callsLast7d: number;
      sentLast7d: number;
      activeCadences: number;
    };
    expect(body.callsLast7d).toBe(3);
    expect(body.sentLast7d).toBe(8); // 5 + 3
    expect(body.activeCadences).toBe(2);
    expect(body.currentRuns).toHaveLength(1);
    expect(body.currentRuns[0]).toMatchObject({
      id: 7,
      playName: "show-hn",
      status: "running",
    });
    expect(listRunsMock).toHaveBeenCalledWith({ status: "running", limit: 5 });
  });

  it("returns currentRuns as an empty array when no runs are in flight", async () => {
    listReceiptsMock.mockReturnValue([]);
    eventsByPlayMock.mockReturnValue([]);
    listActiveCadencesMock.mockReturnValue([]);
    totalSpendUsdMock.mockReturnValue(0);
    listRunsMock.mockReturnValue([]);
    const res = homeMetrics(req());
    const body = (await res.json()) as { currentRuns: unknown[] };
    expect(body.currentRuns).toEqual([]);
  });
});
