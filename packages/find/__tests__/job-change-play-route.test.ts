import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotOwnerOperatorBuyer } from "@oneshot-gtm/plays";

// Correction round 1, F-t_1ec69ea6-1/2: no committed test previously drove
// job-change through a REAL run with `play`/`buyerType` set and inspected
// what actually lands in target_queue. This exercises the finder's real
// call site (not `buildDesignPartnerLoiPayload` as a pure function on
// hand-written input) so a wrong field mapping — e.g. `company` silently
// coming from the wrong extract field — would fail here.

interface EnqueuedRow {
  playName: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  source: string;
  priority?: unknown;
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
            url: "https://techcrunch.com/kim-joins-newco",
            title: "Kim joined as VP Engineering",
            description: "Kim joined NewCo as VP Engineering",
          },
        ],
      },
    }),
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
        fullName: "Kim Extracted",
        newRole: "VP Engineering",
        newCompany: "NewCo Industries",
        newCompanyDomain: "newco.example",
        previousRole: "Director",
        previousCompany: "OldCo",
        linkedinUrl: null,
        phone: null,
        summary: "moved to NewCo",
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
    email: "kim@newco.example",
    fullName: "Kim Extracted",
    phone: "+15551234567",
    linkedinUrl: "https://linkedin.com/in/kim-extracted",
    title: "Head of Platform",
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

const { runJobChangeFinder } = await import("../src/job-change.ts");

beforeEach(() => {
  enqueued.length = 0;
  dedupeChecks.length = 0;
  queueDuplicateFor = new Set();
});
afterEach(() => vi.clearAllMocks());

describe("runJobChangeFinder — routed to design-partner-loi (#705)", () => {
  it("persists play_name=design-partner-loi with a payload the play's own guard accepts, correctly mapping `company` from the NEW company (not the extracted person fields)", async () => {
    const out = await runJobChangeFinder({
      dryRun: false,
      yourEdge: "unused-own-play-edge",
      play: "design-partner-loi",
      buyerType: "enterprise",
    });
    expect(out.enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("design-partner-loi");

    const p = row.payload;
    // Required DesignPartnerLoiTarget fields, and the play's own runtime
    // guard must accept the persisted buyerType before any paid call.
    expect(typeof p["name"]).toBe("string");
    expect(typeof p["email"]).toBe("string");
    expect(typeof p["company"]).toBe("string");
    expect(typeof p["buyerType"]).toBe("string");
    expect(typeof p["yourEdge"]).toBe("string");
    expect(() => assertNotOwnerOperatorBuyer(p["buyerType"] as string)).not.toThrow();

    // The non-obvious mapping the review flagged as unmeasured: company comes
    // from `target.newCompany` (the new employer), not the person's name/old
    // company/role — a helper test on hand-written input can't catch a finder
    // wiring the wrong field here.
    expect(p["company"]).toBe("NewCo Industries");
    expect(p["email"]).toBe("kim@newco.example");
    expect(p["buyerType"]).toBe("enterprise");

    // The routed payload is DesignPartnerLoiTarget-shaped, not JobChangeTarget
    // — it must not carry job-change's own fields.
    expect(p).not.toHaveProperty("newRole");
    expect(p).not.toHaveProperty("newCompany");
    expect(p).not.toHaveProperty("previousCompany");
  });

  it("with the routing key absent, persists the unchanged job-change shape under job-change's own play — today's behaviour", async () => {
    const out = await runJobChangeFinder({ dryRun: false, yourEdge: "the pitch angle" });
    expect(out.enqueued).toBe(1);
    const row = enqueued[0]!;
    expect(row.playName).toBe("job-change");
    expect(row.payload["newCompany"]).toBe("NewCo Industries");
    expect(row.payload["newRole"]).toBe("VP Engineering");
    expect(row.payload).not.toHaveProperty("buyerType");
  });

  it("checks queue dedupe against BOTH job-change and design-partner-loi regardless of routing (F-t_1ec69ea6-2)", async () => {
    await runJobChangeFinder({ dryRun: false, yourEdge: "x" });
    const checkedPlays = new Set(dedupeChecks.map((c) => c.playName));
    expect(checkedPlays.has("job-change")).toBe(true);
    expect(checkedPlays.has("design-partner-loi")).toBe(true);
  });

  it("drops a candidate already queued under the OTHER play — dedupe survives a `play` toggle in either direction", async () => {
    // Candidate already sitting under design-partner-loi; this run's own
    // play is job-change (routing absent) — must still be treated as a dup.
    queueDuplicateFor = new Set(["design-partner-loi"]);
    const out = await runJobChangeFinder({ dryRun: false, yourEdge: "x" });
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
    expect(enqueued).toHaveLength(0);
  });

  it("drops a candidate already queued under job-change even when THIS run routes to design-partner-loi", async () => {
    queueDuplicateFor = new Set(["job-change"]);
    const out = await runJobChangeFinder({
      dryRun: false,
      yourEdge: "x",
      play: "design-partner-loi",
      buyerType: "enterprise",
    });
    expect(out.enqueued).toBe(0);
    expect(out.droppedDuplicate).toBe(1);
  });
});
