import { describe, expect, test } from "vitest";
import { splitSlots } from "../src/_x-lanes.ts";
import type { XLane, XScoredCandidate } from "../src/_x-types.ts";

function sc(lane: XLane, score: number, username = `u${score}`): XScoredCandidate {
  return {
    lane,
    lanes: [lane],
    score,
    why: "why",
    candidate: {
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
        { id: "t", seed: "s", mode: "retweet", text: "t", url: "u", createdAt: "", retweets: 5 },
      ],
      modes: ["retweet"],
    },
  };
}

const many = (lane: XLane, n: number) =>
  Array.from({ length: n }, (_, i) => sc(lane, 100 - i, `${lane}${i}`));

const count = (picks: XScoredCandidate[], lane: XLane) =>
  picks.filter((p) => p.lane === lane).length;

describe("splitSlots", () => {
  test("splits evenly when both lanes are deep", () => {
    const picks = splitSlots([...many("founder", 20), ...many("amplifier", 20)], 14, 0.5);
    expect(picks).toHaveLength(14);
    expect(count(picks, "founder")).toBe(7);
    expect(count(picks, "amplifier")).toBe(7);
  });

  test("a short founder lane spills into amplifiers", () => {
    const picks = splitSlots([...many("founder", 3), ...many("amplifier", 20)], 14, 0.5);
    expect(picks).toHaveLength(14);
    expect(count(picks, "founder")).toBe(3);
    expect(count(picks, "amplifier")).toBe(11);
  });

  test("a short amplifier lane spills into founders", () => {
    const picks = splitSlots([...many("founder", 20), ...many("amplifier", 3)], 14, 0.5);
    expect(count(picks, "founder")).toBe(11);
    expect(count(picks, "amplifier")).toBe(3);
  });

  test("one lane only still fills the list — this was the bug", () => {
    const picks = splitSlots(many("founder", 30), 14, 0.5);
    expect(picks).toHaveLength(14);
    expect(count(picks, "founder")).toBe(14);
  });

  test("takes the best of each lane, not the best overall", () => {
    // Amplifier scores are structurally higher; a global sort would bury founders.
    const scored = [...many("amplifier", 20), sc("founder", 40, "lowFounder")];
    const picks = splitSlots(scored, 4, 0.5);
    expect(picks.map((p) => p.candidate.user.username)).toContain("lowFounder");
  });

  test("fewer candidates than slots returns them all", () => {
    const picks = splitSlots([...many("founder", 2), ...many("amplifier", 2)], 14, 0.5);
    expect(picks).toHaveLength(4);
  });

  test("founders are listed first", () => {
    const picks = splitSlots([...many("founder", 5), ...many("amplifier", 5)], 6, 0.5);
    expect(picks[0]!.lane).toBe("founder");
    expect(picks.at(-1)!.lane).toBe("amplifier");
  });

  test("the share is configurable", () => {
    const picks = splitSlots([...many("founder", 20), ...many("amplifier", 20)], 10, 0.8);
    expect(count(picks, "founder")).toBe(8);
  });
});
