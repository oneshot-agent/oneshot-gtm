import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotOwnerOperatorBuyer } from "@oneshot-gtm/plays";

// Correction round 1, F-t_1ec69ea6-1/2: exercises podcast-guest's REAL
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
    webSearch: async () => ({
      result: {
        cost: 0.01,
        results: [
          {
            url: "https://latent.space/p/pat-episode",
            title: "Pat on Latent Space",
            description: "Pat talks about agents in prod",
          },
        ],
      },
    }),
    webRead: async () => ({ result: { markdown: "episode notes", cost: 0.005 } }),
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
        podcastName: "Latent Space",
        episodeTitle: "Agents in prod",
        episodeUrl: "https://latent.space/p/pat-episode",
        guestName: "Pat Guest",
        guestRole: "CTO",
        guestCompany: "GuestCo Systems",
        guestCompanyDomain: "guestco.example",
        publishedAt: "2026-09-01",
        linkedinUrl: null,
        phone: null,
        summary: "we rebuilt outbound",
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
    email: "pat@guestco.example",
    fullName: "Pat Guest",
    phone: "+15551112222",
    linkedinUrl: "https://linkedin.com/in/pat-guest",
    title: "CTO",
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

const { runPodcastGuestFinder } = await import("../src/podcast-guest.ts");

beforeEach(() => {
  enqueued.length = 0;
  dedupeChecks.length = 0;
  queueDuplicateFor = new Set();
});
afterEach(() => vi.clearAllMocks());

describe("runPodcastGuestFinder — routed to design-partner-loi (#705)", () => {
  it("persists play_name=design-partner-loi with a payload the play's own guard accepts, `company` from guestCompany, `yourEdge` from the trigger's own yourEdge", async () => {
    const out = await runPodcastGuestFinder({
      dryRun: false,
      yourEdge: "we cut deploy time in half",
      play: "design-partner-loi",
      buyerType: "hardware",
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

    expect(p["company"]).toBe("GuestCo Systems");
    expect(p["email"]).toBe("pat@guestco.example");
    expect(p["yourEdge"]).toBe("we cut deploy time in half");
    expect(p["buyerType"]).toBe("hardware");

    // Not podcast-guest's own shape.
    expect(p).not.toHaveProperty("podcast");
    expect(p).not.toHaveProperty("hookQuote");
    expect(p).not.toHaveProperty("episodeTitle");
  });

  it("with the routing key absent, persists podcast-guest's own unchanged shape under podcast-guest's own play", async () => {
    const out = await runPodcastGuestFinder({ dryRun: false });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("podcast-guest");
    expect(row.payload["podcast"]).toBe("Latent Space");
    expect(row.payload).not.toHaveProperty("buyerType");
  });

  it("checks queue dedupe against BOTH podcast-guest and design-partner-loi regardless of routing", async () => {
    await runPodcastGuestFinder({ dryRun: false });
    const checkedPlays = new Set(dedupeChecks.map((c) => c.playName));
    expect(checkedPlays.has("podcast-guest")).toBe(true);
    expect(checkedPlays.has("design-partner-loi")).toBe(true);
  });

  it("drops a candidate already queued under the OTHER play — dedupe survives a `play` toggle", async () => {
    queueDuplicateFor = new Set(["design-partner-loi"]);
    const out = await runPodcastGuestFinder({ dryRun: false });
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
    expect(enqueued).toHaveLength(0);
  });
});
