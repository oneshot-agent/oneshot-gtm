import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/cadences marks an active cadence whose person another workspace just
// emailed: the runner skips that step until the shared 7-day window ends, so
// the row must say held instead of reading as overdue.

let touches: Record<
  string,
  { workspace: string; play_name: string; sent_at: string; status: "sent" }
> = {};
const touchReads: string[] = [];

const base = {
  play_name: "accelerator-batch",
  current_step: 0,
  enrolled_at: "2026-09-25T20:46:44Z",
  next_due_at: "2026-09-30T20:46:44Z",
  last_polled_at: null,
  next_step_draft_json: null,
  next_step_drafted_at: null,
  sending_started_at: null,
  prospect_name: "X",
  prospect_company: "Acme",
};
const rows = [
  { ...base, prospect_id: 1, status: "active", prospect_email: "held@x.io" },
  { ...base, prospect_id: 2, status: "active", prospect_email: "free@x.io" },
  { ...base, prospect_id: 3, status: "completed", prospect_email: "held@x.io" },
];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    recentTouchElsewhere: (email: string) => {
      touchReads.push(email);
      return touches[email] ?? null;
    },
    getLedger: () => ({
      findDirectMail: () => null,
      getMailAddress: () => null,
      listAllCadences: () => rows,
      listSequenceEventsForCadences: () => new Map(),
      latestSentQueuePayloads: () => new Map(),
    }),
  };
});

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    nextStepInfo: () => ({ label: "breakup", isBreakup: true }),
    playFollowupCount: () => 1,
    getPriorStepsBulk: () => new Map(),
  };
});

const { listCadences } = await import("../src/api/cadences.ts");

const get = async () => {
  const res = listCadences(
    new Request("http://localhost/api/cadences?all=1", { headers: { host: "127.0.0.1:3030" } }),
  );
  return (await res.json()) as {
    cadences: Array<{ prospectId: number; heldElsewhere: Record<string, string> | null }>;
  };
};

beforeEach(() => {
  touches = {};
  touchReads.length = 0;
});

describe("listCadences heldElsewhere", () => {
  it("carries the other workspace's touch and when the 7-day window ends", async () => {
    touches["held@x.io"] = {
      workspace: "sdk",
      play_name: "accelerator-batch",
      sent_at: "2026-10-05T20:13:44.829Z",
      status: "sent",
    };
    const body = await get();
    const byId = new Map(body.cadences.map((c) => [c.prospectId, c.heldElsewhere]));
    expect(byId.get(1)).toEqual({
      workspace: "sdk",
      playName: "accelerator-batch",
      sentAt: "2026-10-05T20:13:44.829Z",
      until: "2026-10-12T20:13:44.829Z",
    });
    expect(byId.get(2)).toBeNull();
  });

  it("only active cadences are checked", async () => {
    await get();
    expect(touchReads).toEqual(["held@x.io", "free@x.io"]);
  });
});
