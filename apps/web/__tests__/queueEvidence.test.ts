import { describe, expect, it } from "vitest";
import { queueEvidence } from "../src/lib/queueEvidence.ts";

describe("queueEvidence", () => {
  it("prints the post title for show-hn", () => {
    expect(queueEvidence("show-hn", { postTitle: "Show HN: Cutter", postUrl: "https://x" })).toBe(
      "Show HN: Cutter",
    );
  });

  it("prints round and amount for post-funding", () => {
    expect(queueEvidence("post-funding", { round: "Seed", amount: "$4.2M" })).toBe(
      "raised Seed · $4.2M",
    );
  });

  // The seeded ledger carries a pre-formatted string; the live finder carries
  // a number. Both have to read the same on the row.
  it("formats a numeric amountUsd", () => {
    expect(queueEvidence("post-funding", { round: "Series A", amountUsd: 12_000_000 })).toBe(
      "raised Series A · $12.0M",
    );
    expect(queueEvidence("post-funding", { round: "Pre-seed", amountUsd: 750_000 })).toBe(
      "raised Pre-seed · $750k",
    );
  });

  it("drops the amount rather than the round when only the round is known", () => {
    expect(queueEvidence("post-funding", { round: "Seed" })).toBe("raised Seed");
  });

  // `role` means the open req here and the person's new job on job-change.
  // Labelling either with the other's word would put a false line on the page,
  // which is why this is keyed off the play and not off the payload keys.
  it("reads role as the open req on hiring-signal", () => {
    expect(queueEvidence("hiring-signal", { role: "Founding Reliability Engineer" })).toBe(
      "hiring: Founding Reliability Engineer",
    );
  });

  it("reads job-change as a move", () => {
    expect(
      queueEvidence("job-change", {
        previousCompany: "Stripe",
        newRole: "Head of Platform",
        newCompany: "Acme Data",
      }),
    ).toBe("Stripe → Head of Platform at Acme Data");
    expect(queueEvidence("job-change", { previousCompany: "Stripe" })).toBe("left Stripe");
  });

  it("names the show for podcast-guest, from either field name", () => {
    expect(
      queueEvidence("podcast-guest", { podcast: "Latent Space", episodeTitle: "Agents" }),
    ).toBe("Latent Space: Agents");
    expect(queueEvidence("podcast-guest", { podcastName: "Latent Space" })).toBe(
      "guest on Latent Space",
    );
  });

  // The finder writes `jobTitle`; the seeded ledger writes `role`. Reading only
  // one left every real hiring-signal row with no evidence line.
  it("reads the opening from either field on hiring-signal", () => {
    expect(queueEvidence("hiring-signal", { jobTitle: "Staff SRE" })).toBe("hiring: Staff SRE");
    expect(queueEvidence("hiring-signal", { role: "Staff SRE" })).toBe("hiring: Staff SRE");
  });

  it("covers the plays the first draft missed", () => {
    expect(queueEvidence("stack-consolidation", { vendorStack: "Datadog + Honeycomb" })).toBe(
      "runs Datadog + Honeycomb",
    );
    expect(queueEvidence("breakup-revive", { daysCold: 94 })).toBe("94d cold");
    expect(queueEvidence("x-amplify", { seedHandle: "@patio11", followers: 12_400 })).toBe(
      "reposted @patio11 · 12.4k followers",
    );
    expect(
      queueEvidence("x-repost-intro", { seedHandle: "@patio11", mode: "quote", followers: 800 }),
    ).toBe("quoted @patio11 · 800 followers");
  });

  it("names the lead investor when the finder found one", () => {
    expect(
      queueEvidence("post-funding", {
        round: "Series A",
        amountUsd: 14_000_000,
        leadInvestor: "a16z",
      }),
    ).toBe("raised Series A · $14.0M · led by a16z");
  });

  it("covers the remaining plays", () => {
    expect(queueEvidence("competitor-switch", { competitor: "Datadog" })).toBe("on Datadog");
    expect(queueEvidence("luma-events", { eventTitle: "SF Infra Night" })).toBe("SF Infra Night");
    expect(queueEvidence("github-stars", { repo: "temporalio/temporal" })).toBe(
      "starred temporalio/temporal",
    );
    expect(queueEvidence("repo-interest", { repoLabel: "temporal", repo: "x/y" })).toBe(
      "starred temporal",
    );
    expect(queueEvidence("accelerator-batch", { cohort: "W25" })).toBe("cohort W25");
  });

  // Total by construction: a row whose payload lost a field, or a play this
  // does not know, renders without a line rather than with a broken one.
  it("returns null rather than a half-built line", () => {
    expect(queueEvidence("show-hn", {})).toBeNull();
    expect(queueEvidence("hiring-signal", { role: "   " })).toBeNull();
    expect(queueEvidence("a-play-that-does-not-exist", { postTitle: "x" })).toBeNull();
    expect(queueEvidence("show-hn", null)).toBeNull();
    expect(queueEvidence("show-hn", "not an object")).toBeNull();
    expect(queueEvidence("show-hn", ["array"])).toBeNull();
    expect(queueEvidence("post-funding", { round: "Seed", amountUsd: 0 })).toBe("raised Seed");
  });
});

/*
 * The queue row and the priority scorer read the same payloads, and the row's
 * first draft drifted from the scorer immediately — wrong field on one play,
 * five plays missing entirely. This pins them together: every play the scorer
 * knows how to read must also render an evidence line.
 */
describe("coverage against the priority adapters", () => {
  it("handles every play the scorer has an adapter for", async () => {
    const src = await Bun.file(
      new URL("../../../packages/find/src/_priority-adapters.ts", import.meta.url),
    ).text();
    const adapters = [...src.matchAll(/^ {2}"([a-z0-9-]+)":/gm)].map((m) => m[1]!);
    expect(adapters.length).toBeGreaterThan(10);

    // A payload carrying every field any adapter reads, so a play that is
    // handled returns something and a play that is missing returns null.
    const kitchenSink = {
      postTitle: "t",
      round: "Seed",
      amountUsd: 1_000_000,
      newRole: "r",
      newCompany: "c",
      jobTitle: "j",
      podcast: "p",
      episodeTitle: "e",
      cohort: "W25",
      eventTitle: "ev",
      vendorStack: "s",
      competitor: "x",
      repo: "r/r",
      daysCold: 30,
      seedHandle: "@h",
      followers: 2000,
      role: "role",
      sourceLabel: "NYC business licenses",
      businessType: "HVAC contractor",
    };

    const unhandled = adapters.filter((play) => queueEvidence(play, kitchenSink) === null);
    expect(unhandled).toEqual([]);
  });
});
