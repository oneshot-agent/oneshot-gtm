import { describe, expect, it } from "vitest";
import {
  acceleratorBatchMetadata,
  lumaEventsMetadata,
  playMetadata,
  postFundingMetadata,
  repoInterestMetadata,
} from "../src/_metadata.ts";

// The registry exists so the /queue send-draft route stamps the SAME step-0
// metadata as runEmailPlay. Before it, queue sends stored {subject, body} only
// — 178 of 351 repo-interest rows had no `repo` key, which mis-routed 19
// prospects into the wrong arm of the LinkedIn A/B experiment.

describe("playMetadata — lookup by play name", () => {
  it("produces the evidence key from a raw queue payload", () => {
    expect(playMetadata("repo-interest", { repo: "ComposioHQ/trustclaw", name: "Ada" })).toEqual({
      repo: "ComposioHQ/trustclaw",
    });
    expect(
      playMetadata("luma-events", {
        eventTitle: "Memory & Mayhem",
        eventUrl: "https://luma.com/x",
        eventDate: "2026-08-30",
      }),
    ).toEqual({
      eventTitle: "Memory & Mayhem",
      eventUrl: "https://luma.com/x",
      eventDate: "2026-08-30",
    });
    expect(playMetadata("stack-consolidation", { vendorStack: "Playwright, Tavily" })).toEqual({
      vendorStack: "Playwright, Tavily",
    });
  });

  it("returns {} for plays with no evidence metadata", () => {
    // profile-intro / breakup-revive define no metadata; unknown names are the
    // same case. {subject, body} still lands via sendDraftedEmail's base.
    expect(playMetadata("profile-intro", { name: "Ada" })).toEqual({});
    expect(playMetadata("not-a-play", {})).toEqual({});
  });

  it("strips missing keys instead of storing JSON nulls", () => {
    // Downstream readers (expandi-sync buildSignal, the cadence sweep) test
    // key PRESENCE; a stored null would read as "evidence exists but is null".
    expect(playMetadata("repo-interest", { name: "Ada" })).toEqual({});
    expect(playMetadata("post-funding", { round: "Seed" })).toEqual({ round: "Seed" });
  });

  it("keeps numeric fields numeric", () => {
    expect(playMetadata("post-funding", { round: "A", amountUsd: 12_000_000 })).toEqual({
      round: "A",
      amountUsd: 12_000_000,
    });
  });
});

describe("shared fns are what the play defs reference", () => {
  // The defs import these exact functions, so equality here is equality there.
  // These assertions pin the shape a typed target produces — if a play's
  // target fields are renamed, this fails alongside the def's typecheck.
  it("repo-interest", () => {
    expect(repoInterestMetadata({ repo: "a/b" })).toEqual({ repo: "a/b" });
  });
  it("luma-events tolerates a target with extra fields", () => {
    expect(
      lumaEventsMetadata({
        name: "Ada",
        email: "a@b.c",
        eventTitle: "T",
        eventUrl: "u",
        eventDate: "d",
        yourEdge: "e",
      }),
    ).toEqual({ eventTitle: "T", eventUrl: "u", eventDate: "d" });
  });
  it("post-funding null-fills absent fields at the fn level (registry strips them)", () => {
    expect(postFundingMetadata({ round: "Seed" })).toEqual({
      round: "Seed",
      amountUsd: null,
      leadInvestor: null,
    });
  });
  it("accelerator-batch reads senderCohort off the payload (no run-opts in queue context)", () => {
    expect(acceleratorBatchMetadata({ senderCohort: "yc-w26", cohort: "spc-1" })).toEqual({
      senderCohort: "yc-w26",
      prospectCohort: "spc-1",
    });
  });
});
