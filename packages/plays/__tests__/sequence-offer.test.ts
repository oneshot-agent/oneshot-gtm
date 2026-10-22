import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendEmailInput } from "@oneshot-gtm/core";
import { Ledger } from "../../core/src/ledger.ts";

// Every follow-up of an offer-making play restates its sequence's offer,
// which the cadence owns (`cadence_state.offer_json`). A sequence that started
// before prospect offers existed gets one written at its next preview, from
// the research on the queue row it started from (or the prospect, with none)
// and the thread already sent, stored on the cadence, and read back by every
// later touch. One that can't get one is held, never drafted from the
// founder's terms alone. Real ledger, stubbed models and send.

let ledger: Ledger;
const sends: SendEmailInput[] = [];
const llm = {
  /** User messages, by system prompt. */
  inputs: new Map<string, string[]>(),
  /** The offer writer's reply. */
  offers: "" as string,
  /** The relevance judge's label for every offer. */
  judge: "relevant" as "relevant" | "weak" | "irrelevant",
  /** The follow-up writer ignores its OFFER (and its repair turn does too). */
  dropOffer: false,
};

const cfg = {
  founderName: "Founder",
  productOneLiner: "Acme schedules field crews",
  productBrief:
    "Acme plans crew routes, books jobs into open slots and texts customers the arrival time.",
  pilotOffer: "four weeks on one depot",
  cadenceOverrides: null,
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => cfg,
    logEvent: () => {},
    getCachedNewsfeed: () => null,
    recentTouchElsewhere: () => null,
    sendEmail: async (input: SendEmailInput) => {
      sends.push(input);
      const receiptId = ledger.recordReceipt({
        playName: "x",
        callType: "email.send",
        signedReceipt: { provider: "test" },
      });
      return { receiptId, result: { status: "sent", cost: 0 }, subject: input.subject };
    },
  };
});

/** The OFFER line a follow-up was given, so the stub writes a body that opens on it. */
function offerLine(user: string): string | null {
  return (
    /^OFFER \(what you offer to do for them; the message opens with it\): (.+)$/m.exec(user)?.[1] ??
    null
  );
}

const reply = (content: string) => ({ content, provider: "t", model: "t" });

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => name,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const system = input.messages[0]?.content ?? "";
      const name = system.split(/\s/)[0]!;
      const user = input.messages.at(-1)?.content ?? "";
      llm.inputs.set(name, [...(llm.inputs.get(name) ?? []), user]);
      if (name === "prospect-offer") return reply(llm.offers);
      if (name === "prospect-offer-judge") {
        const count = (user.match(/^\d+\.$/gm) ?? []).length;
        return reply(
          JSON.stringify({
            judgements: Array.from({ length: count }, (_, i) => ({
              offer: i + 1,
              label: llm.judge,
              why: "test",
            })),
          }),
        );
      }
      if (name === "offer-angles") return reply(JSON.stringify({ angles: [] }));
      if (name === "angle-select") return reply(JSON.stringify({ index: 1 }));
      const offer = offerLine(input.messages.find((m) => m.role === "user")?.content ?? "");
      return reply(
        JSON.stringify({
          subject: "leeds crews",
          body:
            offer && !llm.dropOffer
              ? `I can ${offer}, start to finish. You get back the same-day jobs the depot turns away today, counted per booked job. Worth trying on one depot?\n\nFounder`
              : "If it's not the right time, a one-word no helps too.\n\nFounder",
        }),
      );
    },
  };
});

const {
  buildFollowUpEmail,
  enrollInCadence,
  previewCadenceStep,
  registerSequence,
  sendCadenceStep,
} = await import("../src/_cadence.ts");
const { deriveSequenceOffer, sequenceOfferRecord, writeSequenceOffer } =
  await import("../src/_sequence-offer.ts");

const PLAY = "seq-offer-play";
const step = (label: string) => ({
  dayOffset: 3,
  channel: "email" as const,
  breakOnReply: true,
  label,
  builder: buildFollowUpEmail({ playName: PLAY, promptName: "seq-followup", contextLines: [] }),
});
registerSequence({
  playName: PLAY,
  steps: [step("value follow-up"), step("second follow-up"), step("breakup")],
});

const good = {
  offer: "get the leeds depot's crews booked into same-day slots without a dispatcher",
  steps: "plans crew routes, books jobs into open slots and texts customers the arrival time",
  evidence: ["opened a second depot in Leeds"],
  stage: "established local business",
  level: "researched",
  return: "same-day jobs the leeds depot would otherwise turn away, counted per booked job",
};
const second = {
  ...good,
  offer: "get every leeds customer texted their crew's arrival time before the van leaves",
  return: "calls to the office the leeds team stops answering, counted per week",
};

/** An offer whose evidence is `quote`: the writer's quotes must be in the research. */
const resting = (o: typeof good, quote: string) => ({ ...o, evidence: [quote] });

const INTRO_BODY = "Your Leeds crews could take same-day jobs. Worth a look?";
let n = 0;

/**
 * A prospect whose intro went out before offers existed: a sent row (unless
 * `queued: false`) the cadence is linked to, a step-0 send, and a cadence
 * with no offer, or `intro`'s as the first email carried it.
 */
function preOfferSequence(
  opts: {
    queued?: boolean;
    rowOffer?: unknown;
    payload?: Record<string, unknown>;
    intro?: Record<string, unknown>;
  } = {},
): { id: number; rowId: number | null } {
  const email = `dana${++n}@northside.example`;
  const id = ledger.upsertProspect({ name: "Dana Lee", email, company: "Northside Plumbing" });
  let rowId: number | null = null;
  if (opts.queued !== false) {
    rowId = ledger.enqueueTarget({
      playName: PLAY,
      payload: opts.payload ?? {
        name: "Dana Lee",
        email,
        company: "Northside Plumbing",
        title: "Operations Manager",
        signal: "opened a second depot in Leeds",
        ...(opts.rowOffer ? { offer: opts.rowOffer } : {}),
      },
      dedupeKey: `k-${email}`,
      source: "find:test",
    })!;
    ledger.setQueueStatus({ id: rowId, status: "sent" });
  }
  ledger.recordSequenceEvent({
    prospectId: id,
    playName: PLAY,
    stepIndex: 0,
    channel: "email",
    status: "sent",
    metadata: { subject: "leeds crews", body: INTRO_BODY },
  });
  enrollInCadence({
    prospectId: id,
    playName: PLAY,
    ...(rowId != null ? { queueId: rowId } : {}),
    ...(opts.intro ? { offer: opts.intro as never } : {}),
  });
  return { id, rowId };
}

function cadenceOffer(id: number): Record<string, unknown> | null {
  const json = ledger.getCadence(id, PLAY)?.offer_json;
  return json ? (JSON.parse(json) as Record<string, unknown>) : null;
}

function rowPayload(rowId: number): Record<string, unknown> {
  return JSON.parse(ledger.getQueueRow(rowId)!.payload_json) as Record<string, unknown>;
}

async function preview(id: number) {
  const out = await previewCadenceStep({ prospectId: id, playName: PLAY });
  if (!("subject" in out)) throw new Error("expected a preview");
  return out;
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  sends.length = 0;
  llm.inputs = new Map();
  llm.offers = JSON.stringify({ offers: [good, second] });
  llm.judge = "relevant";
  llm.dropOffer = false;
});
afterEach(() => ledger.close());

describe("a sequence that started before prospect offers", () => {
  it("gets an offer written at its next preview, from the thread, stored on the cadence", async () => {
    const { id, rowId } = preOfferSequence();
    const before = ledger.getQueueRow(rowId!)!.payload_json;
    const out = await preview(id);

    // The writer was told what the row says and what the thread already said.
    const writer = llm.inputs.get("prospect-offer")![0]!;
    expect(writer).toContain("opened a second depot in Leeds");
    expect(writer).toContain("THREAD SO FAR:");
    expect(writer).toContain(INTRO_BODY);
    // Stored on the cadence, the offer and its candidates; the row is untouched.
    const stored = cadenceOffer(id)!;
    expect(stored["offer"]).toMatchObject({ offer: good.offer, relevance: "relevant" });
    expect((stored["candidates"] as unknown[]).length).toBe(2);
    expect(stored["origin"]).toBe("derived");
    expect(ledger.getQueueRow(rowId!)!.payload_json).toBe(before);
    // The follow-up opens on it, and nothing holds it.
    expect(llm.inputs.get("seq-followup")![0]).toContain(`: ${good.offer}`);
    expect(out.body.startsWith(`I can ${good.offer}`)).toBe(true);
    expect(out.flags).toEqual([]);
    expect(sequenceOfferRecord({ prospectId: id, playName: PLAY })).toMatchObject({
      queueRowId: rowId,
      introCarriedOffer: false,
      offer: { offer: good.offer },
    });
  });

  it("a later step reuses the stored offer instead of writing another", async () => {
    const { id } = preOfferSequence();
    await preview(id);
    await sendCadenceStep({ prospectId: id, playName: PLAY });
    expect(sends).toHaveLength(1);
    llm.offers = JSON.stringify({ offers: [second] });

    await preview(id);
    expect(llm.inputs.get("prospect-offer")).toHaveLength(1);
    expect(llm.inputs.get("seq-followup")!.at(-1)).toContain(`: ${good.offer}`);
  });

  it("keeps the intro's own offer when the first email carried one", async () => {
    const carried = "get every leeds job quoted the day it is asked for";
    const { id, rowId } = preOfferSequence({
      intro: { offer: carried, steps: "drafts the quote" },
      rowOffer: { ...good, version: "v", inputHash: "h", derivedAt: "" },
    });
    await preview(id);
    expect(llm.inputs.get("prospect-offer")).toBeUndefined();
    expect(llm.inputs.get("seq-followup")![0]).toContain(`: ${carried}`);
    expect(rowPayload(rowId!)["offer"]).toMatchObject({ offer: good.offer });
    expect(sequenceOfferRecord({ prospectId: id, playName: PLAY })).toMatchObject({
      introCarriedOffer: true,
      offer: { offer: carried, steps: "drafts the quote" },
    });
    // On-demand re-derivation never replaces the intro's own offer.
    const again = await deriveSequenceOffer({ prospectId: id, playName: PLAY, force: true });
    expect(again.status).toBe("existing");
  });

  it("re-derives on demand, replacing a written offer whole", async () => {
    const { id, rowId } = preOfferSequence();
    await deriveSequenceOffer({ prospectId: id, playName: PLAY });
    llm.offers = JSON.stringify({ offers: [second] });
    const again = await deriveSequenceOffer({ prospectId: id, playName: PLAY, force: true });
    expect(again).toMatchObject({ status: "stored", offer: { offer: second.offer } });
    expect(cadenceOffer(id)).toMatchObject({
      offer: { offer: second.offer },
      candidates: [{ offer: second.offer }],
    });
    expect(rowPayload(rowId!)["offer"]).toBeUndefined();
  });

  it("stores nothing while a send holds the cadence", async () => {
    const { id } = preOfferSequence();
    ledger.claimCadenceSendingMarker({
      prospectId: id,
      playName: PLAY,
      startedAtIso: new Date().toISOString(),
    });
    const out = await deriveSequenceOffer({ prospectId: id, playName: PLAY });
    expect(out).toMatchObject({ status: "none", reason: "not-stored" });
    expect(cadenceOffer(id)).toBeNull();
  });

  it("with no queue row, is written from the prospect and their dossier", async () => {
    const { id } = preOfferSequence({ queued: false });
    ledger.mergeProspectDossierHalf(id, "person", "runs the Leeds depot's dispatch desk");
    // Its evidence is what the prospect's dossier says.
    const quote = "runs the Leeds depot's dispatch desk";
    llm.offers = JSON.stringify({ offers: [resting(good, quote), resting(second, quote)] });
    const out = await preview(id);
    const writer = llm.inputs.get("prospect-offer")![0]!;
    expect(writer).toContain("Northside Plumbing");
    expect(writer).toContain("runs the Leeds depot's dispatch desk");
    expect(out.flags).toEqual([]);
    expect(out.body.startsWith(`I can ${good.offer}`)).toBe(true);
    expect(sequenceOfferRecord({ prospectId: id, playName: PLAY })).toMatchObject({
      queueRowId: null,
      offer: { offer: good.offer },
    });
  });

  it("a row that names the person only by founderEmail is linked, and its offer editable", async () => {
    const email = `hn${++n}@launch.example`;
    const id = ledger.upsertProspect({ name: "Sam Hill", email, company: "Launchpad" });
    const rowId = ledger.enqueueTarget({
      playName: PLAY,
      payload: { founderName: "Sam Hill", founderEmail: email, projectTitle: "Show HN: Crewbook" },
      dedupeKey: `hn-${email}`,
      source: "find:test",
    })!;
    ledger.setQueueStatus({ id: rowId, status: "sent" });
    ledger.recordSequenceEvent({
      prospectId: id,
      playName: PLAY,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "crewbook", body: INTRO_BODY },
    });
    enrollInCadence({ prospectId: id, playName: PLAY, queueId: rowId });
    // Its evidence is what that row says.
    llm.offers = JSON.stringify({
      offers: [resting(good, "Show HN: Crewbook"), resting(second, "Show HN: Crewbook")],
    });

    await preview(id);
    expect(llm.inputs.get("prospect-offer")![0]).toContain("Show HN: Crewbook");
    const record = sequenceOfferRecord({ prospectId: id, playName: PLAY });
    expect(record).toMatchObject({ queueRowId: rowId, introCarriedOffer: false });
    expect(record.offerCandidates.length).toBe(2);
    // The founder's own text is written on the cadence, the list kept.
    expect(
      writeSequenceOffer({
        record,
        offer: {
          ...second,
          offer: "book every crew the day the job comes in",
          editedBy: "founder",
        },
      }),
    ).toBe(true);
    expect(sequenceOfferRecord({ prospectId: id, playName: PLAY })).toMatchObject({
      offer: { offer: "book every crew the day the job comes in", editedBy: "founder" },
      offerCandidates: [{ offer: good.offer }, { offer: second.offer }],
    });
  });
});

describe("a sequence that can't get an offer", () => {
  it("when the judge rules out every offer, is held no-offer and never drafted from the terms", async () => {
    llm.judge = "irrelevant";
    const { id, rowId } = preOfferSequence();
    const out = await preview(id);
    expect(out).toMatchObject({ subject: "", body: "", flags: ["no-offer"] });
    expect(llm.inputs.get("seq-followup")).toBeUndefined();
    expect(cadenceOffer(id)).toBeNull();
    expect(rowPayload(rowId!)["offer"]).toBeUndefined();
    await expect(sendCadenceStep({ prospectId: id, playName: PLAY })).rejects.toThrow(/no-offer/);
  });

  it("with no product brief, is held no-offer", async () => {
    const brief = cfg.productBrief;
    cfg.productBrief = "";
    try {
      const { id } = preOfferSequence();
      expect((await preview(id)).flags).toEqual(["no-offer"]);
    } finally {
      cfg.productBrief = brief;
    }
  });
});

describe("weak-fit sequence offers", () => {
  it("hold the follow-up for the founder, until the offer is approved", async () => {
    llm.judge = "weak";
    const { id } = preOfferSequence();
    const held = await preview(id);
    expect(held.flags).toEqual(["weak-offer"]);
    expect(held.body.startsWith("I can ")).toBe(true);

    // The founder approves it (stamped on the stored offer, bound to it).
    const record = sequenceOfferRecord({ prospectId: id, playName: PLAY });
    expect(
      writeSequenceOffer({
        record,
        offer: { weakApprovedAt: "2026-10-21T00:00:00Z" },
        merge: true,
        expect: { offer: record.offer!.offer, relevance: "weak" },
      }),
    ).toBe(true);
    expect((await preview(id)).flags).toEqual([]);
  });

  it("never hold a follow-up for the offer the intro already sent", async () => {
    const { id } = preOfferSequence({ intro: { ...good, relevance: "weak" } });
    expect(sequenceOfferRecord({ prospectId: id, playName: PLAY })).toMatchObject({
      introCarriedOffer: true,
      offer: { offer: good.offer, relevance: "weak" },
    });
    expect((await preview(id)).flags).toEqual([]);
  });
});

describe("follow-up lints at preview", () => {
  it("flag a follow-up that does not open on its offer, or is too thin to carry it", async () => {
    // The production breakup body: "If it's not the right time, a one-word no helps too."
    llm.dropOffer = true;
    const { id } = preOfferSequence({ intro: { offer: good.offer, steps: good.steps } });
    const out = await preview(id);
    expect(out.flags).toEqual(expect.arrayContaining(["opens-without-offer", "thin-body"]));
    // One repair round was asked for both before the draft was held.
    const repair = llm.inputs.get("seq-followup")!.at(-1)!;
    expect(repair).toContain("thin-body");
    expect(repair).toContain("opens-without-offer");
  });
});
