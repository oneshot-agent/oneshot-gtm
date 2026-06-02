import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmailMock = vi.fn();
const upsertProspectMock = vi.fn(() => 99);
const recordSequenceEventMock = vi.fn();
const findProspectByEmailMock = vi.fn<(email: string) => { id: number } | null>();
const listSequenceEventsForProspectPlayMock =
  vi.fn<(pid: number, play: string) => Array<{ step_index: number }>>();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "test",
      telemetryEnabled: false,
      founderName: "J",
      founderEmail: "j@x.dev",
      productOneLiner: "OneShot",
      productDomain: null,
      sendingDomain: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: false,
      clientId: null,
    }),
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
    getLedger: () => ({
      upsertProspect: upsertProspectMock,
      recordSequenceEvent: recordSequenceEventMock,
      findProspectByEmail: findProspectByEmailMock,
      listSequenceEventsForProspectPlay: listSequenceEventsForProspectPlayMock,
    }),
    receiptUrlForId: (id: number) => `local://receipt/${id}`,
  };
});

const { sendDraftedEmail } = await import("../src/_lib.ts");

function baseOpts(overrides: Partial<Parameters<typeof sendDraftedEmail>[0]> = {}) {
  return {
    playName: "stack-consolidation",
    to: "sam@acme.dev",
    draft: { subject: "s", body: "b" },
    flags: [] as string[],
    prospectMeta: {
      name: "Sam",
      email: "sam@acme.dev",
      company: "Acme",
      linkedin_url: null,
      phone: null,
      source: "test",
    },
    metadata: {},
    dryRun: false,
    ...overrides,
  };
}

beforeEach(() => {
  sendEmailMock.mockReset().mockResolvedValue({ receiptId: 42 });
  upsertProspectMock.mockReset().mockReturnValue(99);
  recordSequenceEventMock.mockReset();
  findProspectByEmailMock.mockReset().mockReturnValue(null);
  listSequenceEventsForProspectPlayMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendDraftedEmail pre-send cadence check", () => {
  it("A: prospect unknown — guard passes, sendEmail called once", async () => {
    findProspectByEmailMock.mockReturnValue(null);
    const opts = baseOpts();
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(recordSequenceEventMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ receiptIds: [42], sent: true });
    expect(opts.flags).toEqual([]);
  });

  it("B: prospect found + prior step-0 send — guard fires, sendEmail NOT called", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    listSequenceEventsForProspectPlayMock.mockReturnValue([{ step_index: 0 }]);
    const opts = baseOpts();
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(recordSequenceEventMock).not.toHaveBeenCalled();
    expect(out).toEqual({ receiptIds: [], sent: false });
    expect(opts.flags).toEqual(["already-enrolled"]);
  });

  it("C: prospect found but only step-≥1 events (follow-ups only, no original) — guard passes", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    listSequenceEventsForProspectPlayMock.mockReturnValue([
      { step_index: 1 },
      { step_index: 2 },
    ]);
    const opts = baseOpts();
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(true);
    expect(opts.flags).toEqual([]);
  });

  it("D: dryRun — guard not invoked, sendEmail not called", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    listSequenceEventsForProspectPlayMock.mockReturnValue([{ step_index: 0 }]);
    const opts = baseOpts({ dryRun: true });
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(findProspectByEmailMock).not.toHaveBeenCalled();
    expect(out).toEqual({ receiptIds: [], sent: false });
    expect(opts.flags).toEqual([]);
  });

  it("E: prospect has a step-0 event marked 'replied' — guard still fires (don't re-mail a replier)", async () => {
    // listSequenceEventsForProspectPlay already filters to status IN
    // ('sent','delivered','replied') at the SQL layer, so a replied row
    // shows up here as a normal step-0 entry. The guard must treat it the
    // same as 'sent' — re-sending step 0 to someone who's already replied
    // is the worst-flavor duplicate (lands as a fresh thread, in their
    // face, while they're already mid-conversation).
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    listSequenceEventsForProspectPlayMock.mockReturnValue([{ step_index: 0 }]);
    const opts = baseOpts();
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(out.sent).toBe(false);
    expect(opts.flags).toEqual(["already-enrolled"]);
  });

  it("F: incoming lint flags already non-empty — short-circuits before guard (existing behavior)", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    listSequenceEventsForProspectPlayMock.mockReturnValue([{ step_index: 0 }]);
    const opts = baseOpts({ flags: ["ai-vocab"] });
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(findProspectByEmailMock).not.toHaveBeenCalled();
    expect(out.sent).toBe(false);
    expect(opts.flags).toEqual(["ai-vocab"]); // unchanged
  });
});
