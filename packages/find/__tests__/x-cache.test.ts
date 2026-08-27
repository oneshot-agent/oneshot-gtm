import { beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadXHarvest, saveXHarvest, xHarvestCacheDir } from "../src/_x-cache.ts";
import type { XCandidate } from "../src/_x-types.ts";

const NOW = new Date("2026-08-27T09:00:00Z");

// vitest.setup.ts sandboxes ONESHOT_GTM_HOME, so the cache dir is a temp path;
// wipe it between tests so date-named files don't leak across cases.
beforeEach(() => {
  rmSync(xHarvestCacheDir(), { recursive: true, force: true });
});

const candidate = (username: string): XCandidate => ({
  user: {
    id: "1",
    username,
    name: username,
    description: "bio",
    followers: 5_000,
    following: 500,
    tweetCount: 100,
    dmOpen: true,
    links: [],
  },
  hits: [
    {
      id: "t1",
      seed: "s",
      mode: "retweet",
      text: "t",
      url: "u",
      createdAt: NOW.toISOString(),
      retweets: 5,
    },
  ],
  modes: ["retweet"],
});

describe("x harvest replay cache", () => {
  test("round-trips a harvest so filter changes replay for free", () => {
    saveXHarvest(
      { engine: "twitterapiio", seeds: ["a"], tweetsScanned: 3, candidates: [candidate("x")] },
      NOW,
    );
    const back = loadXHarvest();
    expect(back!.engine).toBe("twitterapiio");
    expect(back!.tweetsScanned).toBe(3);
    expect(back!.candidates[0]!.user.username).toBe("x");
  });

  test("picks the newest day when none is named", () => {
    saveXHarvest(
      { engine: "e", seeds: [], tweetsScanned: 1, candidates: [candidate("old")] },
      new Date("2026-08-01T00:00:00Z"),
    );
    saveXHarvest(
      { engine: "e", seeds: [], tweetsScanned: 1, candidates: [candidate("new")] },
      new Date("2026-08-27T00:00:00Z"),
    );
    expect(loadXHarvest()!.candidates[0]!.user.username).toBe("new");
    expect(loadXHarvest("2026-08-01")!.candidates[0]!.user.username).toBe("old");
  });

  test("a second run the same day overwrites that day's file", () => {
    saveXHarvest(
      { engine: "e", seeds: [], tweetsScanned: 1, candidates: [candidate("first")] },
      NOW,
    );
    saveXHarvest(
      { engine: "e", seeds: [], tweetsScanned: 2, candidates: [candidate("second")] },
      NOW,
    );
    const back = loadXHarvest();
    expect(back!.candidates).toHaveLength(1);
    expect(back!.candidates[0]!.user.username).toBe("second");
  });

  test("no cache is null, not a crash", () => {
    expect(loadXHarvest()).toBeNull();
  });

  test("a corrupt cache is null, not a crash", () => {
    mkdirSync(xHarvestCacheDir(), { recursive: true });
    writeFileSync(join(xHarvestCacheDir(), "2026-08-27.json"), "{ not json");
    expect(loadXHarvest()).toBeNull();
  });
});
