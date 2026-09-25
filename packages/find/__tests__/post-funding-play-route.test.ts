import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotOwnerOperatorBuyer } from "@oneshot-gtm/plays";

// Correction round 1, F-t_1ec69ea6-1/2: exercises post-funding's REAL
// enqueue call site with `play`/`buyerType` routing set, rather than only
// `buildDesignPartnerLoiPayload` in isolation on hand-written input.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
}

const enqueued: EnqueuedRow[] = [];
const dedupeChecks: Array<{ playName: string; dedupeKey: string }> = [];
let queueDuplicateFor: Set<string> = new Set();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    webRead: async () => ({ result: { markdown: "funding announcement body", cost: 0.005 } }),
    webSearch: async () => ({ result: { cost: 0, results: [] } }),
    getLedger: () => ({
      isQueueDuplicate: (playName: string, dedupeKey: string) => {
        dedupeChecks.push({ playName, dedupeKey });
        return queueDuplicateFor.has(playName);
      },
      enqueueTarget: (row: EnqueuedRow) => {
        enqueued.push(row);
        return enqueued.length;
      },
    }),
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async () => ({
      content: JSON.stringify({
        company: "FundedCo",
        companyDomain: "fundedco.example",
        round: "Series A",
        amountUsd: 12_000_000,
        leadInvestor: "Foo Ventures",
        founderName: "Ada Founder",
        founderRole: "CEO",
        industry: "fintech",
        linkedinUrl: null,
        phone: null,
        summary: "raised a Series A",
      }),
      provider: "t",
      model: "t",
    }),
  };
});

vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async () => ({ match: true, reason: "fits" }),
}));

vi.mock("../src/_qualify.ts", () => ({
  qualifyPreSpend: async () => ({ action: "proceed" }),
  persistRoleRejection: () => {},
}));

vi.mock("../src/_contact.ts", () => ({
  resolveVerifyEnrichQualify: async () => ({
    ok: true,
    email: "ada@fundedco.example",
    fullName: "Ada Founder",
    phone: "+15553334444",
    linkedinUrl: "https://linkedin.com/in/ada-founder",
    title: "CEO",
    verdict: "pass",
    verdictReason: "fits",
    costUsd: 0.02,
  }),
  icpFields: () => ({ icpVerdict: "pass", icpVerdictReason: "fits" }),
}));

vi.mock("../src/_linkedin.ts", () => ({
  findLinkedInUrl: async () => null,
  isLinkedInProfileUrl: (u: unknown) =>
    typeof u === "string" && /^https?:\/\/(www\.)?linkedin\.com\/in\//.test(u),
}));

const { runPostFundingFinder } = await import("../src/post-funding.ts");

beforeEach(() => {
  enqueued.length = 0;
  dedupeChecks.length = 0;
  queueDuplicateFor = new Set();
});
afterEach(() => vi.clearAllMocks());

describe("runPostFundingFinder — routed to design-partner-loi (#705)", () => {
  it("persists play_name=design-partner-loi with a payload the play's own guard accepts, `company` from the extracted company", async () => {
    const out = await runPostFundingFinder({
      dryRun: false,
      sourceUrls: ["https://techcrunch.com/fundedco-series-a"],
      yourEdge: "we cut integration time in half",
      play: "design-partner-loi",
      buyerType: "enterprise",
    });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("design-partner-loi");

    const p = row.payload;
    expect(typeof p["name"]).toBe("string");
    expect(typeof p["email"]).toBe("string");
    expect(typeof p["company"]).toBe("string");
    expect(typeof p["buyerType"]).toBe("string");
    expect(() => assertNotOwnerOperatorBuyer(p["buyerType"] as string)).not.toThrow();

    expect(p["company"]).toBe("FundedCo");
    expect(p["email"]).toBe("ada@fundedco.example");
    expect(p["yourEdge"]).toBe("we cut integration time in half");
    expect(p["buyerType"]).toBe("enterprise");

    // Not post-funding's own shape.
    expect(p).not.toHaveProperty("round");
    expect(p).not.toHaveProperty("amountUsd");
    expect(p).not.toHaveProperty("sourceUrl");
  });

  it("with the routing key absent, persists post-funding's own unchanged shape under post-funding's own play", async () => {
    const out = await runPostFundingFinder({
      dryRun: false,
      sourceUrls: ["https://techcrunch.com/fundedco-series-a"],
    });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("post-funding");
    expect(row.payload["round"]).toBe("Series A");
    expect(row.payload).not.toHaveProperty("buyerType");
  });

  it("checks queue dedupe against BOTH post-funding and design-partner-loi regardless of routing", async () => {
    await runPostFundingFinder({
      dryRun: false,
      sourceUrls: ["https://techcrunch.com/fundedco-series-a"],
    });
    const checkedPlays = new Set(dedupeChecks.map((c) => c.playName));
    expect(checkedPlays.has("post-funding")).toBe(true);
    expect(checkedPlays.has("design-partner-loi")).toBe(true);
  });

  it("drops a candidate already queued under the OTHER play — dedupe survives a `play` toggle", async () => {
    queueDuplicateFor = new Set(["design-partner-loi"]);
    const out = await runPostFundingFinder({
      dryRun: false,
      sourceUrls: ["https://techcrunch.com/fundedco-series-a"],
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
    expect(enqueued).toHaveLength(0);
  });
});
