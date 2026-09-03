import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProspectRecord } from "@oneshot-gtm/core";
import type { CadenceContext } from "../src/_cadence.ts";

// Verifies the sources-sought play drafts a procedural notice-response email:
// the inputBlock carries the NOTICE NUMBER, NOTICE TYPE and AGENCY, and it
// enrolls a 2-touch cadence (initial + one day-5 follow-up before the
// response window closes).

const calls = {
  llmInputBlocks: [] as string[],
  enrolled: 0,
  upsertedProspects: [] as unknown[],
  step0Events: [] as Array<{ step_index: number; metadata_json: string | null }>,
};

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
      listSequenceEventsForProspectPlay: () => calls.step0Events,
      prospectHasFirstTouch: () => false,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      getCadence: () => null,
      recentSentEmailBodies: () => [],
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
const { getSequence } = await import("../src/_cadence.ts");

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

// round-2 correction, finding PRRT_kwDOSKzrBs6ewQdC: a date-only
// responseDeadline (e.g. "2026-07-01") must remain actionable through the
// END of that calendar day, not just up to midnight UTC at its start.
describe("sources-sought follow-up step — deadline gate", () => {
  function makeCtx(overrides: Partial<ProspectRecord> = {}): CadenceContext {
    const prospect: ProspectRecord = {
      id: 1,
      name: "Sam",
      email: "sam@acme.dev",
      company: "Acme",
      linkedin_url: null,
      dossier_json: null,
      source: "test",
      created_at: new Date().toISOString(),
      ...overrides,
    } as ProspectRecord;
    return {
      prospect,
      cfg: {
        walletMode: "cdp",
        llmProvider: "openrouter",
        llmModel: "x",
        telemetryEnabled: false,
        founderName: "J",
        founderEmail: null,
        productOneLiner: "does X",
        productDomain: null,
        sendingDomain: null,
        emailProvider: "oneshot" as const,
        emailIdentities: null,
        icpOneLiner: null,
        cadenceOverrides: null,
        founderCredentials: null,
        productPortfolio: null,
        partners: null,
        founderAdmission: null,
        productBrief: null,
        mobileSignature: false,
        timezone: null,
        clientId: null,
      },
      metadata: {},
    } as CadenceContext;
  }

  function withDeadline(responseDeadline: string) {
    calls.step0Events = [{ step_index: 0, metadata_json: JSON.stringify({ responseDeadline }) }];
  }

  afterEach(() => {
    vi.useRealTimers();
    calls.step0Events = [];
  });

  it("still sends the follow-up mid-day on the deadline date itself (date-only string)", async () => {
    // "now" is 20:00 UTC on the deadline date — Date.parse(\"2026-07-01\")
    // resolves to 2026-07-01T00:00:00Z, which is BEFORE this instant. The
    // old `deadlineMs < Date.now()` check treated the entire day as expired.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T20:00:00Z"));
    withDeadline("2026-07-01");
    const step = getSequence("sources-sought")!.steps[0]!;
    const out = await step.builder(makeCtx());
    expect(out).not.toBeNull();
  });

  it("skips the follow-up once the deadline day has fully passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T00:00:01Z"));
    withDeadline("2026-07-01");
    const step = getSequence("sources-sought")!.steps[0]!;
    const out = await step.builder(makeCtx());
    expect(out).toBeNull();
  });
});
