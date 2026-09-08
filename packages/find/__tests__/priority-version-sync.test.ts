import { describe, expect, it } from "vitest";
import { parseProspectPriority } from "@oneshot-gtm/core";
import {
  PRIORITY_COMPONENT_KEYS,
  PRIORITY_WEIGHTS_BY_VERSION,
  type PriorityVersion,
} from "@oneshot-gtm/shared-types";
import { PRIORITY_VERSION, PRIORITY_WEIGHTS, computePriority } from "../src/_priority.ts";

/**
 * The version contract lives in three packages that can't all import each
 * other (web ← shared-types; core is dependency-root; find sees everything).
 * This suite is the drift guard the mirrored copies rely on.
 */
describe("priority version sync", () => {
  const versions = Object.keys(PRIORITY_WEIGHTS_BY_VERSION) as PriorityVersion[];

  it("every declared version round-trips core's validator", () => {
    for (const version of versions) {
      const artifact = {
        version,
        total: 50,
        components: {
          personFit: 50,
          accountFit: 50,
          intentStrength: 50,
          timingFreshness: 50,
          signalConfidence: 50,
          contactability: 50,
        },
        reasons: [],
        finder: "t",
        scoredAt: "2026-09-01T12:00:00.000Z",
      };
      expect(parseProspectPriority(JSON.stringify(artifact)), version).toEqual(artifact);
    }
  });

  it("every version's weights sum to exactly 100", () => {
    for (const version of versions) {
      const sum = Object.values(PRIORITY_WEIGHTS_BY_VERSION[version]).reduce((a, b) => a + b, 0);
      expect(sum, version).toBe(100);
    }
  });

  it("the engine's current version is declared, and its weights are the shared table's", () => {
    expect(versions).toContain(PRIORITY_VERSION);
    expect(PRIORITY_WEIGHTS).toBe(PRIORITY_WEIGHTS_BY_VERSION[PRIORITY_VERSION]);
  });

  it("component keys match the artifact the engine emits", () => {
    const emitted = computePriority("t", {}, new Date("2026-09-01T12:00:00Z"));
    expect(Object.keys(emitted.components).toSorted()).toEqual(
      [...PRIORITY_COMPONENT_KEYS].toSorted(),
    );
  });
});
