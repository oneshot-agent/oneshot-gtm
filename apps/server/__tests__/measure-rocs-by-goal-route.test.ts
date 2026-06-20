import { beforeEach, describe, expect, it, vi } from "vitest";

// measureRocsByGoal: OneShot's goal-level RoCS, scoped to THIS app's cadences
// (goals we hold local receipts for) and labelled play → prospect. cadenceRocs +
// the ledger are mocked so no wallet/network/real ledger is touched.

const cadenceRocsMock = vi.fn();
const goalLabelsMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    cadenceRocs: cadenceRocsMock,
    getLedger: () => ({ goalLabels: goalLabelsMock }),
  };
});

const { measureRocsByGoal } = await import("../src/api/measure.ts");

function req(qs = ""): Request {
  return new Request(`http://localhost/api/measure/rocs-by-goal${qs}`, {
    headers: { host: "127.0.0.1:3030" },
  });
}

const OURS = {
  goalId: "goal_ours",
  spend: 0.42,
  value: 5000,
  pendingValue: 0,
  rocs: 11904.7,
  receiptCount: 4,
};
const FOREIGN = {
  goalId: "goal_01HXcompute",
  spend: 9,
  value: 0,
  pendingValue: 0,
  rocs: 0,
  receiptCount: 1,
};

beforeEach(() => {
  cadenceRocsMock.mockReset();
  goalLabelsMock.mockReset();
});

describe("measureRocsByGoal", () => {
  it("keeps only goals with local labels and maps play + prospect", async () => {
    cadenceRocsMock.mockResolvedValue([OURS, FOREIGN]);
    goalLabelsMock.mockReturnValue(
      new Map([["goal_ours", { playName: "show-hn", prospect: "p@x.dev" }]]),
    );

    const res = await measureRocsByGoal(req("?sinceDays=30"));
    const body = (await res.json()) as {
      goals: Array<{ goalId: string; playName: string; prospect: string; value: number }>;
    };

    // period passed through; foreign compute goal dropped
    expect(cadenceRocsMock).toHaveBeenCalledWith({ periodDays: 30 });
    expect(body.goals).toHaveLength(1);
    expect(body.goals[0]).toMatchObject({
      goalId: "goal_ours",
      playName: "show-hn",
      prospect: "p@x.dev",
      value: 5000,
    });
  });

  it("omits the period for the all-time window", async () => {
    cadenceRocsMock.mockResolvedValue([]);
    goalLabelsMock.mockReturnValue(new Map());
    await measureRocsByGoal(req());
    expect(cadenceRocsMock).toHaveBeenCalledWith({});
  });

  it("degrades to an empty list (200) when the platform read fails", async () => {
    cadenceRocsMock.mockRejectedValue(new Error("wallet unconfigured"));
    const res = await measureRocsByGoal(req("?sinceDays=7"));
    expect(res.status).toBe(200);
    expect((await res.json()) as { goals: unknown[] }).toEqual({ goals: [] });
  });
});
