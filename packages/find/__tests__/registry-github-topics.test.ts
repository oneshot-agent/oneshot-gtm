import { describe, expect, it, vi } from "vitest";

// Readiness and the run must read `vendors` and `minVendors` the same way, or
// a config reports ready and then runs with values that can never match.
const finderCalls: Array<Record<string, unknown>> = [];
vi.mock("../src/github-topics.ts", () => ({
  runGitHubTopicsFinder: async (opts: Record<string, unknown>) => {
    finderCalls.push(opts);
    return {
      source: "find:github-topics",
      candidates: 0,
      droppedIcp: 0,
      droppedDuplicate: 0,
      droppedEnrichment: 0,
      enqueued: 0,
      costUsd: 0,
    };
  },
}));

const { checkReadiness, githubTopicsMinVendors, githubTopicsVendors, TRIGGERS } =
  await import("../src/registry.ts");

describe("github-topics vendors and minVendors", () => {
  it("normalizes vendor names: trimmed, blanks and case-duplicates dropped, first spelling kept", () => {
    expect(
      githubTopicsVendors({ vendors: [" Datadog ", "datadog", "", "  ", 7, "sentry "] }),
    ).toEqual(["Datadog", "sentry"]);
    expect(githubTopicsVendors({ vendors: "datadog" })).toEqual([]);
    expect(githubTopicsVendors({})).toEqual([]);
  });

  it("reads minVendors from a number or a numeric string, at least 1, default 2", () => {
    expect(githubTopicsMinVendors({})).toBe(2);
    expect(githubTopicsMinVendors({ minVendors: 3 })).toBe(3);
    expect(githubTopicsMinVendors({ minVendors: "3" })).toBe(3);
    expect(githubTopicsMinVendors({ minVendors: 2.7 })).toBe(2);
    expect(githubTopicsMinVendors({ minVendors: 0 })).toBe(1);
    expect(githubTopicsMinVendors({ minVendors: "many" })).toBe(2);
    expect(githubTopicsMinVendors({ minVendors: "" })).toBe(2);
    expect(githubTopicsMinVendors({ minVendors: null })).toBe(2);
  });

  it("the run gets the same vendors and minVendors that readiness checked", async () => {
    const spec = TRIGGERS.find((t) => t.name === "github-topics")!;
    const cfg = {
      ...spec.defaultConfig,
      topics: ["observability"],
      vendors: ["datadog ", " Sentry", "sentry", "newrelic"],
      minVendors: "3",
      yourEdge: "an edge",
    };
    expect(checkReadiness(spec, cfg)).toEqual({ ready: true });
    finderCalls.length = 0;
    await spec.run(cfg);
    expect(finderCalls).toHaveLength(1);
    expect(finderCalls[0]!["vendors"]).toEqual(["datadog", "Sentry", "newrelic"]);
    expect(finderCalls[0]!["minVendors"]).toBe(3);
  });
});
