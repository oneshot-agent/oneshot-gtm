import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../core/src/ledger.ts";

// The dialler on a real in-memory ledger: the call step in a cadence, what
// the unattended runner does with it, logging outcomes, the Calls page's
// lists and the brief (the LLM mocked; nothing paid).

let ledger: Ledger;
let cfg: Record<string, unknown> = {};
const responses: string[] = [];
const prompts: string[] = [];

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
} = await import("../src/_cadence.ts");
const { recordCall, listCalls, buildCallBrief, callBriefFor, parseCallBrief, callBriefFlags } =
  await import("../src/_calls.ts");

const PLAY = "__calls";
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

  it("dialMode is bridge only once a bridge is configured", () => {
    callsOn(3, {
      bridge: { provider: "twilio", founderPhone: "+15550001111", callerId: "+15550002222" },
    });
    expect(listCalls().dialMode).toBe("bridge");
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
