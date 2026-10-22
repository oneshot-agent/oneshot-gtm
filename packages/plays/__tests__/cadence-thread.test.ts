import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailThread, SendEmailInput } from "@oneshot-gtm/core";
import { Ledger } from "../../core/src/ledger.ts";

// Follow-ups reply in the first email's thread; the last email of the
// sequence starts a new one. Real ledger, stubbed send and Gmail lookup.

let ledger: Ledger;
const sends: SendEmailInput[] = [];
const gmailLookups: string[] = [];
const builderCtx: Array<{ threadedSubject?: boolean }> = [];
let modelSubject = "model subject";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({
      founderName: "Founder",
      productOneLiner: "thing",
      cadenceOverrides: null,
    }),
    recentTouchElsewhere: () => null,
    sendEmail: async (input: SendEmailInput) => {
      sends.push(input);
      const receiptId = ledger.recordReceipt({
        playName: "x",
        callType: "email.send",
        signedReceipt: { provider: "test" },
      });
      // What a send whose sender changed reports: the subject without "Re: ".
      const subject =
        input.thread && input.thread.identityId === "moved"
          ? input.subject.replace(/^re:\s*/i, "")
          : input.subject;
      return { receiptId, result: { status: "sent", cost: 0 }, subject };
    },
    gmailSentMessageIdFor: async (_identityId: string, gmailId: string) => {
      gmailLookups.push(gmailId);
      return "<rfc-intro@mail.gmail.com>";
    },
  };
});

const {
  enrollInCadence,
  introThreadFor,
  previewCadenceStep,
  registerSequence,
  runCadenceStepForProspect,
  sendCadenceStep,
  threadsIntoIntro,
} = await import("../src/_cadence.ts");
type Seq = Parameters<typeof registerSequence>[0];

// The intro's offer: every follow-up opens on it (and says enough to send).
const OFFER = "run the beta pipeline review end to end";
const BODY = `I can ${OFFER} for your team, start to finish. You get back the hours the review takes today, counted per release.\n\nFounder`;

const builder = async (ctx: { threadedSubject?: boolean }) => {
  builderCtx.push(ctx.threadedSubject ? { threadedSubject: true } : {});
  return { kind: "email" as const, subject: modelSubject, body: BODY };
};
const email = (label: string) => ({
  dayOffset: 3,
  channel: "email" as const,
  breakOnReply: true,
  label,
  builder,
});
const linkedin = (label: string) => ({
  dayOffset: 2,
  channel: "linkedin" as const,
  breakOnReply: true,
  label,
  builder: async () => null,
});

const THREE: Seq = {
  playName: "thread-alpha",
  steps: [email("value follow-up"), email("second follow-up"), email("breakup")],
};
const SINGLE: Seq = { playName: "thread-beta", steps: [email("single follow-up + breakup")] };
const NO_BREAKUP: Seq = {
  playName: "thread-gamma",
  steps: [email("value follow-up"), email("close"), linkedin("invite"), linkedin("message")],
};
for (const s of [THREE, SINGLE, NO_BREAKUP]) registerSequence(s);

const INTRO_SUBJECT = "alpha pipeline review for the beta platform team this quarter";
const SMTP_ID = "<intro-0001@mail.alpha.example>";
let n = 0;

/** A prospect enrolled in `play` whose first email went out over `transport`. */
function sentIntro(
  play: string,
  transport: "smtp" | "gmail" | "oneshot" | "none" = "smtp",
): number {
  const id = ledger.upsertProspect({
    name: "Beta Person",
    email: `beta${++n}@beta.example`,
    company: "Beta",
  });
  const identityId =
    transport === "gmail" ? "gmail:alpha@gmail.com" : transport === "oneshot" ? "os" : "smtp:a";
  const signed =
    transport === "gmail"
      ? { provider: "gmail", message_id: "gm-intro", thread_id: "th-intro" }
      : transport === "oneshot"
        ? { status: "sent", email_message: { id: "em-intro" } }
        : { provider: "smartlead", transport: "smtp", message_id: SMTP_ID };
  const receiptId = ledger.recordReceipt({
    playName: play,
    callType: "email.send",
    signedReceipt: signed,
    senderIdentity: identityId,
  });
  if (transport !== "none") {
    const key = `test:${play}:${id}:0`;
    ledger.outboundSends.claim({
      key,
      identityId,
      transport,
      recipient: ledger.getProspectById(id)!.email!,
      subject: INTRO_SUBJECT,
      body: "b",
      messageId: transport === "smtp" ? SMTP_ID : null,
      sentEvidence: true,
    });
    ledger.outboundSends.mark(key, "submitted", {
      receiptId,
      ...(transport === "gmail" ? { messageId: "gm-intro" } : {}),
    });
  }
  ledger.recordSequenceEvent({
    prospectId: id,
    playName: play,
    stepIndex: 0,
    channel: "email",
    status: "sent",
    // "none": a first email whose receipt carries no usable thread.
    receiptId: transport === "none" ? undefined : receiptId,
    metadata: { subject: INTRO_SUBJECT, body: "b" },
  });
  enrollInCadence({ prospectId: id, playName: play, offer: { offer: OFFER, steps: "" } });
  return id;
}

function atStep(id: number, play: string, step: number): void {
  ledger.advanceCadence({ prospectId: id, playName: play, newStep: step, nextDueAt: null });
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  sends.length = 0;
  gmailLookups.length = 0;
  builderCtx.length = 0;
  modelSubject = "model subject";
});
afterEach(() => ledger.close());

describe("threadsIntoIntro", () => {
  it("threads every email follow-up but the breakup", () => {
    expect([0, 1, 2].map((i) => threadsIntoIntro(THREE, i))).toEqual([true, true, false]);
  });

  it("a single 'follow-up + breakup' never threads", () => {
    expect(threadsIntoIntro(SINGLE, 0)).toBe(false);
  });

  it("the last email step stays new when LinkedIn steps come after it", () => {
    expect([0, 1, 2, 3].map((i) => threadsIntoIntro(NO_BREAKUP, i))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("introThreadFor", () => {
  it("smtp: the Message-ID we set on the first email", async () => {
    const id = sentIntro(THREE.playName, "smtp");
    expect(await introThreadFor(id, THREE.playName)).toEqual({
      subject: INTRO_SUBJECT,
      identityId: "smtp:a",
      inReplyTo: SMTP_ID,
      references: [SMTP_ID],
    });
  });

  it("gmail: thread id and the RFC Message-ID, looked up once and kept on step 0", async () => {
    const id = sentIntro(THREE.playName, "gmail");
    const first = await introThreadFor(id, THREE.playName);
    expect(first).toEqual({
      subject: INTRO_SUBJECT,
      identityId: "gmail:alpha@gmail.com",
      inReplyTo: "<rfc-intro@mail.gmail.com>",
      references: ["<rfc-intro@mail.gmail.com>"],
      gmailThreadId: "th-intro",
    });
    expect(await introThreadFor(id, THREE.playName)).toEqual(first);
    expect(gmailLookups).toEqual(["gm-intro"]);
    const step0 = ledger.listSequenceEventsForProspectPlay(id, THREE.playName)[0]!;
    expect(JSON.parse(step0.metadata_json!)).toMatchObject({
      rfcMessageId: "<rfc-intro@mail.gmail.com>",
    });
  });

  it("oneshot: the platform's id of the sent email", async () => {
    const id = sentIntro(THREE.playName, "oneshot");
    expect(await introThreadFor(id, THREE.playName)).toEqual({
      subject: INTRO_SUBJECT,
      identityId: "os",
      oneshotEmailId: "em-intro",
    });
  });

  it("null without a first-email receipt", async () => {
    const id = sentIntro(THREE.playName, "none");
    expect(await introThreadFor(id, THREE.playName)).toBeNull();
  });
});

describe("preview and send", () => {
  it("a middle follow-up previews and sends as Re: <first subject> in its thread", async () => {
    modelSubject = "following up";
    const id = sentIntro(THREE.playName);
    const preview = await previewCadenceStep({ prospectId: id, playName: THREE.playName });
    if (!("subject" in preview)) throw new Error("expected a preview");
    expect(preview.subject).toBe(`Re: ${INTRO_SUBJECT}`);
    // The subject is the first email's: no subject flag can hold it.
    expect(preview.flags).toEqual([]);
    expect(builderCtx).toEqual([{ threadedSubject: true }]);
    const thread: EmailThread = {
      identityId: "smtp:a",
      inReplyTo: SMTP_ID,
      references: [SMTP_ID],
    };
    expect(preview.payload).toMatchObject({ kind: "email", thread });

    await sendCadenceStep({ prospectId: id, playName: THREE.playName });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ subject: `Re: ${INTRO_SUBJECT}`, thread });
    const step1 = ledger
      .listSequenceEventsForProspectPlay(id, THREE.playName)
      .find((e) => e.step_index === 1)!;
    expect(JSON.parse(step1.metadata_json!).subject).toBe(`Re: ${INTRO_SUBJECT}`);
  });

  it("the stored preview sends as previewed, even if the first email's row changes", async () => {
    const id = sentIntro(THREE.playName);
    await previewCadenceStep({ prospectId: id, playName: THREE.playName });
    // Gone after the preview: the send still uses the preview's thread.
    (ledger as unknown as { db: { query: (sql: string) => { run: () => void } } }).db
      .query("DELETE FROM outbound_sends")
      .run();
    await sendCadenceStep({ prospectId: id, playName: THREE.playName });
    expect(sends[0]?.thread).toEqual({
      identityId: "smtp:a",
      inReplyTo: SMTP_ID,
      references: [SMTP_ID],
    });
  });

  it("a preview stored before threading sends as a new email, as before", async () => {
    const id = sentIntro(THREE.playName);
    const payload = { kind: "email", subject: "old subject", body: "b" };
    ledger.setCadenceDraft({
      prospectId: id,
      playName: THREE.playName,
      draft: { subject: "old subject", body: "b", flags: [], payload },
    });
    await sendCadenceStep({ prospectId: id, playName: THREE.playName });
    expect(sends[0]).toMatchObject({ subject: "old subject" });
    expect(sends[0]?.thread).toBeUndefined();
  });

  it("the step metadata records the subject that went out", async () => {
    const id = sentIntro(THREE.playName);
    await previewCadenceStep({ prospectId: id, playName: THREE.playName });
    const draft = ledger.getCadenceDraft({ prospectId: id, playName: THREE.playName })!;
    const payload = draft.payload as { thread: EmailThread };
    payload.thread = { ...payload.thread, identityId: "moved" };
    await runCadenceStepForProspect({
      prospectId: id,
      playName: THREE.playName,
      dryRun: false,
      persistedPayload: payload as never,
    });
    const step1 = ledger
      .listSequenceEventsForProspectPlay(id, THREE.playName)
      .find((e) => e.step_index === 1)!;
    expect(JSON.parse(step1.metadata_json!).subject).toBe(INTRO_SUBJECT);
  });

  it("the breakup starts a new email with the model's subject", async () => {
    modelSubject = "beta pipeline offer";
    const id = sentIntro(THREE.playName);
    atStep(id, THREE.playName, 2);
    const preview = await previewCadenceStep({ prospectId: id, playName: THREE.playName });
    if (!("subject" in preview)) throw new Error("expected a preview");
    expect(preview.subject).toBe("beta pipeline offer");
    expect(preview.payload).not.toHaveProperty("thread");
    expect(builderCtx).toEqual([{}]);
  });

  it("the last email step stays new when LinkedIn steps follow it", async () => {
    modelSubject = "beta pipeline offer";
    const id = sentIntro(NO_BREAKUP.playName);
    atStep(id, NO_BREAKUP.playName, 1);
    const preview = await previewCadenceStep({ prospectId: id, playName: NO_BREAKUP.playName });
    if (!("subject" in preview)) throw new Error("expected a preview");
    expect(preview.subject).toBe("beta pipeline offer");
    expect(preview.payload).not.toHaveProperty("thread");
  });

  it("a single follow-up + breakup sends a new email", async () => {
    const id = sentIntro(SINGLE.playName);
    await runCadenceStepForProspect({ prospectId: id, playName: SINGLE.playName, dryRun: false });
    expect(sends[0]).toMatchObject({ subject: "model subject" });
    expect(sends[0]?.thread).toBeUndefined();
  });

  it("the unattended runner threads a middle follow-up too", async () => {
    const id = sentIntro(THREE.playName, "oneshot");
    await runCadenceStepForProspect({ prospectId: id, playName: THREE.playName, dryRun: false });
    expect(sends[0]).toMatchObject({
      subject: `Re: ${INTRO_SUBJECT}`,
      thread: { identityId: "os", oneshotEmailId: "em-intro" },
    });
  });

  it("without a usable first email the follow-up keeps the model's subject", async () => {
    const id = sentIntro(THREE.playName, "none");
    const preview = await previewCadenceStep({ prospectId: id, playName: THREE.playName });
    if (!("subject" in preview)) throw new Error("expected a preview");
    expect(preview.subject).toBe("model subject");
    expect(preview.payload).not.toHaveProperty("thread");
  });
});
