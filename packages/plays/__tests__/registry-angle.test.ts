import { expect, it, vi } from "vitest";
const calls = vi.hoisted(
  () => new Map<string, { draftAngle?: string; dryRun: boolean; queueSource?: string | null }>(),
);
vi.mock("../src/accelerator-batch.ts", () => ({
  runAcceleratorBatch: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runAcceleratorBatch", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/breakup-revive.ts", () => ({
  runBreakupRevive: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runBreakupRevive", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/competitor-switch.ts", () => ({
  runCompetitorSwitch: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runCompetitorSwitch", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/free-pilot.ts", () => ({
  runFreePilot: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runFreePilot", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/discovery-interview.ts", () => ({
  runDiscoveryInterview: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runDiscoveryInterview", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/sources-sought.ts", () => ({
  runSourcesSought: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runSourcesSought", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/civic-pilot.ts", () => ({
  runCivicPilot: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runCivicPilot", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/design-partner-loi.ts", () => ({
  runDesignPartnerLoi: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runDesignPartnerLoi", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/hiring-signal.ts", () => ({
  runHiringSignal: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runHiringSignal", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/multiplier.ts", () => ({
  runMultiplier: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runMultiplier", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/job-change.ts", () => ({
  runJobChange: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runJobChange", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/luma-events.ts", () => ({
  runLumaEvents: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runLumaEvents", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/new-business.ts", () => ({
  runNewBusiness: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runNewBusiness", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/podcast-guest.ts", () => ({
  runPodcastGuest: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runPodcastGuest", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/post-funding.ts", () => ({
  runPostFunding: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runPostFunding", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/profile-intro.ts", () => ({
  runProfileIntro: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runProfileIntro", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/repo-interest.ts", () => ({
  runRepoInterest: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runRepoInterest", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/show-hn.ts", () => ({
  runShowHn: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runShowHn", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/stack-consolidation.ts", () => ({
  runStackConsolidation: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runStackConsolidation", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/x-amplify.ts", () => ({
  runXAmplify: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runXAmplify", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/x-amplify-dm.ts", () => ({
  runXAmplifyDm: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runXAmplifyDm", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/x-repost-intro.ts", () => ({
  runXRepostIntro: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runXRepostIntro", opts);
    return { drafted: [] };
  },
}));
vi.mock("../src/community-reply.ts", () => ({
  runCommunityReply: async (opts: { draftAngle?: string; dryRun: boolean }) => {
    calls.set("runCommunityReply", opts);
    return { drafted: [] };
  },
}));
const { PLAYS } = await import("../src/registry.ts");
it.each(Object.keys(PLAYS))("forwards the selected argument to %s", async (name) => {
  calls.clear();
  await PLAYS[name]!.run({ dryRun: true, targets: [], draftAngle: "user selected argument" });
  expect(calls.size).toBe(1);
  expect([...calls.values()][0]).toMatchObject({
    dryRun: true,
    draftAngle: "user selected argument",
  });
});

// The queue drain and the /queue regenerate route hand the row's `source` to
// the registry; each runner must receive it, or a trigger's own settings (the
// multiplier play's `memberOffer`) never reach the draft in production.
it.each(Object.keys(PLAYS))("forwards the queue row's source to %s", async (name) => {
  calls.clear();
  await PLAYS[name]!.run({ dryRun: true, targets: [], queueSource: "find:orgs:1" });
  expect(calls.size).toBe(1);
  expect([...calls.values()][0]).toMatchObject({ dryRun: true, queueSource: "find:orgs:1" });
});
