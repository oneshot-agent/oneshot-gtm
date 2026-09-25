import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotOwnerOperatorBuyer } from "@oneshot-gtm/plays";

// Correction round 1, F-t_1ec69ea6-1/2: exercises hiring-signal's REAL
// enqueue call site with `play`/`buyerType` routing set, rather than only
// `buildDesignPartnerLoiPayload` in isolation. hiring-signal is the one
// finder whose readiness edge key is `yourClaim`, not `yourEdge` — and the
// review specifically flagged `yourEdge` being fed from `yourClaim` as a
// non-obvious mapping a helper test cannot catch.

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
    webSearch: async () => ({
      result: {
        cost: 0.01,
        results: [
          {
            url: "https://boards.greenhouse.io/acme/jobs/1",
            title: "Staff Engineer at Acme",
            description: "Acme is hiring a Staff Engineer",
          },
        ],
      },
    }),
    webRead: async () => ({ result: { markdown: "job posting body", cost: 0.005 } }),
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
        jobTitle: "Staff Engineer",
        jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
        company: "Acme Corp",
        companyDomain: "acme.example",
        hiringManagerName: "Sam Hiring Manager",
        hiringManagerRole: "VP Engineering",
        team: "Platform",
        postedAt: "2026-09-01",
        linkedinUrl: null,
        phone: null,
        summary: "hiring a staff engineer",
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
    email: "sam@acme.example",
    fullName: "Sam Hiring Manager",
    phone: "+15559876543",
    linkedinUrl: "https://linkedin.com/in/sam-hm",
    title: "VP Engineering",
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

const { runHiringSignalFinder } = await import("../src/hiring-signal.ts");

beforeEach(() => {
  enqueued.length = 0;
  dedupeChecks.length = 0;
  queueDuplicateFor = new Set();
});
afterEach(() => vi.clearAllMocks());

describe("runHiringSignalFinder — routed to design-partner-loi (#705)", () => {
  it("persists play_name=design-partner-loi with `yourEdge` fed from `yourClaim` (the non-obvious mapping), and `company` from the finder's extract", async () => {
    const out = await runHiringSignalFinder({
      dryRun: false,
      yourClaim: "we cut onboarding time in half",
      play: "design-partner-loi",
      buyerType: "government",
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

    // The mapping the review flagged: yourClaim (hiring-signal's own field
    // name) must feed yourEdge (DesignPartnerLoiTarget's field name).
    expect(p["yourEdge"]).toBe("we cut onboarding time in half");
    expect(p["company"]).toBe("Acme Corp");
    expect(p["email"]).toBe("sam@acme.example");
    expect(p["buyerType"]).toBe("government");

    // Not hiring-signal's own shape.
    expect(p).not.toHaveProperty("jobTitle");
    expect(p).not.toHaveProperty("jobPostUrl");
    expect(p).not.toHaveProperty("yourClaim");
  });

  it("with the routing key absent, persists hiring-signal's own unchanged shape under hiring-signal's own play", async () => {
    const out = await runHiringSignalFinder({ dryRun: false, yourClaim: "the claim" });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("hiring-signal");
    expect(row.payload["jobTitle"]).toBe("Staff Engineer");
    expect(row.payload["yourClaim"]).toBe("the claim");
    expect(row.payload).not.toHaveProperty("buyerType");
  });

  it("checks queue dedupe against BOTH hiring-signal and design-partner-loi regardless of routing", async () => {
    await runHiringSignalFinder({ dryRun: false, yourClaim: "x" });
    const checkedPlays = new Set(dedupeChecks.map((c) => c.playName));
    expect(checkedPlays.has("hiring-signal")).toBe(true);
    expect(checkedPlays.has("design-partner-loi")).toBe(true);
  });

  it("drops a candidate already queued under the OTHER play — dedupe survives a `play` toggle", async () => {
    queueDuplicateFor = new Set(["design-partner-loi"]);
    const out = await runHiringSignalFinder({ dryRun: false, yourClaim: "x" });
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
    expect(enqueued).toHaveLength(0);
  });
});
