import { beforeEach, describe, expect, it, vi } from "vitest";

// Newsfeed capture: recent posts bought once per profile, one call at a time,
// kept in the paid cache, and only a pointer on the dossier. The rules that
// matter: a 429 waits and retries (never a verdict), a transient failure is
// never negative-cached, cache-only never calls, and no post text reaches the
// dossier.

const state = {
  calls: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  behaviour: [] as Array<"ok" | "429" | "transient" | "genuine" | "hang">,
  queue: new Map<number, { id: number; payload_json: string }>(),
  patches: [] as Array<{ id: number; patch: Record<string, unknown> }>,
  prospects: new Map<
    number,
    {
      id: number;
      linkedin_url: string | null;
      source_profile_url: string | null;
      dossier_json: string | null;
    }
  >(),
  halves: [] as Array<{ id: number; value: Record<string, unknown> }>,
  ceilingReached: false,
};

const POSTS = {
  status: "completed",
  cost: 0.07,
  request_id: "req_nf",
  result: [
    {
      platform: "linkedin",
      content: "Shipped v2 today.",
      posted_at: "2026-09-20T10:00:00Z",
      likes: 12,
    },
    { platform: "linkedin", content: "Hiring a founding AE.", posted_at: "2026-09-25T09:00:00Z" },
  ],
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    NEWSFEED_DEADLINE_MS: 25,
    logEvent: () => {},
    dailySpendStatus: () => ({ ceilingReached: state.ceilingReached }),
    // The real paid cache in front of a fake purchase, as in the wrapper.
    personNewsfeed: (
      input: { socialMediaUrl: string },
      _ctx: unknown,
      cache?: import("@oneshot-gtm/core").PaidCacheOptions,
    ) =>
      actual.withPaidCache("research.newsfeed", input, cache, async () => {
        state.calls.push(input.socialMediaUrl);
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        try {
          await new Promise((r) => setTimeout(r, 2));
          const b = state.behaviour.shift() ?? "ok";
          if (b === "429") {
            throw Object.assign(new Error("Tool request failed"), {
              statusCode: 429,
              responseBody: JSON.stringify({ error: "rate_limit_exceeded", retry_after: 60 }),
            });
          }
          if (b === "transient") throw new Error("Tool request failed");
          if (b === "genuine") throw new Error("profile not found");
          if (b === "hang") await new Promise((r) => setTimeout(r, 200));
          return { result: POSTS, receiptId: 5 };
        } finally {
          state.inFlight--;
        }
      }),
    getLedger: () => ({
      getQueueRow: (id: number) => state.queue.get(id) ?? null,
      patchLiveQueuePayload: (p: { id: number; patch: Record<string, unknown> }) => {
        state.patches.push(p);
        return true;
      },
      getProspectById: (id: number) => state.prospects.get(id) ?? null,
      mergeProspectDossierHalf: (id: number, _half: string, value: Record<string, unknown>) =>
        state.halves.push({ id, value }),
    }),
  };
});

const nf = await import("../src/_newsfeed.ts");
const core = await import("@oneshot-gtm/core");
const CTX = { playName: "test-play" };
const LI = "https://www.linkedin.com/in/pat-lee";

/** What the paid cache holds for a profile's feed: "ok", "failed", or null. */
function stored(url: string): string | null {
  return core.readPaidCache("research.newsfeed", { socialMediaUrl: url })?.status ?? null;
}

beforeEach(() => {
  state.calls = [];
  state.inFlight = 0;
  state.maxInFlight = 0;
  state.behaviour = [];
  core._resetPaidCache();
  state.queue = new Map();
  state.patches = [];
  state.prospects = new Map();
  state.halves = [];
  state.ceilingReached = false;
  nf._resetNewsfeed();
  nf._setNewsfeedSleep(async () => {});
});

describe("newsfeedSeedUrl", () => {
  it("prefers a LinkedIn profile, then an X profile, and nothing else", () => {
    expect(
      nf.newsfeedSeedUrl([
        "https://github.com/pat",
        "https://x.com/PatLee",
        "linkedin.com/in/Pat-Lee/",
      ]),
    ).toBe(LI);
    expect(nf.newsfeedSeedUrl(["https://github.com/pat", "https://twitter.com/PatLee"])).toBe(
      "https://x.com/patlee",
    );
    expect(nf.newsfeedSeedUrl(["https://github.com/pat", "https://lu.ma/user/pat"])).toBeNull();
  });

  it("rejects X pages that are not profiles", () => {
    expect(nf.canonicalXProfileUrl("https://x.com/pat/status/123")).toBeNull();
    expect(nf.canonicalXProfileUrl("https://x.com/home")).toBeNull();
    expect(nf.canonicalXProfileUrl("https://www.linkedin.com/company/acme")).toBeNull();
  });

  it("takes the dossier's provider LinkedIn URL for a GitHub-seeded row", () => {
    const payload = {
      githubUrl: "https://github.com/pat",
      personResearch: { version: 1, status: "partial", organizations: [], linkedinUrl: LI },
    };
    expect(nf.newsfeedSeedForPayload(payload)).toBe(LI);
  });
});

describe("safePersonNewsfeed", () => {
  it("captures, caches under the profile key, and marks X reposts", async () => {
    const out = await nf.safePersonNewsfeed(LI, CTX);
    expect(out.status).toBe("captured");
    if (out.status !== "captured") return;
    expect(out.costUsd).toBe(0.07);
    expect(out.feed.posts).toHaveLength(2);
    expect(stored(LI)).toBe("ok");
    expect(nf.getCachedNewsfeed("linkedin.com/in/pat-lee")?.posts).toHaveLength(2);

    const again = await nf.safePersonNewsfeed(LI, CTX);
    expect(again.status === "captured" && again.cached).toBe(true);
    expect(state.calls).toHaveLength(1);
  });

  it("marks a retweet as a repost", () => {
    const input = { socialMediaUrl: "https://x.com/pat" };
    core.getSharedDb().setPaidCache({
      key: core.paidCacheKey("research.newsfeed", input),
      callType: "research.newsfeed",
      status: "ok",
      resultJson: JSON.stringify({
        result: [{ platform: "twitter", content: "RT @someone: hi" }],
      }),
      costUsd: 0.07,
    });
    expect(nf.getCachedNewsfeed("https://x.com/pat")?.posts[0]?.isRepost).toBe(true);
  });

  it("waits out a 429 and retries, at most twice, and never negative-caches it", async () => {
    const slept: number[] = [];
    nf._setNewsfeedSleep(async (ms) => {
      slept.push(ms);
    });
    state.behaviour = ["429", "ok"];
    const ok = await nf.safePersonNewsfeed(LI, CTX);
    expect(ok.status).toBe("captured");
    expect(slept).toEqual([60_000]);

    nf._resetNewsfeed();
    core._resetPaidCache();
    state.behaviour = ["429", "429", "429"];
    const out = await nf.safePersonNewsfeed(LI, CTX);
    expect(out).toMatchObject({ status: "failed", transient: true });
    expect(state.calls.length).toBe(2 + 3);
    expect(stored(LI)).toBeNull();
  });

  it("negative-caches only a genuine failure", async () => {
    state.behaviour = ["transient"];
    await nf.safePersonNewsfeed(LI, CTX);
    expect(stored(LI)).toBeNull();
    state.behaviour = ["genuine"];
    await nf.safePersonNewsfeed(LI, CTX);
    expect(stored(LI)).toBe("failed");
    // The negative entry answers the next call without buying.
    expect(await nf.safePersonNewsfeed(LI, CTX)).toMatchObject({
      status: "failed",
      transient: false,
    });
    expect(state.calls).toHaveLength(2);
  });

  it("gives up at the deadline but still caches the paid result", async () => {
    state.behaviour = ["hang"];
    const out = await nf.safePersonNewsfeed(LI, CTX);
    expect(out).toMatchObject({ status: "failed", transient: true });
    await new Promise((r) => setTimeout(r, 250));
    expect(stored(LI)).toBe("ok");
  });

  it("holds the slot until a call abandoned at the deadline settles", async () => {
    state.behaviour = ["hang", "ok"];
    const [first, second] = await Promise.all([
      nf.safePersonNewsfeed("https://www.linkedin.com/in/a", CTX),
      nf.safePersonNewsfeed("https://www.linkedin.com/in/b", CTX),
    ]);
    expect(first.status).toBe("failed");
    expect(second.status).toBe("captured");
    // The second call never overlapped the one still running past its deadline.
    expect(state.maxInFlight).toBe(1);
  });

  it("runs one call at a time whatever the caller's concurrency", async () => {
    await Promise.all(
      ["a", "b", "c", "d"].map((h) =>
        nf.safePersonNewsfeed(`https://www.linkedin.com/in/${h}`, CTX),
      ),
    );
    expect(state.calls).toHaveLength(4);
    expect(state.maxInFlight).toBe(1);
  });

  it("cache-only never calls; a cost cap, the spend ceiling and an open breaker skip", async () => {
    expect(await nf.safePersonNewsfeed(LI, CTX, { cacheOnly: true })).toMatchObject({
      status: "skipped",
      reason: "not-cached",
    });
    expect(await nf.safePersonNewsfeed(LI, CTX, { remainingUsd: 0.05 })).toMatchObject({
      status: "skipped",
      reason: "cost-cap",
    });
    state.ceilingReached = true;
    expect(await nf.safePersonNewsfeed(LI, CTX)).toMatchObject({ reason: "spend-ceiling" });
    state.ceilingReached = false;
    state.behaviour = ["transient", "transient", "transient"];
    for (const h of ["a", "b", "c"])
      await nf.safePersonNewsfeed(`https://www.linkedin.com/in/${h}`, CTX);
    expect(nf.isNewsfeedCircuitOpen()).toBe(true);
    expect(await nf.safePersonNewsfeed(LI, CTX)).toMatchObject({ reason: "circuit-open" });
    expect(state.calls).toHaveLength(3);
  });
});

describe("pointer on the dossier", () => {
  it("patches only the pointer into a queue row's personResearch, never the posts", async () => {
    state.queue.set(7, {
      id: 7,
      payload_json: JSON.stringify({
        linkedinUrl: LI,
        personResearch: { version: 1, status: "partial", organizations: [] },
      }),
    });
    const out = await nf.captureNewsfeedForQueueRow(7, "test-play");
    expect(out?.attached).toBe(true);
    const patch = state.patches[0]!.patch["personResearch"] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["newsfeed"]);
    expect(patch["newsfeed"]).toEqual({
      url: LI,
      fetchedAt: expect.any(String),
      count: 2,
      newestAt: "2026-09-25T09:00:00.000Z",
    });
    expect(JSON.stringify(state.patches)).not.toContain("Shipped v2");
  });

  it("still reports the paid capture when the pointer write throws", async () => {
    state.queue.set(9, {
      id: 9,
      payload_json: JSON.stringify({
        linkedinUrl: LI,
        personResearch: { version: 1, status: "partial", organizations: [] },
      }),
    });
    const throwing = state.patches;
    state.patches = new Proxy(throwing, {
      get(target, prop) {
        if (prop === "push") {
          return () => {
            throw new Error("database is locked");
          };
        }
        return Reflect.get(target, prop);
      },
    });
    const out = await nf.captureNewsfeedForQueueRow(9, "test-play");
    state.patches = throwing;
    expect(out?.attached).toBe(false);
    expect(out?.outcome).toMatchObject({ status: "captured", costUsd: 0.07 });
  });

  it("keeps posts in the cache only for a row without a dossier", async () => {
    state.queue.set(8, { id: 8, payload_json: JSON.stringify({ linkedinUrl: LI }) });
    const out = await nf.captureNewsfeedForQueueRow(8, "test-play");
    expect(out?.attached).toBe(false);
    expect(state.patches).toEqual([]);
    expect(stored(LI)).toBe("ok");
  });

  it("writes the pointer into a researched prospect's person half", async () => {
    state.prospects.set(3, {
      id: 3,
      linkedin_url: null,
      source_profile_url: "https://github.com/pat",
      dossier_json: JSON.stringify({
        person: { source: "deepResearchPerson", title: "CTO", linkedinUrl: LI },
        product: null,
      }),
    });
    const out = await nf.captureNewsfeedForProspect(3, "research-prospects");
    expect(out?.attached).toBe(true);
    expect(state.halves[0]!.value).toMatchObject({ source: "deepResearchPerson", title: "CTO" });
    expect((state.halves[0]!.value["newsfeed"] as { count: number }).count).toBe(2);
  });
});
