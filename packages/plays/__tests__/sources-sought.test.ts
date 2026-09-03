import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies the sources-sought play drafts a procedural notice-response email:
// the inputBlock carries the NOTICE NUMBER, NOTICE TYPE and AGENCY, and it
// enrolls a 2-touch cadence (initial + one day-5 follow-up before the
// response window closes).

const calls = { llmInputBlocks: [] as string[], enrolled: 0, upsertedProspects: [] as unknown[] };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      founderName: "Founder",
      productOneLiner: "thing",
      productDomain: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: "test",
    }),
    enrichProfile: async () => ({ result: { profile: {} }, receiptId: 1 }),
    sendEmail: async () => ({ receiptId: 3 }),
    getLedger: () => ({
      upsertProspect: (meta: unknown) => {
        calls.upsertedProspects.push(meta);
        return 1;
      },
      recordSequenceEvent: () => 1,
      hasSentSequenceEvent: () => false,
      findProspectByEmail: () => ({ id: 1 }),
      listSequenceEventsForProspectPlay: () => [],
      prospectHasFirstTouch: () => false,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      enrollCadence: () => {
        calls.enrolled++;
      },
    }),
    receiptUrlForId: (id: number) => `oneshot://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      calls.llmInputBlocks.push(input.messages.find((m) => m.role === "user")?.content ?? "");
      return { content: JSON.stringify({ subject: "s", body: "b" }), provider: "t", model: "t" };
    },
  };
});

const { runSourcesSought } = await import("../src/sources-sought.ts");

const base = {
  name: "Pat Officer",
  email: "pat.officer@agency.gov",
  agency: "General Services Administration",
  noticeNumber: "W912DY-26-R-0042",
  noticeType: "Sources Sought",
  noticeTitle: "AI-assisted document review platform",
  yourEdge: "we've built the exact document-extraction pipeline this notice describes",
} as const;

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.enrolled = 0;
  calls.upsertedProspects = [];
});
afterEach(() => vi.clearAllMocks());

describe("runSourcesSought", () => {
  it("names the notice number and agency in the input block", async () => {
    await runSourcesSought({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain("NOTICE NUMBER: W912DY-26-R-0042");
    expect(calls.llmInputBlocks[0]).toContain("NOTICE TYPE: Sources Sought");
    expect(calls.llmInputBlocks[0]).toContain(
      "PROSPECT: Pat Officer at General Services Administration",
    );
  });

  it("includes the requirement summary when set, defaults gracefully when absent", async () => {
    await runSourcesSought({
      dryRun: true,
      targets: [{ ...base, requirementSummary: "OCR pipeline for 50k documents/month" }],
    });
    expect(calls.llmInputBlocks[0]).toContain(
      "REQUIREMENT SUMMARY: OCR pipeline for 50k documents/month",
    );

    calls.llmInputBlocks = [];
    await runSourcesSought({ dryRun: true, targets: [{ ...base }] });
    expect(calls.llmInputBlocks[0]).toContain("(not captured in the notice extract)");
  });

  it("enrolls a cadence on a real send (day-5 follow-up before the window closes)", async () => {
    const out = await runSourcesSought({ dryRun: false, targets: [{ ...base }] });
    expect(out.drafted).toHaveLength(1);
    expect(out.drafted[0]?.sent).toBe(true);
    expect(calls.enrolled).toBe(1);
  });

  // finding PRRT_kwDOSKzrBs6fD-h0 / issue #463: title generically flows
  // target -> prospectMeta via _run-play.ts's runner (mirrors the /queue
  // route's prospectMeta), same mechanism as accelerator-batch etc. — no
  // per-play `title: t.title` line needed in prospectMeta itself.
  it("persists the POC's title generically via the shared runner", async () => {
    await runSourcesSought({
      dryRun: false,
      targets: [{ ...base, title: "Contracting Officer" }],
    });
    expect(calls.upsertedProspects[0]).toMatchObject({ title: "Contracting Officer" });
  });

  it("carries the response deadline into metadata for the follow-up gate", async () => {
    await runSourcesSought({
      dryRun: false,
      targets: [{ ...base, responseDeadline: "2026-07-01" }],
    });
    expect(calls.llmInputBlocks[0]).toContain("RESPONSE DEADLINE: 2026-07-01");
  });
});
