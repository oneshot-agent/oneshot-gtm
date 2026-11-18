import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";

// The dialler on a real in-memory ledger: the call step in a cadence, what
// the unattended runner does with it, logging outcomes, the Calls page's
// lists and the brief (the LLM mocked; nothing paid).

let ledger: Ledger;
let cfg: Record<string, unknown> = {};
const responses: string[] = [];
const prompts: string[] = [];
/** Runs while the model is "writing": a cadence that moves on meanwhile. */
let duringComplete: (() => void) | null = null;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => cfg,
    logEvent: () => {},
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => `prompt:${name}`,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      prompts.push(input.messages.map((m) => m.content).join("\n"));
      duringComplete?.();
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      return { content: next, provider: "t", model: "t" };
    },
  };
});

const {
  registerSequence,
  effectiveSequence,
  enrollInCadence,
  applyCadencePlans,
  captureCadencePlans,
  runCadenceStepForProspect,
  previewCadenceStep,
  sendCadenceStep,
  sendCadenceStepBatch,
  CALL_STEP_NOT_SENT,
  PREVIEW_STEP_MOVED,
  isBreakupStepAt,
  threadsIntoIntro,
} = await import("../src/_cadence.ts");
const { recordCall, listCalls, buildCallBrief, callBriefFor, parseCallBrief, callBriefFlags } =
  await import("../src/_calls.ts");

const PLAY = "__calls";
const OTHER_PLAY = "__calls_other";
const DAY = 24 * 3600 * 1000;
const BRIEF_JSON = JSON.stringify({
  opener: "Hi Dana, this is Sam from Widgets. I emailed you last week about renewals.",
  offer: "We get every vendor renewal signed before it lapses.",
  questions: ["How do you track renewals today?", "Who signs them off?"],
  objections: [{ objection: "We already have a tool", answer: "Then I'd ask what it misses." }],
  voicemail: "Hi Dana, Sam from Widgets. Calling about renewals. I'll follow up by email.",
  gatekeeper: "Could you put me through to Dana Smith, please?",
});

function callsOn(position = 3, extra: Record<string, unknown> = {}) {
  cfg = {
    ...cfg,
    calls: { enabled: true, cadenceStep: { position, delayDays: 2, holdDays: 3 }, ...extra },
  };
}

function enroll(phone: string | null = "+15126531187", email = "dana@acme.test"): number {
  const id = ledger.upsertProspect({ name: "Dana Smith", email, phone, company: "Acme" });
  enrollInCadence({ prospectId: id, playName: PLAY });
  return id;
}

/** Move the cadence to its call step (index 1 with the step at position 3), due `agoMs` ago. */
function atCallStep(id: number, agoMs = 0) {
  ledger.advanceCadence({
    prospectId: id,
    playName: PLAY,
    newStep: 1,
    nextDueAt: new Date(Date.now() - agoMs).toISOString(),
  });
}

const cadence = (id: number) => ledger.getCadence(id, PLAY)!;
/** A plan as its email labels, other steps by channel. */
const shape = (seq: { steps: Array<{ channel: string; label?: string | null }> }) =>
  seq.steps.map((s) => (s.channel === "email" ? s.label : s.channel));
const callEvents = (id: number) =>
  ledger.listSequenceEventsForProspectPlay(id, PLAY).filter((e) => e.channel === "call");

beforeEach(() => {
  ledger = new Ledger(":memory:");
  cfg = {
    cadenceOverrides: null,
    directMailMotions: {},
    founderName: "Sam",
    productOneLiner: "Widgets renewals",
    timezone: null,
  };
  responses.length = 0;
  prompts.length = 0;
  duringComplete = null;
  registerSequence({
    playName: PLAY,
    steps: [1, 2, 3].map((i) => ({
      dayOffset: i + 2,
      channel: "email" as const,
      label: `touch ${i}`,
      breakOnReply: true,
      builder: async () => ({ kind: "email" as const, subject: "hello", body: "hello" }),
    })),
  });
});
afterEach(() => ledger.close());

describe("the call step in a sequence", () => {
  it("is placed at the configured position in new plans only", () => {
    callsOn(3);
    const id = enroll();
    const steps = effectiveSequence(PLAY, id)!.steps;
    expect(steps.map((s) => s.channel)).toEqual(["email", "call", "email", "email"]);
    expect(steps[1]).toMatchObject({ id: "call", dayOffset: 2, label: "Call" });
  });

  it("is absent while calls are off or no step is set", () => {
    expect(effectiveSequence(PLAY, enroll())!.steps.every((s) => s.channel === "email")).toBe(true);
    cfg = { ...cfg, calls: { enabled: true } };
    expect(effectiveSequence(PLAY)!.steps.every((s) => s.channel === "email")).toBe(true);
    cfg = { ...cfg, calls: { enabled: false, cadenceStep: { position: 2, delayDays: 1 } } };
    expect(effectiveSequence(PLAY)!.steps.every((s) => s.channel === "email")).toBe(true);
  });

  it("a saved plan resolves the call; turning calls on never adds one to a running cadence", () => {
    const before = enroll(); // enrolled while off
    callsOn(2);
    const after = enroll("+15126531188", "two@acme.test");
    expect(effectiveSequence(PLAY, before)!.steps.some((s) => s.channel === "call")).toBe(false);
    expect(effectiveSequence(PLAY, after)!.steps[0]!.channel).toBe("call");
    // A rebuild (a mail setting change) leaves both as they were.
    applyCadencePlans(PLAY, captureCadencePlans(PLAY));
    expect(effectiveSequence(PLAY, before)!.steps.some((s) => s.channel === "call")).toBe(false);
    expect(effectiveSequence(PLAY, after)!.steps[0]!.channel).toBe("call");
  });
});

describe("the unattended runner on a due call", () => {
  it("waits for the founder", async () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    const out = await runCadenceStepForProspect({ prospectId: id, playName: PLAY, dryRun: false });
    expect(out).toMatchObject({ action: "skipped", note: "Call awaits the founder" });
    expect(cadence(id).current_step).toBe(1);
    expect(callEvents(id)).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("is skipped and the cadence moves on once holdDays pass unlogged", async () => {
    callsOn();
    const id = enroll();
    atCallStep(id, 3 * DAY + 1000);
    const out = await runCadenceStepForProspect({ prospectId: id, playName: PLAY, dryRun: false });
    expect(out.note).toMatch(/call not logged within 3 days — call skipped/);
    expect(cadence(id).current_step).toBe(2);
    expect(callEvents(id)).toMatchObject([{ status: "skipped", step_index: 2 }]);
  });

  it("discards the unused brief when the call is skipped", async () => {
    callsOn();
    const id = enroll();
    atCallStep(id, 3 * DAY + 1000);
    ledger.setCadenceDraft({
      prospectId: id,
      playName: PLAY,
      draft: { subject: "call", body: "brief", flags: [], payload: { kind: "call" } },
    });
    await runCadenceStepForProspect({ prospectId: id, playName: PLAY, dryRun: false });
    expect(ledger.getCadenceDraft({ prospectId: id, playName: PLAY })).toBeNull();
  });

  it("is skipped at once when there is no usable number", async () => {
    callsOn();
    const id = enroll("not a number");
    atCallStep(id);
    const out = await runCadenceStepForProspect({ prospectId: id, playName: PLAY, dryRun: false });
    expect(out.note).toMatch(/prospect has no phone/);
    expect(cadence(id).current_step).toBe(2);
  });

  it("a dry run changes nothing", async () => {
    callsOn();
    const id = enroll(null);
    atCallStep(id);
    await runCadenceStepForProspect({ prospectId: id, playName: PLAY, dryRun: true });
    expect(cadence(id).current_step).toBe(1);
    expect(callEvents(id)).toHaveLength(0);
  });
});

describe("preview and send of a call step", () => {
  it("the preview is the brief; Send refuses, single and batch", async () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    responses.push(BRIEF_JSON);
    const preview = await previewCadenceStep({ prospectId: id, playName: PLAY });
    if (!("payload" in preview)) throw new Error("expected a preview");
    expect(preview.payload).toMatchObject({ kind: "call", toPhone: "+15126531187" });
    expect(preview.subject).toBe("Call brief");
    expect(preview.flags).toEqual([]);
    await expect(sendCadenceStep({ prospectId: id, playName: PLAY })).rejects.toThrow(
      CALL_STEP_NOT_SENT,
    );
    const [batch] = await sendCadenceStepBatch([{ prospectId: id, playName: PLAY }]);
    expect(batch).toMatchObject({ ok: false, error: CALL_STEP_NOT_SENT });
    // The dial panel reads the stored preview: no second completion.
    const brief = await callBriefFor({ prospectId: id, playName: PLAY });
    expect(brief.offer).toBe("We get every vendor renewal signed before it lapses.");
    expect(prompts).toHaveLength(1);
  });
});

describe("recordCall", () => {
  async function due() {
    callsOn();
    const id = enroll();
    atCallStep(id);
    return id;
  }

  it.each(["no_answer", "voicemail", "gatekeeper", "wrong_person"] as const)(
    "%s records the step done and advances the cadence",
    async (outcome) => {
      const id = await due();
      const call = recordCall(id, { outcome, note: "n", durationSec: 30 });
      expect(call).toMatchObject({ outcome, playName: PLAY, durationSec: 30, note: "n" });
      expect(cadence(id)).toMatchObject({ current_step: 2, status: "active" });
      const [event] = callEvents(id);
      expect(event).toMatchObject({ status: "sent", step_index: 2 });
      expect(JSON.parse(event!.metadata_json!)).toMatchObject({ outcome, callId: call.id });
      const touches = ledger.listChannelEventsForProspect(id);
      expect(touches).toMatchObject([{ channel: "call", event_type: "call", source: "call" }]);
    },
  );

  it("wrong_number clears the number, keeps it on the call and advances", async () => {
    const id = await due();
    const call = recordCall(id, { outcome: "wrong_number" });
    expect(ledger.getProspectById(id)!.phone).toBeNull();
    expect(cadence(id).current_step).toBe(2);
    expect(call.outcome).toBe("wrong_number");
    expect(ledger.phoneForCall(id).phone).toBeNull();
  });

  it("interested stops the cadence as replied and marks the call step replied", async () => {
    const id = await due();
    recordCall(id, { outcome: "interested" });
    expect(cadence(id).status).toBe("replied");
    expect(callEvents(id)).toMatchObject([{ status: "replied" }]);
    expect(ledger.listChannelEventsForProspect(id)[0]).toMatchObject({ event_type: "reply" });
  });

  it("meeting_booked also records the meeting", async () => {
    const id = await due();
    recordCall(id, { outcome: "meeting_booked", note: "Thursday 10am" });
    expect(cadence(id).status).toBe("replied");
    expect(ledger.listDealOutcomesForProspect(id)).toMatchObject([
      { outcome: "meeting_booked", play_name: PLAY, notes: "Thursday 10am" },
    ]);
  });

  it("not_interested stops as replied", async () => {
    const id = await due();
    recordCall(id, { outcome: "not_interested" });
    expect(cadence(id).status).toBe("replied");
  });

  it("not_now holds the cadence until the date picked", async () => {
    const id = await due();
    const until = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    recordCall(id, { outcome: "not_now", holdUntil: until });
    const c = cadence(id) as unknown as {
      held_until: string;
      status: string;
      current_step: number;
    };
    expect(c.status).toBe("active");
    expect(c.current_step).toBe(2);
    expect(c.held_until.slice(0, 10)).toBe(until);
  });

  it("do_not_contact unsubscribes and blocks the person everywhere", async () => {
    const id = await due();
    recordCall(id, { outcome: "do_not_contact" });
    expect(cadence(id).status).toBe("unsubscribed");
    expect(ledger.callAllowed(id)).toBe(false);
    expect(listCalls().list.map((r) => r.prospectId)).not.toContain(id);
  });

  it("a call outside a cadence credits the latest email when the person is interested", async () => {
    callsOn();
    const id = enroll();
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: PLAY,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "s", body: "b" },
    });
    const call = recordCall(id, { outcome: "interested" });
    expect(call.playName).toBeNull();
    expect(cadence(id).status).toBe("replied");
    expect(
      ledger.listSequenceEventsForProspectPlay(id, PLAY).find((e) => e.channel === "email")!.status,
    ).toBe("replied");
  });
});

describe("listCalls", () => {
  it("is cheap and empty when calls are off", () => {
    const spy = vi.spyOn(ledger, "listActiveCadences");
    expect(listCalls()).toEqual({
      enabled: false,
      dialMode: "tel",
      window: { start: "09:00", end: "17:00", weekdays: true },
      due: [],
      list: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("lists due call steps (even without a number) apart from the call list", () => {
    callsOn();
    const due = enroll(null);
    atCallStep(due);
    const other = ledger.upsertProspect({
      name: "Other",
      email: "o@b.test",
      phone: "(512) 653-1190",
    });
    const out = listCalls();
    expect(out.due).toMatchObject([
      { prospectId: due, phone: null, section: "due", playName: PLAY },
    ]);
    expect(out.list).toMatchObject([
      { prospectId: other, phone: "+15126531190", section: "list", reason: "has a number" },
    ]);
  });

  it("drops a do-not-contact company and reports the call window", () => {
    callsOn(3, { window: { start: "10:00", end: "12:00" } });
    ledger.upsertProspect({ name: "Blocked", email: "x@blocked.test", phone: "+15126531191" });
    cfg = { ...cfg, doNotContact: { domains: ["blocked.test"] } };
    const out = listCalls(new Date("2026-11-17T15:00:00Z")); // 09:00 in Chicago
    expect(out.list).toEqual([]);
    cfg = { ...cfg, doNotContact: undefined };
    const row = listCalls(new Date("2026-11-17T15:00:00Z")).list[0]!;
    expect(out.window).toEqual({ start: "10:00", end: "12:00", weekdays: true });
    expect(row.local).toMatchObject({
      zones: ["America/Chicago"],
      localTime: "09:00",
      inWindow: false,
      opensAt: "2026-11-17T16:00:00.000Z",
    });
  });

  it("dials by tel: even with a bridge configured: ringing the founder's phone is not built yet", () => {
    callsOn(3, {
      bridge: { provider: "twilio", founderPhone: "+15550001111", callerId: "+15550002222" },
    });
    expect(listCalls().dialMode).toBe("tel");
  });

  it("lists a person due in two plays once per play, each with its step", () => {
    callsOn();
    registerSequence({
      playName: OTHER_PLAY,
      steps: [1, 2, 3].map((i) => ({
        dayOffset: i + 2,
        channel: "email" as const,
        label: `touch ${i}`,
        breakOnReply: true,
        builder: async () => ({ kind: "email" as const, subject: "hello", body: "hello" }),
      })),
    });
    const id = enroll();
    enrollInCadence({ prospectId: id, playName: OTHER_PLAY });
    atCallStep(id);
    ledger.advanceCadence({
      prospectId: id,
      playName: OTHER_PLAY,
      newStep: 1,
      nextDueAt: new Date().toISOString(),
    });
    const out = listCalls();
    expect(out.due.map((r) => [r.prospectId, r.playName, r.currentStep]).toSorted()).toEqual(
      [
        [id, OTHER_PLAY, 1],
        [id, PLAY, 1],
      ].toSorted(),
    );
    expect(out.list.map((r) => r.prospectId)).not.toContain(id);
  });
});

describe("the call brief", () => {
  const prospect = () => ledger.getProspectById(ledger.upsertProspect({ name: "Dana Smith" }))!;

  it("parses the model's JSON and flags a long voicemail", async () => {
    responses.push(
      JSON.stringify({
        ...JSON.parse(BRIEF_JSON),
        voicemail: Array.from({ length: 70 }, () => "word").join(" "),
      }),
    );
    const brief = await buildCallBrief({ prospect: prospect(), playName: null, cfg: cfg as never });
    expect(brief.questions).toHaveLength(2);
    expect(brief.objections).toHaveLength(1);
    expect(brief.flags).toContain("voicemail-long: 70 words");
    expect(prompts[0]).toContain("PRODUCT: Widgets renewals");
  });

  it("falls back to honest lines when the model returns nothing usable", () => {
    const brief = parseCallBrief("not json", {
      firstName: "Dana",
      fullName: "Dana Smith",
      founderName: "Sam",
      product: "Widgets renewals",
      offer: null,
      angle: null,
      emailed: false,
    });
    expect(brief).toMatchObject({
      offer: "Widgets renewals.",
      questions: [],
      objections: [],
      gatekeeper: "Could you put me through to Dana Smith, please?",
    });
    expect(brief.opener).toContain("cold call");
    expect(brief.voicemail).toContain("I'll follow up by email");
    expect(
      parseCallBrief("{}", {
        firstName: null,
        fullName: null,
        founderName: null,
        product: null,
        offer: "Fix renewals",
        angle: null,
        emailed: true,
      }),
    ).toMatchObject({ offer: "Fix renewals", gatekeeper: null });
    expect(callBriefFlags(brief).every((f) => !f.startsWith("subject-"))).toBe(true);
  });

  it("is written once on demand for someone outside a cadence, again only on regenerate", async () => {
    callsOn();
    const id = ledger.upsertProspect({ name: "Dana Smith", email: "d@x.test" });
    responses.push(BRIEF_JSON, BRIEF_JSON);
    await callBriefFor({ prospectId: id });
    await callBriefFor({ prospectId: id });
    expect(prompts).toHaveLength(1);
    await callBriefFor({ prospectId: id, regenerate: true });
    expect(prompts).toHaveLength(2);
  });
});

describe("review fixes", () => {
  it("a rebuild keeps a saved call's place and delay when calls are off or changed", () => {
    callsOn(3);
    const id = enroll();
    const before = effectiveSequence(PLAY, id)!.steps.map((s) => [s.id, s.dayOffset]);
    expect(before[1]).toEqual(["call", 2]);
    // Calls changed, then off: a rebuild (a mail setting change) keeps the saved call.
    callsOn(2, { cadenceStep: { position: 4, delayDays: 7 } });
    applyCadencePlans(PLAY, captureCadencePlans(PLAY));
    expect(effectiveSequence(PLAY, id)!.steps.map((s) => [s.id, s.dayOffset])).toEqual(before);
    cfg = { ...cfg, calls: { enabled: false } };
    applyCadencePlans(PLAY, captureCadencePlans(PLAY));
    expect(effectiveSequence(PLAY, id)!.steps.map((s) => [s.id, s.dayOffset])).toEqual(before);
    // A letter added before it: the call still follows the email it followed.
    const plans = captureCadencePlans(PLAY);
    cfg = { ...cfg, directMailMotions: { [PLAY]: { position: 2, delayDays: 3 } } };
    applyCadencePlans(PLAY, plans);
    expect(effectiveSequence(PLAY, id)!.steps.map((s) => s.id)).toEqual([
      "direct_mail",
      "base:1",
      "call",
      "base:2",
      "base:3",
    ]);
  });

  it("a rebuild that drops the step a saved call followed keeps it after the nearest one left", () => {
    const COND = "__calls_cond";
    registerSequence({
      playName: COND,
      steps: [1, 2, 3, 4].map((i) => ({
        dayOffset: i,
        channel: "email" as const,
        label: `touch ${i}`,
        breakOnReply: true,
        // Only the second email can be switched off.
        when: (c: object) => i !== 2 || (c as { dropSecond?: boolean }).dropSecond !== true,
        builder: async () => ({ kind: "email" as const, subject: "s", body: "b" }),
      })),
    });
    callsOn(4);
    const id = ledger.upsertProspect({ name: "D", email: "d@x.test", phone: "+15126531187" });
    enrollInCadence({ prospectId: id, playName: COND });
    const ids = () => effectiveSequence(COND, id)!.steps.map((s) => [s.id, s.dayOffset]);
    expect(ids()).toEqual([
      ["base:1", 1],
      ["base:2", 2],
      ["call", 2],
      ["base:3", 3],
      ["base:4", 4],
    ]);
    const plans = captureCadencePlans(COND);
    cfg = { ...cfg, dropSecond: true };
    applyCadencePlans(COND, plans);
    expect(ids()).toEqual([
      ["base:1", 1],
      ["call", 2],
      ["base:3", 3],
      ["base:4", 4],
    ]);
  });

  it("recordCall is one transaction: a failure part-way writes nothing", async () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    const spy = vi.spyOn(ledger, "suppressCadencesForReply").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => recordCall(id, { outcome: "interested" })).toThrow("disk full");
    spy.mockRestore();
    expect(ledger.listCallsForProspect(id)).toEqual([]);
    expect(ledger.listChannelEventsForProspect(id)).toEqual([]);
    expect(callEvents(id)).toEqual([]);
    expect(cadence(id)).toMatchObject({ status: "active", current_step: 1 });
  });

  it("a changed outcome on a logged call rewrites its touch; a retry writes one", () => {
    const id = ledger.upsertProspect({ name: "D", email: "d@x.test", phone: "+15126531187" });
    const first = recordCall(id, { outcome: "no_answer" });
    recordCall(id, { outcome: "no_answer", callId: first.id });
    expect(ledger.listChannelEventsForProspect(id)).toMatchObject([{ event_type: "call" }]);
    recordCall(id, { outcome: "interested", callId: first.id });
    const touches = ledger.listChannelEventsForProspect(id);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ event_type: "reply" });
    expect(ledger.getCall(first.id)!.outcome).toBe("interested");
  });

  it("wrong_number keeps a replacement number found since the call", () => {
    const id = ledger.upsertProspect({ name: "D", email: "d@x.test", phone: "(512) 653-1187" });
    const old = ledger.insertCall({
      prospectId: id,
      startedAt: new Date().toISOString(),
      phone: "+15126531187",
    });
    // A replacement number found since (a phone lookup, a hand edit).
    (ledger as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE prospects SET phone = ? WHERE id = ?")
      .run("+15126539999", id);
    recordCall(id, { outcome: "wrong_number", callId: old });
    expect(ledger.getProspectById(id)!.phone).toBe("+15126539999");
    expect(ledger.phoneForCall(id).phone).toBe("+15126539999");
    // The number that rang the wrong person, written raw, is cleared.
    const other = ledger.upsertProspect({ name: "E", email: "e@x.test", phone: "(512) 653-1188" });
    recordCall(other, { outcome: "wrong_number" });
    expect(ledger.getProspectById(other)!.phone).toBeNull();
  });

  it("a preview that finishes after the cadence moved on stores nothing", async () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    responses.push(BRIEF_JSON);
    duringComplete = () => recordCall(id, { outcome: "no_answer" });
    await expect(callBriefFor({ prospectId: id, playName: PLAY })).rejects.toThrow(
      PREVIEW_STEP_MOVED,
    );
    expect(ledger.getCadenceDraft({ prospectId: id, playName: PLAY })).toBeNull();
    expect(cadence(id).current_step).toBe(2);
  });

  it("an on-demand brief is reused only for the play it was written for", async () => {
    callsOn();
    const id = ledger.upsertProspect({ name: "Dana Smith", email: "d@x.test" });
    responses.push(BRIEF_JSON, BRIEF_JSON);
    await callBriefFor({ prospectId: id });
    await callBriefFor({ prospectId: id });
    expect(prompts).toHaveLength(1);
    await callBriefFor({ prospectId: id, playName: PLAY });
    expect(prompts).toHaveLength(2);
    expect(ledger.getCallBrief(id)!.playName).toBe(PLAY);
  });

  it("the list limit counts only rows that pass the company list and have a number", () => {
    callsOn();
    cfg = { ...cfg, doNotContact: { domains: ["blocked.test"] } };
    // Equal touches rank newest prospect first: the three blocked ones, made
    // last, fill the first page and a half.
    const open: number[] = [];
    for (let i = 0; i < 6; i++) {
      const blocked = i >= 3;
      const id = ledger.upsertProspect({
        name: `P${i}`,
        email: `p${i}@${blocked ? "blocked" : "open"}.test`,
        phone: `+1512653${1100 + i}`,
      });
      if (!blocked) open.push(id);
    }
    const out = listCalls(new Date(), { limit: 2, pageSize: 2 });
    expect(out.list.map((r) => r.prospectId)).toEqual([open[2], open[1]]);
    expect(out.list).toHaveLength(2);
  });

  it("PRIOR EMAILS and the emailed opener read email sends only, never a LinkedIn message", async () => {
    callsOn();
    const id = enroll();
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: PLAY,
      stepIndex: 1,
      channel: "linkedin",
      status: "sent",
      metadata: { label: "LinkedIn message", body: "Saw your post on renewals." },
    });
    responses.push("{}");
    const prospect = ledger.getProspectById(id)!;
    const coldBrief = await buildCallBrief({ prospect, playName: PLAY, cfg: cfg as never });
    expect(prompts[0]).not.toContain("PRIOR EMAILS");
    expect(coldBrief.opener).toContain("cold call");
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: PLAY,
      stepIndex: 2,
      channel: "email",
      status: "sent",
      metadata: { subject: "renewals", body: "About your renewals." },
    });
    responses.push("{}");
    const brief = await buildCallBrief({ prospect, playName: PLAY, cfg: cfg as never });
    expect(prompts[1]).toContain("About your renewals.");
    expect(prompts[1]).not.toContain("Saw your post on renewals.");
    expect(brief.opener).toContain("I emailed you recently");
  });

  it("a log on an existing call completes only its own cadence's call step", () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    // A call made in another play, whose cadence is not at a call step.
    const other = ledger.insertCall({
      prospectId: id,
      playName: "__other",
      startedAt: new Date().toISOString(),
      phone: "+15126531187",
    });
    const call = recordCall(id, { outcome: "no_answer", callId: other });
    expect(call.playName).toBe("__other");
    expect(cadence(id).current_step).toBe(1);
    expect(callEvents(id)).toEqual([]);
    // A call with no play recorded still finds the due step.
    const loose = ledger.insertCall({ prospectId: id, startedAt: new Date().toISOString() });
    recordCall(id, { outcome: "no_answer", callId: loose });
    expect(cadence(id).current_step).toBe(2);
  });

  it("a call logged do_not_contact keeps that outcome: a change is refused with 409", () => {
    callsOn();
    const id = enroll();
    const call = recordCall(id, { outcome: "do_not_contact" });
    expect(() => recordCall(id, { outcome: "interested", callId: call.id })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(ledger.getCall(call.id)!.outcome).toBe("do_not_contact");
    expect(ledger.callAllowed(id)).toBe(false);
    expect(cadence(id).status).toBe("unsubscribed");
    // Logging it again as do_not_contact is a re-log.
    expect(recordCall(id, { outcome: "do_not_contact", callId: call.id }).outcome).toBe(
      "do_not_contact",
    );
  });

  it("wrong_number lands on the number dialled, not on one stored since", () => {
    const id = ledger.upsertProspect({ name: "D", email: "d@x.test", phone: "+15126539999" });
    // Dialled the old number; the stored one changed before the outcome was logged.
    const call = recordCall(id, { outcome: "wrong_number", phone: "(512) 653-1187" });
    expect(ledger.callPhone(call.id)).toBe("+15126531187");
    expect(ledger.getProspectById(id)!.phone).toBe("+15126539999");
    expect(ledger.phoneForCall(id).phone).toBe("+15126539999");
    expect(ledger.wrongNumbersFor([id]).get(id)).toEqual(new Set(["+15126531187"]));
  });

  it("the fallback offer drops trailing dots and spaces from the product line", () => {
    const brief = parseCallBrief("{}", {
      firstName: null,
      fullName: null,
      founderName: null,
      product: "Widgets renewals. . ",
      offer: null,
      angle: null,
      emailed: false,
    });
    expect(brief.offer).toBe("Widgets renewals.");
  });

  it("an on-demand brief is written again once the sequence's offer changed", async () => {
    callsOn();
    const id = enroll();
    ledger.setCadenceOffer({
      prospectId: id,
      playName: PLAY,
      offer: { offer: "Audit your renewals", steps: "a list in a week" },
      origin: "derived",
    });
    responses.push(BRIEF_JSON, BRIEF_JSON);
    await callBriefFor({ prospectId: id, playName: PLAY });
    await callBriefFor({ prospectId: id, playName: PLAY });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Audit your renewals");
    ledger.setCadenceOffer({
      prospectId: id,
      playName: PLAY,
      offer: { offer: "Cut one vendor this quarter", steps: "a shortlist" },
      origin: "derived",
    });
    await callBriefFor({ prospectId: id, playName: PLAY });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Cut one vendor this quarter");
    expect(ledger.getCallBrief(id)!.brief).not.toHaveProperty("offerKey");
  });

  it("a replayed log never completes a later call step", () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    const call = recordCall(id, { outcome: "no_answer" });
    expect(cadence(id).current_step).toBe(2);
    // Another call step is current now (two in a row); the same log comes again.
    atCallStep(id);
    recordCall(id, { outcome: "no_answer", callId: call.id });
    expect(cadence(id).current_step).toBe(1);
    expect(callEvents(id)).toHaveLength(1);
  });

  it("a call made before the current call step began never completes it", () => {
    callsOn();
    const id = enroll();
    const old = ledger.insertCall({
      prospectId: id,
      playName: PLAY,
      startedAt: "2026-01-01T10:00:00.000Z",
      phone: "+15126531187",
    });
    atCallStep(id);
    recordCall(id, { outcome: "voicemail", callId: old });
    expect(cadence(id).current_step).toBe(1);
    expect(callEvents(id)).toEqual([]);
    expect(ledger.getCall(old)!.outcome).toBe("voicemail");
  });

  it("a number that does not parse is refused and never clears the stored one", () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    expect(() => recordCall(id, { outcome: "wrong_number", phone: "not a number" })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(ledger.getProspectById(id)!.phone).toBe("+15126531187");
    expect(ledger.listCallsForProspect(id)).toEqual([]);
    expect(cadence(id).current_step).toBe(1);
  });

  it("a save retried with its key writes one call; a changed outcome on the retry is applied", () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    const first = recordCall(id, { outcome: "no_answer", clientKey: "k-0123456789" });
    const again = recordCall(id, { outcome: "no_answer", clientKey: "k-0123456789" });
    expect(again.id).toBe(first.id);
    expect(ledger.listCallsForProspect(id)).toHaveLength(1);
    expect(callEvents(id)).toHaveLength(1);
    expect(cadence(id).current_step).toBe(2);
    expect(recordCall(id, { outcome: "voicemail", clientKey: "k-0123456789" }).outcome).toBe(
      "voicemail",
    );
    expect(ledger.listCallsForProspect(id)).toHaveLength(1);
    const other = ledger.upsertProspect({ name: "E", email: "e@x.test", phone: "+15126531188" });
    expect(() => recordCall(other, { outcome: "no_answer", clientKey: "k-0123456789" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("a new log completes only the step its row was opened on", () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    // Opened on step 0; the cadence is on its call step (1) now.
    const late = recordCall(id, { outcome: "no_answer", playName: PLAY, currentStep: 0 });
    expect(late.playName).toBe(PLAY);
    expect(cadence(id).current_step).toBe(1);
    expect(callEvents(id)).toEqual([]);
    // Opened from the call list, with no step due.
    recordCall(id, { outcome: "no_answer", currentStep: null });
    expect(cadence(id).current_step).toBe(1);
    // Opened on the same step number of an earlier enrolment (a stop and re-enrol since).
    recordCall(id, {
      outcome: "no_answer",
      playName: PLAY,
      currentStep: 1,
      enrolledAt: "2026-01-01T00:00:00.000Z",
    });
    expect(cadence(id).current_step).toBe(1);
    expect(callEvents(id)).toEqual([]);
    // Opened on the call step itself, as the due row names it.
    const row = listCalls().due.find((r) => r.prospectId === id)!;
    expect(row).toMatchObject({ currentStep: 1, enrolledAt: cadence(id).enrolled_at });
    const due = recordCall(id, {
      outcome: "voicemail",
      playName: PLAY,
      currentStep: row.currentStep,
      enrolledAt: row.enrolledAt!,
    });
    expect(cadence(id).current_step).toBe(2);
    expect(JSON.parse(callEvents(id)[0]!.metadata_json!)).toMatchObject({ callId: due.id });
  });

  it("a changed outcome on a call whose cadence moved on marks that call's step, not the latest email", () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    const call = recordCall(id, { outcome: "no_answer" });
    expect(cadence(id).current_step).toBe(2);
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: PLAY,
      stepIndex: 3,
      channel: "email",
      status: "sent",
      metadata: { subject: "s", body: "b" },
    });
    recordCall(id, { outcome: "interested", callId: call.id });
    const [event] = callEvents(id);
    expect(event).toMatchObject({ status: "replied" });
    expect(JSON.parse(event!.metadata_json!)).toMatchObject({ outcome: "interested" });
    const email = ledger
      .listSequenceEventsForProspectPlay(id, PLAY)
      .find((e) => e.channel === "email");
    expect(email!.status).toBe("sent");
    expect(cadence(id).status).toBe("replied");
  });

  it("a preview whose plan step was replaced meanwhile stores nothing", async () => {
    callsOn();
    const id = enroll();
    atCallStep(id);
    responses.push(BRIEF_JSON);
    duringComplete = () => {
      // A settings change puts an email where the call was, same index.
      const c = cadence(id);
      const plan = ledger.getCadencePlan(id, PLAY, c.enrolled_at)!;
      plan[c.current_step] = { id: "base:2", dayOffset: 3, channel: "email", label: "touch 2" };
      ledger.saveCadencePlan(id, PLAY, c.enrolled_at, plan);
    };
    await expect(callBriefFor({ prospectId: id, playName: PLAY })).rejects.toThrow(
      PREVIEW_STEP_MOVED,
    );
    expect(ledger.getCadenceDraft({ prospectId: id, playName: PLAY })).toBeNull();
  });

  it("a repeated meeting_booked log records the meeting once", () => {
    const id = ledger.upsertProspect({ name: "D", email: "d@x.test", phone: "+15126531187" });
    const call = recordCall(id, { outcome: "meeting_booked" });
    recordCall(id, { outcome: "meeting_booked", callId: call.id });
    expect(ledger.listDealOutcomesForProspect(id)).toHaveLength(1);
  });

  describe("the breakup email stays the last step a call step is placed around", () => {
    const BREAKUP = "__calls_breakup";
    beforeEach(() => {
      registerSequence({
        playName: BREAKUP,
        steps: ["follow-up 1", "follow-up 2", "breakup"].map((label, i) => ({
          dayOffset: i * 3,
          channel: "email" as const,
          label,
          breakOnReply: true,
          builder: async () => ({ kind: "email" as const, subject: "s", body: "b" }),
        })),
      });
    });

    it("a call at position 2 leaves the breakup last", () => {
      callsOn(2);
      const seq = effectiveSequence(BREAKUP)!;
      // Position 2: right after the intro, before every follow-up.
      expect(shape(seq)).toEqual(["call", "follow-up 1", "follow-up 2", "breakup"]);
      expect(isBreakupStepAt(seq, 3)).toBe(true);
      expect(threadsIntoIntro(seq, 3)).toBe(false);
    });

    it("a call set past the last email goes just before the breakup", () => {
      callsOn(9);
      const seq = effectiveSequence(BREAKUP)!;
      expect(shape(seq)).toEqual(["follow-up 1", "follow-up 2", "call", "breakup"]);
      expect(isBreakupStepAt(seq, 3)).toBe(true);
      expect(threadsIntoIntro(seq, 1)).toBe(true);
      // A sequence without a breakup may end on the call.
      expect(shape(effectiveSequence(PLAY)!)).toEqual(["touch 1", "touch 2", "touch 3", "call"]);
    });

    it("with the LinkedIn continuation, the call stays among the emails", () => {
      callsOn(9);
      cfg = { ...cfg, linkedinContinuation: true };
      const seq = effectiveSequence(BREAKUP)!;
      expect(shape(seq)).toEqual([
        "follow-up 1",
        "follow-up 2",
        "call",
        "breakup",
        "linkedin",
        "linkedin",
        "linkedin",
      ]);
      // The last email still starts its own thread; LinkedIn after it does not count.
      expect(threadsIntoIntro(seq, 3)).toBe(false);
      expect(threadsIntoIntro(seq, 1)).toBe(true);
    });
  });

  it("listCalls reads the due cadences' plans once, not once per row", () => {
    callsOn();
    const ids = [enroll(), enroll("+15126531188", "two@acme.test")];
    for (const id of ids) atCallStep(id);
    const perRow = vi.spyOn(ledger, "getCadencePlan");
    const batch = vi.spyOn(ledger, "cadencePlansFor");
    const getCadence = vi.spyOn(ledger, "getCadence");
    expect(
      listCalls()
        .due.map((r) => r.prospectId)
        .toSorted(),
    ).toEqual(ids.toSorted());
    expect(batch).toHaveBeenCalledTimes(1);
    expect(perRow).not.toHaveBeenCalled();
    expect(getCadence).not.toHaveBeenCalled();
  });
});
