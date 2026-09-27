import { beforeEach, describe, expect, it, vi } from "vitest";

// When recent posts are bought: on approval (never at row creation), and for
// prospects in a running cadence whose cached posts are missing or expired.
// The capture itself (cache, lane, 429s) is newsfeed.test.ts's.

type Row = {
  id: number;
  status: string;
  source: string;
  play_name: string;
  payload_json: string;
};

const DAY = 24 * 3600 * 1000;

const state = {
  calls: [] as string[],
  rows: new Map<number, Row>(),
  triggers: new Map<string, { config_json: string | null }>(),
  cache: new Map<string, { result_json: string; fetched_at: string; status?: string | null }>(),
  cadences: [] as Array<{
    prospect_id: number;
    play_name: string;
    enrolled_at: string;
    prospect_email: string | null;
  }>,
  prospects: new Map<
    number,
    {
      id: number;
      linkedin_url: string | null;
      source_profile_url: string | null;
      dossier_json: string | null;
    }
  >(),
  sentSource: new Map<string, string>(),
  ceilingReached: false,
  slowMs: 0,
};

const POSTS = {
  status: "completed",
  cost: 0.07,
  result: [{ platform: "linkedin", content: "Shipped.", posted_at: "2026-09-20T10:00:00Z" }],
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    demoMode: () => false,
    logEvent: () => {},
    dailySpendStatus: () => ({ ceilingReached: state.ceilingReached }),
    triggerConfigForSource: (source: string | null | undefined) =>
      actual.triggerConfigForSource(source, (name) => state.triggers.get(name) ?? null),
    personNewsfeed: async (input: { socialMediaUrl: string }) => {
      state.calls.push(input.socialMediaUrl);
      if (state.slowMs > 0) await new Promise((r) => setTimeout(r, state.slowMs));
      return { result: POSTS, receiptId: 5 };
    },
    getLedger: () => ({
      getCachedEnrichment: (key: string) => state.cache.get(key) ?? null,
      setCachedEnrichment: (key: string, json: string) =>
        state.cache.set(key, { result_json: json, fetched_at: new Date().toISOString() }),
      setCachedEnrichmentFailure: () => {},
      getQueueRow: (id: number) => state.rows.get(id) ?? null,
      patchLiveQueuePayload: () => true,
      getProspectById: (id: number) => state.prospects.get(id) ?? null,
      mergeProspectDossierHalf: () => {},
      listActiveCadences: () => state.cadences,
      latestSentQueueRow: (play: string, email: string) => {
        const source = state.sentSource.get(`${play}|${email}`);
        return source ? { payload: {}, source } : null;
      },
    }),
  };
});

const {
  _resetNewsfeed,
  captureNewsfeedOnApproval,
  scheduleNewsfeedOnApproval,
  selectInFlightNewsfeedCandidates,
  sweepInFlightNewsfeeds,
} = await import("../src/_newsfeed.ts");

function approvedRow(id: number, over: Partial<Row> = {}): Row {
  return {
    id,
    status: "approved",
    source: "find:accelerator-batch",
    play_name: "accelerator-batch",
    payload_json: JSON.stringify({ linkedinUrl: `https://linkedin.com/in/person-${id}` }),
    ...over,
  };
}

function prospect(id: number) {
  return {
    id,
    linkedin_url: `https://www.linkedin.com/in/p-${id}`,
    source_profile_url: null,
    dossier_json: null,
  };
}

beforeEach(() => {
  _resetNewsfeed();
  state.calls = [];
  state.rows.clear();
  state.triggers.clear();
  state.cache.clear();
  state.cadences = [];
  state.prospects.clear();
  state.sentSource.clear();
  state.ceilingReached = false;
  state.slowMs = 0;
});

describe("captureNewsfeedOnApproval", () => {
  it("captures approved rows one after another and skips rows that left approved", async () => {
    state.rows.set(1, approvedRow(1));
    state.rows.set(2, approvedRow(2, { status: "sent" }));
    state.rows.set(3, approvedRow(3));
    const result = await captureNewsfeedOnApproval([1, 2, 3, 99]);
    expect(state.calls).toEqual([
      "https://www.linkedin.com/in/person-1",
      "https://www.linkedin.com/in/person-3",
    ]);
    expect(result).toMatchObject({ captured: 2, skipped: 2, costUsd: 0.14 });
  });

  it("honours the trigger's personNewsfeed: false", async () => {
    state.triggers.set("accelerator-batch", {
      config_json: JSON.stringify({ personNewsfeed: false }),
    });
    state.rows.set(1, approvedRow(1));
    state.rows.set(2, approvedRow(2, { source: "find:luma-events", play_name: "luma-events" }));
    await captureNewsfeedOnApproval([1, 2]);
    expect(state.calls).toEqual(["https://www.linkedin.com/in/person-2"]);
  });

  it("stops the batch at the daily spend ceiling", async () => {
    state.ceilingReached = true;
    state.rows.set(1, approvedRow(1));
    state.rows.set(2, approvedRow(2));
    const result = await captureNewsfeedOnApproval([1, 2]);
    expect(state.calls).toEqual([]);
    expect(result.costUsd).toBe(0);
  });

  it("a fresh cache entry is free", async () => {
    state.cache.set("newsfeed:https://www.linkedin.com/in/person-1", {
      result_json: JSON.stringify(POSTS),
      fetched_at: new Date().toISOString(),
    });
    state.rows.set(1, approvedRow(1));
    const result = await captureNewsfeedOnApproval([1]);
    expect(state.calls).toEqual([]);
    expect(result).toMatchObject({ cached: 1, costUsd: 0 });
  });
});

describe("scheduleNewsfeedOnApproval", () => {
  it("returns before the capture completes", async () => {
    state.slowMs = 30;
    state.rows.set(1, approvedRow(1));
    scheduleNewsfeedOnApproval([1]);
    // Synchronous return: the call has not finished yet.
    expect(state.cache.size).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(state.calls).toEqual(["https://www.linkedin.com/in/person-1"]);
    expect(state.cache.size).toBe(1);
  });

  it("never throws into the caller when the capture fails", () => {
    state.rows.set(1, { ...approvedRow(1), payload_json: "not json" });
    expect(() => scheduleNewsfeedOnApproval([1])).not.toThrow();
  });
});

describe("selectInFlightNewsfeedCandidates", () => {
  it("orders by enrolment, dedupes prospects, and drops fresh, profileless and opted-out ones", () => {
    const cadences = [
      { prospect_id: 3, play_name: "a", enrolled_at: "2026-09-10T00:00:00Z" },
      { prospect_id: 1, play_name: "a", enrolled_at: "2026-09-01T00:00:00Z" },
      { prospect_id: 1, play_name: "b", enrolled_at: "2026-09-05T00:00:00Z" },
      { prospect_id: 2, play_name: "a", enrolled_at: "2026-09-02T00:00:00Z" },
      { prospect_id: 4, play_name: "a", enrolled_at: "2026-09-03T00:00:00Z" },
      { prospect_id: 5, play_name: "off", enrolled_at: "2026-09-04T00:00:00Z" },
    ];
    const out = selectInFlightNewsfeedCandidates(cadences, {
      seedFor: (id) => (id === 4 ? null : `https://www.linkedin.com/in/p-${id}`),
      isFresh: (url) => url.endsWith("p-2"),
      offFor: (_id, play) => play === "off",
    });
    expect(out.map((c) => [c.prospectId, c.playName])).toEqual([
      [1, "a"],
      [3, "a"],
    ]);
  });
});

describe("sweepInFlightNewsfeeds", () => {
  function inFlight(n: number): void {
    for (let id = 1; id <= n; id++) {
      state.prospects.set(id, prospect(id));
      state.cadences.push({
        prospect_id: id,
        play_name: "accelerator-batch",
        enrolled_at: new Date(Date.parse("2026-09-01T00:00:00Z") + id * DAY).toISOString(),
        prospect_email: `p${id}@x.dev`,
      });
      state.sentSource.set(`accelerator-batch|p${id}@x.dev`, "find:accelerator-batch");
    }
  }

  it("captures missing or expired feeds, oldest enrolment first, bounded per sweep", async () => {
    inFlight(4);
    // #2 is fresh (skipped); #3 expired (refetched).
    state.cache.set("newsfeed:https://www.linkedin.com/in/p-2", {
      result_json: JSON.stringify(POSTS),
      fetched_at: new Date().toISOString(),
    });
    state.cache.set("newsfeed:https://www.linkedin.com/in/p-3", {
      result_json: JSON.stringify(POSTS),
      fetched_at: new Date(Date.now() - 15 * DAY).toISOString(),
    });
    const result = await sweepInFlightNewsfeeds({ maxProspects: 2 });
    expect(result.candidates).toBe(3);
    expect(state.calls).toEqual([
      "https://www.linkedin.com/in/p-1",
      "https://www.linkedin.com/in/p-3",
    ]);
    expect(result).toMatchObject({ captured: 2, stoppedBy: "max-prospects" });
  });

  it("reads the opt-out from the trigger of the prospect's sent intro", async () => {
    inFlight(2);
    state.sentSource.set("accelerator-batch|p2@x.dev", "find:quiet");
    state.triggers.set("quiet", { config_json: JSON.stringify({ personNewsfeed: false }) });
    await sweepInFlightNewsfeeds();
    expect(state.calls).toEqual(["https://www.linkedin.com/in/p-1"]);
  });

  it("stops at the daily spend ceiling", async () => {
    inFlight(3);
    state.ceilingReached = true;
    const result = await sweepInFlightNewsfeeds();
    expect(state.calls).toEqual([]);
    expect(result.stoppedBy).toBe("spend-ceiling");
  });
});
