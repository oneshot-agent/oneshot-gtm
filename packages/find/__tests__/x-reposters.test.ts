import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XCandidate, XUser } from "../src/_x-types.ts";

// Routing is the crux: a founder-lane pick → x-repost-intro, an amplifier with
// an email → x-amplify, an amplifier without one → x-amplify-dm. Mock the
// module boundaries (harvest, cache, engines, SDK research, gates, ledger);
// scoring/lane logic stays REAL so lane routing is exercised end-to-end.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  initialStatus?: string;
  notes?: string;
}
const enqueued: EnqueuedRow[] = [];
const persisted: Array<{ playName: string; dedupeKey: string; reason: string }> = [];
const researchCalls: string[] = [];
const recordedTweetIds: string[][] = [];
const savedHarvests: string[] = [];

let harvestCandidates: XCandidate[] = [];
let harvestStoppedEarly: string | null = null;
let harvestedIds: string[] = [];
let cachedHarvest: {
  engine: string;
  seeds: string[];
  tweetsScanned: number;
  candidates: XCandidate[];
} | null = null;
let stageAAction: "proceed" | "reject" | "defer" = "proceed";
let stageBVerdict: "pass" | "reject" | "unclear" | "transient" = "pass";
let dupHandles = new Set<string>();
/** handle → email deepResearchPerson finds; absent → no email in the dossier. */
let emailsByHandle: Record<string, string> = {};

function user(over: Partial<XUser> = {}): XUser {
  return {
    id: "1",
    username: "someone",
    name: "Some One",
    description: "building AI agents, shipping in public",
    followers: 8_000,
    following: 900,
    tweetCount: 4_000,
    dmOpen: true,
    links: [],
    createdAt: "2021-01-01T00:00:00Z",
    ...over,
  };
}

function candidate(over: Partial<XUser> = {}, seed = "iamdevloper"): XCandidate {
  return {
    user: user(over),
    hits: [
      {
        id: `t-${seed}`,
        seed,
        mode: "retweet" as const,
        text: "a tweet worth reposting",
        url: `https://x.com/${seed}/status/t-${seed}`,
        createdAt: new Date().toISOString(),
        retweets: 30,
      },
    ],
    modes: ["retweet"],
  };
}

const founderCandidate = (username: string) =>
  candidate({
    id: `u-${username}`,
    username,
    name: username,
    followers: 800,
    description: "co-founder, building an open source agent runtime",
    site: "https://example.com",
  });
const amplifierCandidate = (username: string) =>
  candidate({
    id: `u-${username}`,
    username,
    name: username,
    followers: 20_000,
    following: 5_000,
    description: "backend engineer, mostly rust",
  });

vi.mock("../src/_x-harvest.ts", () => ({
  harvestReposters: async () => ({
    candidates: harvestCandidates,
    tweetsScanned: harvestedIds.length,
    stoppedEarly: harvestStoppedEarly,
    harvestedIds,
  }),
}));
vi.mock("../src/_x-cache.ts", () => ({
  saveXHarvest: (h: { engine: string }) => {
    savedHarvests.push(h.engine);
    return "/tmp/x";
  },
  loadXHarvest: () => cachedHarvest,
}));
// Engines never see the network in these tests — harvest is mocked — but the
// finder still constructs one, so give it a creds-free shell.
vi.mock("../src/_x-api.ts", () => ({
  XApiEngine: class {
    meter: unknown;
    constructor(o: { meter: unknown }) {
      this.meter = o.meter;
    }
  },
}));
vi.mock("../src/_x-twitterapiio.ts", () => ({
  TwitterApiIoEngine: class {
    meter: unknown;
    constructor(o: { meter: unknown }) {
      this.meter = o.meter;
    }
  },
}));
vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  qualifyPerson: async () => ({ verdict: stageBVerdict, reason: "stub" }),
}));
vi.mock("../src/_qualify.ts", () => ({
  qualifyPreSpend: async () => ({
    action: stageAAction,
    verdict: stageAAction === "reject" ? "reject" : stageAAction === "defer" ? "transient" : "pass",
    reason: "stage-a stub",
    roleText: null,
    costUsd: 0,
    receiptId: null,
  }),
  persistRoleRejection: (input: { playName: string; dedupeKey: string; reason: string }) => {
    persisted.push({ playName: input.playName, dedupeKey: input.dedupeKey, reason: input.reason });
  },
}));
vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "extract system prompt",
  complete: async () => ({
    content: JSON.stringify({
      name: null,
      company: "Acme",
      role: "CTO",
      email: null,
      angle: "ships agent infra",
    }),
  }),
  tryParseJsonObject: <T>(s: string, fallback: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  },
}));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    deepResearchPerson: async (input: { socialMediaUrl?: string }) => {
      const handle = (input.socialMediaUrl ?? "").split("/").pop() ?? "";
      researchCalls.push(handle);
      const email = emailsByHandle[handle.toLowerCase()];
      return {
        result: {
          cost: 0.05,
          result: {
            enrichment: { displayname: handle, ...(email ? { best_work_email: email } : {}) },
            articles: [],
          },
        },
        receiptId: 1,
      };
    },
    getLedger: () => ({
      isQueueDuplicate: (_play: string, dedupeKey: string) =>
        [...dupHandles].some((h) => dedupeKey.endsWith(`:${h}`)),
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
      recentXHarvestedTweetIds: () => new Set<string>(),
      recordXHarvestedTweets: (ids: string[]) => {
        recordedTweetIds.push(ids);
      },
    }),
  };
});

const { runXRepostersFinder } = await import("../src/x-reposters.ts");

const SEEDS = [{ handle: "iamdevloper", edge: "his audience ships CLIs for fun" }];

beforeEach(() => {
  enqueued.length = 0;
  persisted.length = 0;
  researchCalls.length = 0;
  recordedTweetIds.length = 0;
  savedHarvests.length = 0;
  harvestCandidates = [];
  harvestStoppedEarly = null;
  harvestedIds = ["t-iamdevloper"];
  cachedHarvest = null;
  stageAAction = "proceed";
  stageBVerdict = "pass";
  dupHandles = new Set();
  emailsByHandle = {};
});
afterEach(() => vi.clearAllMocks());

describe("runXRepostersFinder — lane → play routing", () => {
  it("routes a founder-lane pick to x-repost-intro with the repost grounding", async () => {
    harvestCandidates = [founderCandidate("fiona")];
    emailsByHandle = { fiona: "fiona@acme.dev" };
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("x-repost-intro");
    expect(row.dedupeKey).toBe("x-reposters:fiona");
    expect(row.source).toBe("find:x-reposters:@iamdevloper");
    expect(row.payload["email"]).toBe("fiona@acme.dev");
    expect(row.payload["title"]).toBe("CTO");
    expect(row.payload["seedHandle"]).toBe("iamdevloper");
    expect(row.payload["seedEdge"]).toBe("his audience ships CLIs for fun");
    expect(row.payload["tweetUrl"]).toContain("/status/t-iamdevloper");
    expect(row.payload["twitterUrl"]).toBe("https://x.com/fiona");
    expect(typeof row.payload["dossier"]).toBe("string");
  });

  it("routes an amplifier with a findable email to x-amplify, stamping the launch date", async () => {
    harvestCandidates = [amplifierCandidate("amp")];
    emailsByHandle = { amp: "amp@dev.io" };
    await runXRepostersFinder({ dryRun: false, seeds: SEEDS, launchDate: "2026-09-23" });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.playName).toBe("x-amplify");
    expect(enqueued[0]!.payload["launchDate"]).toBe("2026-09-23");
    expect(enqueued[0]!.payload["email"]).toBe("amp@dev.io");
  });

  it("routes an amplifier without an email to the manual x-amplify-dm draft", async () => {
    harvestCandidates = [amplifierCandidate("noemail")];
    await runXRepostersFinder({ dryRun: false, seeds: SEEDS, launchDate: "2026-09-23" });
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("x-amplify-dm");
    expect(row.payload["dmOpen"]).toBe(true);
    expect(row.payload["engine"]).toBe("xapi");
    expect(row.payload["xUserId"]).toBe("u-noemail");
    expect(row.payload["launchDate"]).toBe("2026-09-23");
  });

  it("founder wins when someone qualifies for both lanes", async () => {
    harvestCandidates = [
      candidate({
        id: "u-both",
        username: "both",
        name: "both",
        followers: 30_000,
        description: "founder, building AI dev tools, shipping in public",
        site: "https://example.com",
      }),
    ];
    emailsByHandle = { both: "both@x.dev" };
    await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(enqueued[0]!.playName).toBe("x-repost-intro");
  });

  it("respects the reserved lane split", async () => {
    harvestCandidates = [
      founderCandidate("f1"),
      founderCandidate("f2"),
      amplifierCandidate("a1"),
      amplifierCandidate("a2"),
    ];
    emailsByHandle = { f1: "f1@a.co", f2: "f2@a.co", a1: "a1@a.co", a2: "a2@a.co" };
    const out = await runXRepostersFinder({
      dryRun: false,
      seeds: SEEDS,
      limit: 2,
      laneSplit: 0.5,
      concurrency: 1,
    });
    expect(out.enqueued).toBe(2);
    expect(enqueued.map((r) => r.playName).toSorted()).toEqual(["x-amplify", "x-repost-intro"]);
  });
});

describe("runXRepostersFinder — gates and bookkeeping", () => {
  it("stage-A reject persists a role rejection and spends nothing on research", async () => {
    harvestCandidates = [founderCandidate("rejected")];
    stageAAction = "reject";
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.droppedRole).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.playName).toBe("x-repost-intro");
    expect(researchCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it("stage-A defer (classifier outage) drops WITHOUT persisting, keeping the dedupeKey alive", async () => {
    harvestCandidates = [founderCandidate("deferred")];
    stageAAction = "defer";
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.droppedEnrichment).toBe(1);
    expect(persisted).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it("stage-B reject on the extracted role persists and drops", async () => {
    harvestCandidates = [founderCandidate("bgate")];
    emailsByHandle = { bgate: "b@x.co" };
    stageBVerdict = "reject";
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.droppedRole).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
  });

  it("stage-B transient drops without persisting", async () => {
    harvestCandidates = [founderCandidate("bflaky")];
    emailsByHandle = { bflaky: "b@x.co" };
    stageBVerdict = "transient";
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.droppedEnrichment).toBe(1);
    expect(persisted).toHaveLength(0);
  });

  it("a founder with no findable email is droppedEnrichment — the lane is email-only", async () => {
    harvestCandidates = [founderCandidate("noemail")];
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.droppedEnrichment).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("the shared dedupe key blocks re-enqueue under ANY of the three plays", async () => {
    harvestCandidates = [amplifierCandidate("taken")];
    dupHandles = new Set(["taken"]);
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.droppedDuplicate).toBe(1);
    expect(researchCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it("dry-run counts lane-cleared picks but never researches or enqueues", async () => {
    harvestCandidates = [founderCandidate("f"), amplifierCandidate("a")];
    const out = await runXRepostersFinder({ dryRun: true, seeds: SEEDS });
    expect(out.enqueued).toBe(2);
    expect(researchCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    // The live harvest was still paid for, so it IS recorded.
    expect(recordedTweetIds).toHaveLength(1);
    expect(savedHarvests).toHaveLength(1);
  });

  it("SDK research spend lands in costUsd", async () => {
    harvestCandidates = [amplifierCandidate("amp")];
    emailsByHandle = { amp: "a@b.co" };
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.costUsd).toBeCloseTo(0.05, 5);
  });

  it("a mid-harvest stop surfaces as halted while survivors still enqueue", async () => {
    harvestCandidates = [amplifierCandidate("kept")];
    harvestStoppedEarly = "spend ceiling hit: $1.02 > $1.00";
    emailsByHandle = { kept: "k@b.co" };
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS });
    expect(out.halted).toMatch(/ceiling/);
    expect(out.enqueued).toBe(1);
  });

  it("replay re-scores the cached harvest and never records tweet spend", async () => {
    cachedHarvest = {
      engine: "xapi",
      seeds: ["iamdevloper"],
      tweetsScanned: 1,
      candidates: [amplifierCandidate("cached")],
    };
    emailsByHandle = { cached: "c@d.co" };
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS, replay: true });
    expect(out.enqueued).toBe(1);
    expect(recordedTweetIds).toHaveLength(0);
    expect(savedHarvests).toHaveLength(0);
  });

  it("replay with no cache halts with a pointer instead of spending", async () => {
    cachedHarvest = null;
    const out = await runXRepostersFinder({ dryRun: false, seeds: SEEDS, replay: true });
    expect(out.halted).toMatch(/no cached harvest/);
    expect(out.enqueued).toBe(0);
  });
});
