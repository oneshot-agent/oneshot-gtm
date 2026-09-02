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

  it("covers the remaining plays", () => {
    expect(queueEvidence("competitor-switch", { competitor: "Datadog" })).toBe("on Datadog");
    expect(queueEvidence("luma-events", { eventTitle: "SF Infra Night" })).toBe("SF Infra Night");
    expect(queueEvidence("github-stars", { repo: "temporalio/temporal" })).toBe(
      "starred temporalio/temporal",
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
