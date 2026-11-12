import { describe, expect, it, vi } from "vitest";

// The /cadences tiles: a row waiting on its LinkedIn invite's acceptance is
// listed but never overdue, and a cadence the invite timeout ended is counted
// apart from the founder's stops.

const listAllCadencesMock = vi.fn();
const WAITING_ID = 1;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      findDirectMail: () => null,
      getMailAddress: () => null,
      getRun: () => null,
      listAllCadences: listAllCadencesMock,
      listSequenceEventsForCadences: () => new Map(),
      latestSentQueuePayloads: () => new Map(),
    }),
  };
});

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    nextStepInfo: () => ({
      label: "LinkedIn message",
      isBreakup: false,
      nextStepNumber: 3,
      channel: "linkedin",
      stepId: "linkedin:1",
    }),
    linkedInWaitingSince: (input: { prospectId: number }) =>
      input.prospectId === WAITING_ID ? "2026-10-01" : null,
    playFollowupCount: () => 3,
    getPriorStepsBulk: () => new Map(),
  };
});

const { listCadences } = await import("../src/api/cadences.ts");

function row(prospectId: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    prospect_id: prospectId,
    play_name: "show-hn",
    channel: "email",
    current_step: 2,
    status,
    enrolled_at: "2026-09-01T00:00:00Z",
    next_due_at: status === "active" ? "2000-01-01T00:00:00.000Z" : null,
    last_polled_at: null,
    stop_reason: null,
    stop_note: null,
    stopped_at: null,
    next_step_draft_json: null,
    next_step_drafted_at: null,
    sending_started_at: null,
    prospect_email: `p${prospectId}@example.com`,
    prospect_name: "X",
    prospect_company: "Acme",
    ...extra,
  };
}

const req = (path: string) =>
  new Request(`http://localhost${path}`, { headers: { host: "127.0.0.1:3030" } });

describe("cadence tiles", () => {
  it("leaves a row waiting on acceptance out of overdue, still listed with its date", async () => {
    listAllCadencesMock.mockReturnValue([row(WAITING_ID, "active"), row(2, "active")]);
    const body = (await listCadences(req("/api/cadences")).json()) as {
      cadences: Array<{ prospectId: number; linkedinWaitingSince: string | null }>;
      counts: { active: number; overdue: number };
    };
    expect(body.counts).toMatchObject({ active: 2, overdue: 1 });
    expect(body.cadences.map((c) => [c.prospectId, c.linkedinWaitingSince])).toEqual([
      [WAITING_ID, "2026-10-01"],
      [2, null],
    ]);
  });

  it("gives the filter chips the step id and the day a waiting invite is withdrawn", async () => {
    listAllCadencesMock.mockReturnValue([row(WAITING_ID, "active"), row(2, "active")]);
    const body = (await listCadences(req("/api/cadences")).json()) as {
      cadences: Array<{
        prospectId: number;
        nextStepId: string | null;
        linkedinInviteExpiresOn: string | null;
      }>;
    };
    // The default invite timeout is 21 days.
    expect(
      body.cadences.map((c) => [c.prospectId, c.nextStepId, c.linkedinInviteExpiresOn]),
    ).toEqual([
      [WAITING_ID, "linkedin:1", "2026-10-22"],
      [2, "linkedin:1", null],
    ]);
  });

  it("counts an invite timeout apart from the founder's stops", async () => {
    listAllCadencesMock.mockReturnValue([
      row(3, "stopped", { stop_reason: "invite_timeout" }),
      row(4, "stopped", { stop_reason: "bad_timing" }),
      row(5, "completed", { stop_reason: "invite_expired" }),
    ]);
    const body = (await listCadences(req("/api/cadences?all=1")).json()) as {
      cadences: Array<{ stopReason: string | null }>;
      counts: { stopped: number; inviteTimedOut: number; completed: number };
    };
    expect(body.counts).toMatchObject({ stopped: 1, inviteTimedOut: 1, completed: 1 });
    expect(body.cadences.map((c) => c.stopReason)).toEqual([
      "invite_timeout",
      "bad_timing",
      "invite_expired",
    ]);
  });
});
