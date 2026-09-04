import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmailMock = vi.fn();
const upsertProspectMock = vi.fn(() => 99);
const recordSequenceEventMock = vi.fn();
const findProspectByEmailMock = vi.fn<(email: string) => { id: number } | null>();
const listSequenceEventsForProspectPlayMock =
  vi.fn<(pid: number, play: string) => Array<{ step_index: number }>>();
const prospectHasFirstTouchMock = vi.fn<(pid: number) => boolean>();
const getProspectByIdMock = vi.fn<(pid: number) => Record<string, unknown> | null>();
const setProspectIcpVerdictMock = vi.fn();

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
      productOneLiner: "TestProduct",
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
      hasSentSequenceEvent: () => false,
      findProspectByEmail: findProspectByEmailMock,
      // sendDraftedEmail reads the stored ICP verdict before a first touch.
      getProspectById: getProspectByIdMock,
      setProspectIcpVerdict: setProspectIcpVerdictMock,
      listSequenceEventsForProspectPlay: listSequenceEventsForProspectPlayMock,
      prospectHasFirstTouch: prospectHasFirstTouchMock,
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
  prospectHasFirstTouchMock.mockReset().mockReturnValue(false);
  getProspectByIdMock.mockReset().mockReturnValue(null);
  setProspectIcpVerdictMock.mockReset();
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
    listSequenceEventsForProspectPlayMock.mockReturnValue([{ step_index: 1 }, { step_index: 2 }]);
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

  it("H: prospect first-touched by ANOTHER play — cross-play guard fires, no send", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    listSequenceEventsForProspectPlayMock.mockReturnValue([]); // none for THIS play
    prospectHasFirstTouchMock.mockReturnValue(true); // but some play touched them
    const opts = baseOpts();
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(out).toEqual({ receiptIds: [], sent: false });
    expect(opts.flags).toEqual(["already-contacted"]);
  });

  it("I: allowRecontact bypasses the cross-play guard (breakup-revive path)", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    listSequenceEventsForProspectPlayMock.mockReturnValue([]);
    prospectHasFirstTouchMock.mockReturnValue(true);
    const opts = baseOpts({ allowRecontact: true });
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(true);
    expect(opts.flags).toEqual([]);
  });

  it("G: audit context — memo + decisionContext attached to the sendEmail call", async () => {
    findProspectByEmailMock.mockReturnValue(null);
    const opts = baseOpts();
    await sendDraftedEmail(opts);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, ctx] = sendEmailMock.mock.calls[0]!;
    expect(ctx).toMatchObject({
      playName: opts.playName,
      memo: `${opts.playName} step 0 → ${opts.to}`,
      decisionContext: expect.objectContaining({
        source: "play.initial",
        prospectEmail: opts.to,
        subject: opts.draft.subject,
      }),
    });
  });
});

describe("sendDraftedEmail cross-workspace override pass-through", () => {
  it("forwards allowContactedElsewhere to sendEmail only when set", async () => {
    await sendDraftedEmail(baseOpts({ allowContactedElsewhere: true }));
    expect(sendEmailMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowContactedElsewhere: true }),
      expect.anything(),
    );
    await sendDraftedEmail(baseOpts({ to: "other@acme.dev" }));
    const [lastInput] = sendEmailMock.mock.calls.at(-1) as [Record<string, unknown>];
    expect(lastInput).not.toHaveProperty("allowContactedElsewhere");
  });
});

// The person-level ICP gate on the FIRST touch. This check has always existed
// for follow-ups (_cadence.ts, status "off-icp"), but step 0 had none — so 65
// prospects carrying a `reject` verdict were emailed while only 3 cadences ever
// stopped for it.
describe("sendDraftedEmail person-level ICP gate", () => {
  it("blocks a send when the finder's fresh verdict is reject", async () => {
    const opts = baseOpts({
      icp: { verdict: "reject" as const, reason: "Account Executive — hands it to someone else" },
    });
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(out).toEqual({ receiptIds: [], sent: false });
    expect(opts.flags).toEqual(["off-icp"]);
  });

  it("blocks a send when a PRIOR audit stored a reject on the prospect", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    getProspectByIdMock.mockReturnValue({
      id: 7,
      icp_verdict: "reject",
      icp_verdict_reason: "recruiter",
    });
    const opts = baseOpts();
    const out = await sendDraftedEmail(opts);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(out.sent).toBe(false);
    expect(opts.flags).toEqual(["off-icp"]);
  });

  it("FAILS OPEN on unclear and on null — the documented contract", async () => {
    // ledger.ts:1470 is explicit that the cadence gate tests === "reject", so
    // `unclear` fails open exactly as NULL does. This gate must not quietly
    // narrow the funnel on an undecided classifier.
    for (const verdict of ["unclear", "pass"] as const) {
      sendEmailMock.mockClear();
      const out = await sendDraftedEmail(baseOpts({ icp: { verdict, reason: "n/a" } }));
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(out.sent).toBe(true);
    }
    sendEmailMock.mockClear();
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    getProspectByIdMock.mockReturnValue({ id: 7, icp_verdict: null, icp_verdict_reason: null });
    expect((await sendDraftedEmail(baseOpts())).sent).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("persists the verdict the finder already paid to compute", async () => {
    await sendDraftedEmail(baseOpts({ icp: { verdict: "pass" as const, reason: "founder/CTO" } }));
    expect(setProspectIcpVerdictMock).toHaveBeenCalledWith(99, "pass", "founder/CTO");
  });

  it("writes nothing when the play carries no verdict", async () => {
    await sendDraftedEmail(baseOpts());
    expect(setProspectIcpVerdictMock).not.toHaveBeenCalled();
  });

  it("prefers the fresh verdict over a stale stored one", async () => {
    findProspectByEmailMock.mockReturnValue({ id: 7 });
    getProspectByIdMock.mockReturnValue({
      id: 7,
      icp_verdict: "reject",
      icp_verdict_reason: "judged off a bare event role",
    });
    const out = await sendDraftedEmail(
      baseOpts({ icp: { verdict: "pass" as const, reason: "enriched title says Co-Founder" } }),
    );
    expect(out.sent).toBe(true);
  });
});
