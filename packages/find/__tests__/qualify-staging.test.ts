import { beforeEach, describe, expect, it, vi } from "vitest";

// Staging rules for the person gate. The money question is WHEN stage C
// (a paid enrichProfile) fires: it must fire on `unclear` and on missing role
// text, and on nothing else. It must never fire at stage A, because stage B
// is free and a candidate whose email fails verification never gets there.

/** Verdicts the mocked classifier hands back, in order. */
let verdictQueue: string[] = [];
let enrichCalls = 0;
let enrichTitle: string | null = "Staff Engineer";
let enrichShouldThrow = false;

vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "prompt",
  tryParseJsonObject: (raw: string, fb: unknown) => {
    try {
      return JSON.parse(raw);
    } catch {
      return fb;
    }
  },
  complete: async () => {
    const verdict = verdictQueue.shift() ?? "pass";
    return { content: JSON.stringify({ verdict, reason: `stub:${verdict}` }) };
  },
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    withDeadline: async (p: Promise<unknown>) => p,
    enrichProfile: async () => {
      enrichCalls++;
      if (enrichShouldThrow) throw new Error("fetch failed");
      return {
        result: { profile: { title: enrichTitle }, cost: 0.005 },
        receiptId: 77,
      };
    },
  };
});

const { qualifyPreSpend, qualifyPostEnrich } = await import("../src/_qualify.ts");
const { _resetBreaker } = await import("../src/_breaker.ts");

const ICP = "Technical founders and engineering leads shipping AI agents";
const BASE = { icp: ICP, playName: "luma-events", fillGaps: true } as const;

beforeEach(() => {
  verdictQueue = [];
  enrichCalls = 0;
  enrichTitle = "Staff Engineer";
  enrichShouldThrow = false;
  _resetBreaker();
});

describe("stage A — pre-spend", () => {
  it("rejects for free before any contact resolution", async () => {
    verdictQueue = ["reject"];
    const r = await qualifyPreSpend({ icp: ICP, person: { roleText: "GTM @AhaCreator" } });
    expect(r.action).toBe("reject");
    expect(r.costUsd).toBe(0);
    expect(enrichCalls).toBe(0);
  });

  it("does NOT pay on `unclear` — it defers to the free stage B", async () => {
    verdictQueue = ["unclear"];
    const r = await qualifyPreSpend({ icp: ICP, person: { roleText: "Manager" } });
    expect(r.action).toBe("proceed");
    expect(enrichCalls).toBe(0);
  });

  it("proceeds without calling the classifier when there is no role text", async () => {
    const r = await qualifyPreSpend({ icp: ICP, person: { roleText: "" } });
    expect(r.action).toBe("proceed");
    expect(r.verdict).toBe("unclear");
  });

  it("downgrades a classifier outage to proceed, not defer — stage B retries free", async () => {
    verdictQueue = ["garbage-verdict"]; // parsed as transient
    const r = await qualifyPreSpend({ icp: ICP, person: { roleText: "Manager" } });
    expect(r.action).toBe("proceed");
  });
});

describe("stage B — post-enrich, free", () => {
  it("passes on the enriched title without buying anything", async () => {
    verdictQueue = ["pass"];
    const r = await qualifyPostEnrich({ ...BASE, person: {}, enrichedTitle: "CTO" });
    expect(r.action).toBe("proceed");
    expect(enrichCalls).toBe(0);
    expect(r.costUsd).toBe(0);
  });

  it("rejects on the enriched title without buying anything", async () => {
    verdictQueue = ["reject"];
    const r = await qualifyPostEnrich({ ...BASE, person: {}, enrichedTitle: "Account Executive" });
    expect(r.action).toBe("reject");
    expect(enrichCalls).toBe(0);
  });

  it("prefers the enriched title over a self-written discovery headline", async () => {
    verdictQueue = ["pass"];
    const r = await qualifyPostEnrich({
      ...BASE,
      person: { roleText: "making sunlight" },
      enrichedTitle: "Principal Software Engineer",
    });
    expect(r.roleText).toBe("Principal Software Engineer");
  });
});

describe("stage C — the paid lookup", () => {
  it("fires on `unclear` and re-judges on the bought title", async () => {
    verdictQueue = ["unclear", "pass"];
    const r = await qualifyPostEnrich({
      ...BASE,
      person: { roleText: "Manager" },
      linkedinUrl: "https://www.linkedin.com/in/x",
    });
    expect(enrichCalls).toBe(1);
    expect(r.action).toBe("proceed");
    expect(r.roleText).toBe("Staff Engineer");
    expect(r.costUsd).toBeCloseTo(0.005);
    expect(r.receiptId).toBe(77);
  });

  it("fires when there is no role text at all", async () => {
    verdictQueue = ["pass"]; // only stage C asks; stage B short-circuits on missing
    const r = await qualifyPostEnrich({
      ...BASE,
      person: {},
      linkedinUrl: "https://www.linkedin.com/in/x",
    });
    expect(enrichCalls).toBe(1);
    expect(r.action).toBe("proceed");
  });

  it("does not fire without a linkedin url — and does not reject", async () => {
    verdictQueue = ["unclear"];
    const r = await qualifyPostEnrich({ ...BASE, person: { roleText: "Manager" } });
    expect(enrichCalls).toBe(0);
    expect(r.action).toBe("proceed");
  });

  it("does not fire when the finder has fill-the-gap disabled", async () => {
    verdictQueue = ["unclear"];
    const r = await qualifyPostEnrich({
      ...BASE,
      fillGaps: false,
      person: { roleText: "Manager" },
      linkedinUrl: "https://www.linkedin.com/in/x",
    });
    expect(enrichCalls).toBe(0);
    expect(r.action).toBe("proceed");
  });

  it("proceeds (never rejects) when the bought title still does not settle it", async () => {
    // Softened 2026-08-25: a genuine coin-flip after buying the real title
    // sends anyway — self-serve product, one email risked vs a prospect lost.
    // Only a positive reject drops. The distinct reason keeps it measurable.
    verdictQueue = ["unclear", "unclear"];
    const r = await qualifyPostEnrich({
      ...BASE,
      person: { roleText: "Manager" },
      linkedinUrl: "https://www.linkedin.com/in/x",
    });
    expect(r.action).toBe("proceed");
    expect(r.reason).toMatch(/unclear-after-enrich/);
  });

  it("defers (never rejects) when the paid lookup itself fails", async () => {
    // Missing data is not evidence of a bad fit. Rejecting here would drop
    // real prospects during an SDK outage and burn their dedupeKeys.
    verdictQueue = ["unclear"];
    enrichShouldThrow = true;
    const r = await qualifyPostEnrich({
      ...BASE,
      person: { roleText: "Manager" },
      linkedinUrl: "https://www.linkedin.com/in/x",
    });
    expect(r.action).toBe("defer");
    expect(r.costUsd).toBe(0);
  });

  it("stays unclear (proceed) when the lookup succeeds but returns no title", async () => {
    verdictQueue = ["unclear"];
    enrichTitle = null;
    const r = await qualifyPostEnrich({
      ...BASE,
      person: { roleText: "Manager" },
      linkedinUrl: "https://www.linkedin.com/in/x",
    });
    expect(enrichCalls).toBe(1);
    expect(r.action).toBe("proceed");
  });
});
