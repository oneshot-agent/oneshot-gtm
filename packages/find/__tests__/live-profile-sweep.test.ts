import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The scheduler's live-profile sweep: only live rows with a LinkedIn seed
// and no live read qualify, approved first; a trigger can opt its play out;
// the sweep stops where the read path stops (daily cap, login wall) and at
// its own row and spend caps; nothing runs without a verified session.

let cfg: Record<string, unknown> = {};
let demo = false;
let triggers: Array<{ name: string; config_json: string | null }> = [];
let queue: Array<Record<string, unknown>> = [];
const events: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    demoMode: () => demo,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfg }),
    logEvent: (kind: string) => {
      events.push(kind);
    },
    getLedger: () => ({
      listTriggers: () => triggers,
      listQueue: (opts: { status: string }) => queue.filter((r) => r["status"] === opts.status),
    }),
  };
});

const { selectLiveSweepCandidates, sweepLiveProfiles } =
  await import("../src/_live-profile-sweep.ts");

const LI = "https://www.linkedin.com/in/";
function row(
  id: number,
  status: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    play_name: "luma-events",
    source: "luma",
    notes: null,
    status,
    prospect_id: null,
    sent_at: null,
    send_started_at: null,
    payload_json: JSON.stringify(payload),
    ...extra,
  };
}

beforeEach(() => {
  demo = false;
  cfg = {
    linkedinBrowserProfileId: "prof_1",
    linkedinSessionCheckedAt: "2026-09-14T10:18:52.694Z",
    linkedinSessionInvalidAt: null,
  };
  triggers = [];
  events.length = 0;
  queue = [
    row(1, "pending", { name: "A", linkedinUrl: `${LI}a` }),
    row(2, "approved", { name: "B", linkedinUrl: `${LI}b` }),
    row(3, "pending", {
      name: "C",
      linkedinUrl: `${LI}c`,
      personResearch: { status: "complete", liveProfile: { url: `${LI}c`, readAt: "x" } },
    }),
    row(4, "pending", { name: "D", email: "d@x.dev" }),
    row(5, "pending", { name: "E", linkedinUrl: `${LI}e` }, { sent_at: "2026-09-13" }),
    row(6, "pending", { name: "F", linkedinUrl: `${LI}f` }, { play_name: "github-stars" }),
    row(7, "approved", { name: "G", linkedinUrl: `${LI}g` }),
  ];
});
afterEach(() => {
  delete process.env["LINKEDIN_SESSION_COOKIE"];
});

describe("selectLiveSweepCandidates", () => {
  it("keeps live LinkedIn rows without a live read, approved first then newest, and honours a play opt-out", () => {
    const picked = selectLiveSweepCandidates(queue as never, (play) => play === "github-stars");
    expect(picked.map((c) => c.row.id)).toEqual([7, 2, 1]);
    expect(picked[0]?.seed.url).toBe("https://linkedin.com/in/g");
  });
});

describe("sweepLiveProfiles", () => {
  const researched: number[] = [];
  const applied: number[] = [];
  let warnings: Record<number, string> = {};
  const deps = {
    researchPerson: async (input: { subject: { queueId?: number }; remainingUsd: number }) => {
      const id = input.subject.queueId!;
      researched.push(id);
      const warning = warnings[id];
      return {
        dossier: {
          status: "complete",
          ...(warning ? { warning } : { liveProfile: { url: "u", readAt: "t" } }),
        },
        costUsd: 0.012,
        cached: false,
      };
    },
    applyPersonResearch: async (_l: unknown, r: { id: number }) => {
      applied.push(r.id);
      return { outcome: "patched", verdict: null, patch: {} };
    },
  } as never;

  beforeEach(() => {
    researched.length = 0;
    applied.length = 0;
    warnings = {};
  });

  it("does nothing without a verified session or in demo mode", async () => {
    cfg = { ...cfg, linkedinSessionInvalidAt: "2026-09-14T11:00:00.000Z" };
    expect(await sweepLiveProfiles({}, deps)).toMatchObject({ ran: false, reason: "session" });
    cfg = { ...cfg, linkedinSessionInvalidAt: null };
    demo = true;
    expect(await sweepLiveProfiles({}, deps)).toMatchObject({ ran: false, reason: "demo" });
    expect(researched).toEqual([]);
  });

  it("researches the candidates in order, counts live reads and spend, and reads the trigger opt-out", async () => {
    triggers = [
      { name: "github-stars", config_json: JSON.stringify({ linkedinProfileRead: false }) },
    ];
    const r = await sweepLiveProfiles({}, deps);
    expect(r).toMatchObject({ ran: true, candidates: 3, researched: 3, read: 3 });
    expect(r.costUsd).toBeCloseTo(0.036, 5);
    expect(researched).toEqual([7, 2, 1]);
    expect(applied).toEqual([7, 2, 1]);
    expect(events).toContain("live_profile_sweep.done");
  });

  it("stops at the daily cap and on a login wall, after applying that row's provider result", async () => {
    warnings = { 2: "live profile skipped: daily-limit" };
    const capped = await sweepLiveProfiles({}, deps);
    expect(capped).toMatchObject({ researched: 2, read: 1, stoppedBy: "daily-limit" });
    expect(applied).toEqual([7, 2]);

    researched.length = applied.length = 0;
    warnings = { 7: "live profile skipped: session-invalid" };
    const walled = await sweepLiveProfiles({}, deps);
    expect(walled).toMatchObject({ researched: 1, read: 0, stoppedBy: "session-invalid" });
  });

  it("stops at its own row and spend caps", async () => {
    expect(await sweepLiveProfiles({ maxRows: 1 }, deps)).toMatchObject({
      researched: 1,
      stoppedBy: "max-rows",
    });
    researched.length = 0;
    expect(await sweepLiveProfiles({ maxCostUsd: 0.02 }, deps)).toMatchObject({
      researched: 2,
      stoppedBy: "budget",
    });
  });
});
