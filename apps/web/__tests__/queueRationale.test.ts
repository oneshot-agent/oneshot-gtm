import { describe, expect, it } from "vitest";
import { fitReasonFor, rationaleLine } from "../src/lib/queueRationale.ts";

// Issue #592: the row's sentence is `<signal> — <fitReason>`, and it must
// never render a dangling dash.

describe("fitReasonFor", () => {
  it("reads a non-blank string and nothing else", () => {
    expect(fitReasonFor({ fitReason: " Sells scheduling to dental clinics. " })).toBe(
      "Sells scheduling to dental clinics.",
    );
    expect(fitReasonFor({ fitReason: "   " })).toBeNull();
    expect(fitReasonFor({ fitReason: 42 })).toBeNull();
    expect(fitReasonFor({})).toBeNull();
    expect(fitReasonFor(null)).toBeNull();
    expect(fitReasonFor(["x"])).toBeNull();
  });
});

describe("rationaleLine", () => {
  it("joins signal and fit reason with an em dash", () => {
    expect(
      rationaleLine("accelerator-batch", {
        cohortLabel: "YC Summer 2026",
        fitReason: "Early-stage vertical SaaS selling to technical B2B teams.",
      }),
    ).toBe("cohort YC Summer 2026 — Early-stage vertical SaaS selling to technical B2B teams.");
  });

  it("falls back to whichever half exists, never a dangling dash", () => {
    expect(rationaleLine("accelerator-batch", { cohort: "yc-s26" })).toBe("cohort yc-s26");
    expect(rationaleLine("luma-events", { fitReason: "CTO of a B2B startup." })).toBe(
      "CTO of a B2B startup.",
    );
    expect(rationaleLine("luma-events", {})).toBeNull();
    expect(rationaleLine("a-play-that-does-not-exist", { fitReason: "  " })).toBeNull();
  });

  it("collapses identical halves to one copy", () => {
    expect(rationaleLine("show-hn", { postTitle: "Show HN: X", fitReason: "Show HN: X" })).toBe(
      "Show HN: X",
    );
  });
});
