import { describe, expect, it } from "vitest";
import { ACCELERATOR_NAMES, cohortDisplayName } from "../src/accelerator-names.ts";

describe("cohortDisplayName", () => {
  it("keeps YC batch codes in their canonical form", () => {
    expect(cohortDisplayName("yc-s26")).toBe("YC S26");
    expect(cohortDisplayName("YC W25")).toBe("YC W25");
    expect(cohortDisplayName("ycp25")).toBe("YC P25");
    // The long forms the finder accepts keep their batch, never a bare "YC".
    expect(cohortDisplayName("yc-spring-26")).toBe("YC P26");
    expect(cohortDisplayName("yc-winter-2026")).toBe("YC W26");
    expect(cohortDisplayName("yc-f-2025")).toBe("YC F25");
    expect(cohortDisplayName("yc-2026")).toBe("YC");
  });

  it("reads a registry id, with or without a year or batch suffix, as its display name", () => {
    expect(cohortDisplayName("a16z-speedrun-2026")).toBe("a16z speedrun");
    expect(cohortDisplayName("a16z-speedrun")).toBe("a16z speedrun");
    expect(cohortDisplayName("spc-2026-1")).toBe("South Park Commons");
    expect(cohortDisplayName("500-global-2025")).toBe("500 Global");
    expect(cohortDisplayName("AI-Grant-2026")).toBe("AI Grant");
    expect(cohortDisplayName(" antler-2026 ")).toBe("Antler");
  });

  it("never matches a shorter id inside a longer word", () => {
    // "neo" is a registry id; "neon-labs" is not that accelerator.
    expect(cohortDisplayName("neon-labs-2026")).toBe("Neon Labs");
  });

  it("humanises an unknown slug instead of passing it through", () => {
    expect(cohortDisplayName("foo-labs-2026")).toBe("Foo Labs");
    expect(cohortDisplayName("acme_ventures_batch_3")).toBe("Acme Ventures Batch");
    expect(cohortDisplayName("Orbit Fellowship")).toBe("Orbit Fellowship");
    expect(cohortDisplayName("2026")).toBe("2026");
    expect(cohortDisplayName("   ")).toBe("");
  });

  it("never renders a raw slug for any registry cohort", () => {
    for (const id of Object.keys(ACCELERATOR_NAMES)) {
      const label = cohortDisplayName(`${id}-2026`);
      expect(label, id).not.toMatch(/-|2026/);
    }
  });
});
