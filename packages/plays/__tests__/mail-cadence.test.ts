import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";
let ledger: Ledger;
let mailConfig: Record<
  string,
  { position: number; delayDays: number; mode?: "automatic" | "always" } | null
> = {};
const sendMail = vi.fn();
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({ cadenceOverrides: null, directMailMotions: mailConfig }),
    sendDirectMail: (...args: unknown[]) => sendMail(...args),
  };
});
const {
  registerSequence,
  effectiveSequence,
  enrollInCadence,
  captureCadencePlans,
  applyCadencePlans,
  nextStepInfo,
  runCadenceStepForProspect,
  skipDirectMailStep,
  getPriorStepsForProspect,
  sendDirectMailCadenceStep,
  sendCadenceStepBatch,
} = await import("../src/_cadence.ts");
const PLAY = "__mail-cadence";
beforeEach(() => {
  ledger = new Ledger(":memory:");
  mailConfig = {};
  sendMail.mockReset();
  registerSequence({
    playName: PLAY,
    steps: [1, 2, 3].map((i) => ({
      dayOffset: i + 2,
      channel: "email",
      label: `touch ${i}`,
      breakOnReply: true,
      builder: async () => ({ kind: "email", subject: "hello", body: "hello" }),
    })),
  });
});
afterEach(() => ledger.close());
function enroll() {
  const id = ledger.upsertProspect({ name: "Recipient" });
  enrollInCadence({ prospectId: id, playName: PLAY });
  return id;
}
function configure(position: number | null) {
  const before = captureCadencePlans(PLAY);
  mailConfig = position ? { [PLAY]: { position, delayDays: 3 } } : {};
  applyCadencePlans(PLAY, before);
}
function step(id: number) {
  return nextStepInfo(PLAY, ledger.getCadence(id, PLAY)!.current_step, id);
}
describe("optional motion mail steps", () => {
  it("automatically includes mail only for reachable prospects and honors an off override", () => {
    registerSequence({
      playName: "new-business",
      steps: [{ channel: "email", dayOffset: 5, breakOnReply: true, builder: async () => null }],
    });
    const address = {
      name: "Jane",
      address_line1: "1 Main St",
      address_city: "Boston",
      address_state: "MA",
      address_zip: "02110",
      address_country: "US" as const,
    };
    const reachable = ledger.upsertProspect({
      name: "Jane",
      company: "Acme",
      businessAddress: address,
    });
    const missing = ledger.upsertProspect({ name: "Missing", company: "Acme" });
    enrollInCadence({ prospectId: reachable, playName: "new-business" });
    enrollInCadence({ prospectId: missing, playName: "new-business" });
    expect(effectiveSequence("new-business", reachable)?.steps[0]?.channel).toBe("direct_mail");
    expect(effectiveSequence("new-business", missing)?.steps[0]?.channel).toBe("email");
    // Address collection can add mail to an existing cadence whose first step is still ahead.
    ledger.setMailAddress(`prospect:${missing}`, { ...address, name: "Missing" });
    applyCadencePlans("new-business", captureCadencePlans("new-business"));
    expect(effectiveSequence("new-business", missing)?.steps[0]?.channel).toBe("direct_mail");
    const before = captureCadencePlans("new-business");
    mailConfig["new-business"] = null;
    applyCadencePlans("new-business", before);
    expect(effectiveSequence("new-business", reachable)?.steps[0]?.channel).toBe("email");
    expect(effectiveSequence("new-business")?.steps).toHaveLength(1);
  });
  it("moves letter preparation without leaving stale content at the previous index", () => {
    configure(2);
    const id = enroll();
    const c = ledger.getCadence(id, PLAY)!;
    ledger.saveMailPreparation(id, PLAY, c.enrolled_at, 1, { mode: "generated", body: "Original" });
    configure(3);
    expect(ledger.getMailPreparation(id, PLAY, c.enrolled_at, 1)).toBeNull();
    ledger.saveMailPreparation(id, PLAY, c.enrolled_at, 2, { mode: "generated", body: "Revised" });
    configure(2);
    expect(ledger.getMailPreparation(id, PLAY, c.enrolled_at, 1)?.body).toBe("Revised");
    expect(ledger.getMailPreparation(id, PLAY, c.enrolled_at, 2)).toBeNull();
  });
  it("lets one-touch email motions opt into mail as step two", () => {
    registerSequence({ playName: PLAY, steps: [] });
    const untouched = ledger.upsertProspect({ name: "One touch" });
    enrollInCadence({ prospectId: untouched, playName: PLAY });
    expect(ledger.getCadence(untouched, PLAY)).toBeNull();
    configure(2);
    const id = enroll();
    expect(step(id)?.channel).toBe("direct_mail");
    expect(effectiveSequence(PLAY, id)?.steps).toHaveLength(1);
  });

  it.each([2, 3, 4, 5])(
    "inserts at position %i without replacing any existing touch",
    (position) => {
      configure(position);
      const id = enroll();
      const steps = effectiveSequence(PLAY, id)!.steps;
      expect(steps).toHaveLength(4);
      expect(steps[position - 2]!.channel).toBe("direct_mail");
      expect(steps.filter((s) => s.channel === "email").map((s) => s.label)).toEqual([
        "touch 1",
        "touch 2",
        "touch 3",
      ]);
    },
  );
  it("does not change a motion unless it is selected", () => {
    mailConfig = { other: { position: 2, delayDays: 3 } };
    expect(effectiveSequence(PLAY)!.steps.every((s) => s.channel === "email")).toBe(true);
  });
  it("updates eligible active prospects and preserves prospects past the insertion point and completed prospects", () => {
    const ahead = enroll(),
      past = enroll(),
      completed = enroll();
    ledger.advanceCadence({ prospectId: past, playName: PLAY, newStep: 2, nextDueAt: null });
    ledger.setCadenceStatus({ prospectId: completed, playName: PLAY, status: "completed" });
    configure(3);
    expect(effectiveSequence(PLAY, ahead)!.steps).toHaveLength(4);
    expect(effectiveSequence(PLAY, past)!.steps).toHaveLength(3);
    expect(step(past)?.label).toBe("touch 3");
    expect(effectiveSequence(PLAY, completed)!.steps).toHaveLength(3);
  });
  it("does not remap a step sent just before a crash", () => {
    const id = enroll();
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: PLAY,
      stepIndex: 1,
      channel: "email",
      status: "sent",
    });
    configure(2);
    expect(step(id)?.channel).toBe("email");
    expect(ledger.hasSentSequenceEvent(id, PLAY, 1)).toBe(true);
  });
  it("keeps mail pending without an address or individual approval, then explicitly skips to the original next touch", async () => {
    configure(2);
    const id = enroll();
    const result = await runCadenceStepForProspect({
      prospectId: id,
      playName: PLAY,
      dryRun: false,
    });
    expect(result.action).toBe("skipped");
    expect(result.note).toContain("individual review");
    expect(ledger.getCadence(id, PLAY)!.current_step).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    skipDirectMailStep({ prospectId: id, playName: PLAY });
    expect(step(id)?.label).toBe("touch 1");
    expect(ledger.getCadence(id, PLAY)!.current_step).toBe(1);
    // #610: the skip is part of the history, and never a send.
    const events = ledger.listSequenceEventsForProspectPlay(id, PLAY);
    expect(events.map((e) => [e.step_index, e.channel, e.status])).toEqual([
      [1, "direct_mail", "skipped"],
    ]);
    expect(getPriorStepsForProspect(id, PLAY)).toMatchObject([
      { stepIndex: 1, label: "letter skipped", body: null, status: "skipped" },
    ]);
    expect(ledger.hasSentSequenceEvent(id, PLAY, 1)).toBe(false);
    expect(ledger.countSends({ playName: PLAY })).toBe(0);
    expect(ledger.eventsByPlay().find((r) => r.play_name === PLAY)?.sent ?? 0).toBe(0);
    expect(ledger.listSequenceEventsForProspect(id)).toEqual([]);
  });
  it("prevents batches from dispatching reviewed mail; individual accepted orders advance exactly once", async () => {
    configure(2);
    const id = enroll(),
      c = ledger.getCadence(id, PLAY)!;
    const draft = {
      id: "mail",
      prospectId: id,
      playName: PLAY,
      enrollment: c.enrolled_at,
      stepIndex: 1,
      started: true,
      sendKey: "key",
      order: { order_id: "order", order_status: "accepted" },
    } as any;
    ledger.saveDirectMail(draft);
    ledger.setCadenceDraft({
      prospectId: id,
      playName: PLAY,
      draft: {
        subject: "mail",
        body: "mail",
        flags: [],
        payload: { kind: "direct_mail", draftId: "mail" },
      },
    });
    await sendCadenceStepBatch([{ prospectId: id, playName: PLAY }]);
    expect(sendMail).not.toHaveBeenCalled();
    sendMail.mockResolvedValue(draft);
    expect((await sendDirectMailCadenceStep("mail")).action).toBe("step-sent");
    expect(step(id)?.label).toBe("touch 1");
    expect(Date.parse(ledger.getCadence(id, PLAY)!.next_due_at!) - Date.now()).toBeGreaterThan(
      10 * 86400000,
    );
    await sendDirectMailCadenceStep("mail");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(
      ledger.listSequenceEventsForProspectPlay(id, PLAY).filter((s) => s.channel === "direct_mail"),
    ).toHaveLength(1);
  });
  it("keeps a prepared mailpiece bound to its original enrollment when motion settings change", () => {
    configure(2);
    const id = enroll(),
      c = ledger.getCadence(id, PLAY)!;
    ledger.saveDirectMail({
      id: "mail",
      prospectId: id,
      playName: PLAY,
      enrollment: c.enrolled_at,
      stepIndex: 1,
    } as any);
    configure(4);
    expect(step(id)?.channel).toBe("direct_mail");
    expect(ledger.findDirectMail(id, PLAY, c.enrolled_at, 1)?.id).toBe("mail");
  });
});
