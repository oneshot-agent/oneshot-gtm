import { describe, expect, it, vi } from "vitest";

// Regression for a shipped review finding on PR #521 (issue #524):
// registry.ts's local-registry readiness trims each `entityTypes` entry
// before checking it against the carrier/broker/freight-forwarder allowlist
// (so " carrier " passes readiness), but `run` filtered the SAME array
// against the raw, untrimmed value — a whitespace-padded value reported
// ready:true yet started with zero FMCSA entityTypes forwarded to the finder.

const runLocalRegistry = vi.fn().mockResolvedValue({
  source: "find:local-registry",
  candidates: 0,
  droppedIcp: 0,
  droppedDuplicate: 0,
  droppedEnrichment: 0,
  enqueued: 0,
  costUsd: 0,
});
vi.mock("../src/local-registry.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/local-registry.ts")>(
    "../src/local-registry.ts",
  );
  return { ...actual, runLocalRegistryFinder: runLocalRegistry };
});

const { TRIGGERS, checkReadiness } = await import("../src/registry.ts");

describe("local-registry trigger entityTypes normalization", () => {
  it("forwards a whitespace-padded entityTypes value that passed readiness", async () => {
    const spec = TRIGGERS.find((t) => t.name === "local-registry")!;
    const config = {
      ...spec.defaultConfig,
      entityTypes: [" carrier "],
      yourEdge: "we set it up for free, you keep it if it works",
    };
    expect(checkReadiness(spec, config)).toEqual({ ready: true });

    await spec.run(config);
    expect(runLocalRegistry).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityTypes: ["carrier"] }),
    );
  });
});
