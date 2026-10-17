import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@oneshot-gtm/core";
import { Ledger } from "../../core/src/ledger.ts";

// The multiplier sequence (#883): a letter at position 2 when the organization
// has a business address, one slow follow-up at day 10, and the LinkedIn
// continuation on unless the workspace or the trigger turns it off. A reply on
// any channel stops the whole cadence. Real ledger, stubbed model.

let ledger: Ledger;
let mailConfig: Record<string, { position: number; delayDays: number } | null> | null = null;
let linkedinContinuation: boolean | undefined;
let memberOffer: string | null;
const letterInputs: string[] = [];
const OFFER = "Up to $150 in credit for each member company, earned at milestones.";
const LETTER = `Dear Jordan,
Here is what I would offer your cohort: ${OFFER}
Founder`;
let letterText = LETTER;
/** The model's reply to a follow-up draft; the letter text otherwise. */
let followUpReply: string | null = null;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({
      founderName: "Founder",
      productOneLiner: "thing",
      cadenceOverrides: null,
      directMailMotions: mailConfig,
      linkedinContinuation,
      memberOffer,
      pilotOffer: "a pilot on our usual terms",
    }),
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async (input: { messages: Array<{ content: string }> }) => {
      letterInputs.push(input.messages[1]!.content);
      return { content: followUpReply ?? letterText };
    },
  };
});

const { effectiveSequence, enrollInCadence, getSequence, hardBanHold, previewCadenceStep } =
  await import("../src/_cadence.ts");
const { generateMailLetter } = await import("../src/_mail-letter.ts");
await import("../src/multiplier.ts"); // registers the sequence

const PLAY = "multiplier";
const address = {
  name: "Jordan Lee",
  address_line1: "1 Harbor St",
  address_city: "Boston",
  address_state: "MA",
  address_zip: "02110",
  address_country: "US" as const,
};

let seq = 0;
/** A fresh organization contact each call: the ledger upserts by email. */
function prospect(withAddress = true): number {
  return ledger.upsertProspect({
    name: "Jordan Lee",
    email: `jordan${++seq}@harbor.example`,
    company: "Harbor Founders Program",
    linkedin_url: "https://linkedin.com/in/jordan-lee-fake",
    ...(withAddress ? { businessAddress: address } : {}),
  });
}
const plan = (id: number) =>
  effectiveSequence(PLAY, id)!.steps.map((s) => `${s.channel}@${s.dayOffset}`);

beforeEach(() => {
  ledger = new Ledger(":memory:");
  mailConfig = null;
  linkedinContinuation = undefined;
  memberOffer = OFFER;
  letterText = LETTER;
  followUpReply = null;
  letterInputs.length = 0;
});

const OFFER_A = "Offer A: two seats free for each member company.";
/**
 * The cadence's originating send: trigger A's row, sent, then a newer pending
 * row from trigger B (another offer) and a rejected row from trigger C (an
 * explicit empty offer) for the same address.
 */
function sentFromTriggerA(id: number): void {
  const email = ledger.getProspectById(id)!.email!;
  ledger.upsertTrigger({ name: "orgA", configJson: JSON.stringify({ memberOffer: OFFER_A }) });
  ledger.upsertTrigger({
    name: "orgB",
    configJson: JSON.stringify({ memberOffer: "Offer B: $900 off the annual plan." }),
  });
  ledger.upsertTrigger({ name: "orgC", configJson: JSON.stringify({ memberOffer: "" }) });
  const row = (key: string, source: string) =>
    ledger.enqueueTarget({ playName: PLAY, payload: { email }, dedupeKey: key, source })!;
  ledger.setQueueStatus({ id: row(`a-${id}`, "find:orgA:1"), status: "sent" });
  row(`b-${id}`, "find:orgB:1");
  ledger.setQueueStatus({ id: row(`c-${id}`, "find:orgC:1"), status: "rejected" });
}
afterEach(() => ledger.close());

describe("multiplier sequence", () => {
  it("plans the letter at position 2 when a business address is found", () => {
    const id = prospect();
    enrollInCadence({ prospectId: id, playName: PLAY });
    expect(plan(id)).toEqual([
      "direct_mail@3",
      "email@10",
      "linkedin@3",
      "linkedin@2",
      "linkedin@6",
    ]);
  });

  it("skips the letter without a business address", () => {
    const id = prospect(false);
    enrollInCadence({ prospectId: id, playName: PLAY });
    expect(plan(id)).toEqual(["email@10", "linkedin@3", "linkedin@2", "linkedin@6"]);
  });

  it("leaves the letter out when directMailMotions.multiplier is null", () => {
    mailConfig = { multiplier: null };
    const id = prospect();
    enrollInCadence({ prospectId: id, playName: PLAY });
    expect(plan(id)).not.toContain("direct_mail@3");
  });

  it("schedules one follow-up email at day 10 that breaks on a reply", () => {
    const email = effectiveSequence(PLAY)!.steps.filter((s) => s.channel === "email");
    expect(email).toHaveLength(1);
    expect(email[0]).toMatchObject({ dayOffset: 10, breakOnReply: true });
  });

  it("carries on to LinkedIn by default, and not when the workspace says false", () => {
    const on = prospect(false);
    enrollInCadence({ prospectId: on, playName: PLAY });
    expect(plan(on).slice(-3)).toEqual(["linkedin@3", "linkedin@2", "linkedin@6"]);
    linkedinContinuation = false;
    const off = prospect(false);
    enrollInCadence({ prospectId: off, playName: PLAY });
    expect(plan(off)).toEqual(["email@10"]);
  });

  it("an explicit false on the trigger removes the LinkedIn steps", () => {
    ledger.upsertTrigger({
      name: "orgs",
      configJson: JSON.stringify({ linkedinContinuation: false }),
    });
    const id = prospect(false);
    enrollInCadence({ prospectId: id, playName: PLAY, queueSource: "find:orgs:1" });
    expect(plan(id)).toEqual(["email@10"]);
  });

  it("a workspace false is not overridden by a trigger true: either false turns it off", () => {
    linkedinContinuation = false;
    ledger.upsertTrigger({
      name: "orgs",
      configJson: JSON.stringify({ linkedinContinuation: true }),
    });
    const fromTrigger = prospect(false);
    enrollInCadence({ prospectId: fromTrigger, playName: PLAY, queueSource: "find:orgs:1" });
    expect(plan(fromTrigger)).toEqual(["email@10"]);

    const explicit = prospect(false);
    enrollInCadence({ prospectId: explicit, playName: PLAY, linkedinContinuation: true });
    expect(plan(explicit)).toEqual(["email@10"]);

    // And a workspace true with a trigger false is off as well.
    linkedinContinuation = true;
    const vetoed = prospect(false);
    enrollInCadence({ prospectId: vetoed, playName: PLAY, linkedinContinuation: false });
    expect(plan(vetoed)).toEqual(["email@10"]);
  });

  it("a reply on any channel stops the whole cadence", () => {
    const byEmail = prospect();
    enrollInCadence({ prospectId: byEmail, playName: PLAY });
    ledger.recordProspectReply(byEmail, { subject: "Re: for your cohort" });
    expect(ledger.getCadence(byEmail, PLAY)?.status).toBe("replied");

    const onLinkedIn = prospect();
    enrollInCadence({ prospectId: onLinkedIn, playName: PLAY });
    ledger.recordLinkedInReply({
      prospectId: onLinkedIn,
      source: "linkedin",
      externalEventId: "m-1",
      occurredAt: "2026-10-02T09:00:00Z",
      body: "happy to talk",
    });
    expect(ledger.getCadence(onLinkedIn, PLAY)?.status).toBe("replied");
  });
});

describe("multiplier letter", () => {
  it("proposes the member offer as the offer and its terms, not pilotOffer", async () => {
    const id = prospect();
    const text = await generateMailLetter(id, PLAY);
    expect(text).toContain("$150");
    const input = JSON.parse(letterInputs[0]!);
    expect(input.offerTerms).toBe(memberOffer);
    expect(input.offer.what).toBe(memberOffer);
    expect(letterInputs[0]).not.toContain("usual terms");
  });

  it("refuses a letter that adds a price the member offer does not contain", async () => {
    letterText = `Dear Jordan,
${OFFER} The sprint normally costs $2,000.
Founder`;
    await expect(generateMailLetter(prospect(), PLAY)).rejects.toThrow(/does not contain/);
  });

  it("refuses to generate a letter with memberOffer empty", async () => {
    memberOffer = null;
    await expect(generateMailLetter(prospect(), PLAY)).rejects.toThrow(/set memberOffer/);
    expect(letterInputs).toEqual([]);
  });

  it("proposes the offer of the trigger whose row was sent, not a newer row's from another trigger", async () => {
    const id = prospect();
    sentFromTriggerA(id);
    letterText = `Dear Jordan,\n${OFFER_A}\nFounder`;
    const text = await generateMailLetter(id, PLAY);
    expect(text).toContain(OFFER_A);
    const input = JSON.parse(letterInputs[0]!);
    expect(input.offer.what).toBe(OFFER_A);
    expect(input.offerTerms).toBe(OFFER_A);
    // The terms are A's: B's price is one the offer does not contain.
    letterText = `Dear Jordan,\nOffer B: $900 off the annual plan.\nFounder`;
    await expect(generateMailLetter(id, PLAY)).rejects.toThrow(/does not contain/);
  });
});

describe("multiplier follow-up", () => {
  const step = () => getSequence(PLAY)!.steps.find((s) => s.channel === "email")!;
  async function followUp(id: number, body: string) {
    followUpReply = JSON.stringify({ subject: "checking in", body });
    const built = await step().builder({
      prospect: ledger.getProspectById(id)!,
      cfg: loadConfig(),
      metadata: {},
    });
    return built!;
  }

  it("holds a follow-up with an invented price or a link, and clears one restating the member offer", async () => {
    const id = prospect(false);
    const priced = await followUp(id, "The member session is $500. Interested?");
    expect(priced).toMatchObject({ kind: "email", hardBans: true, hardBanAllow: [OFFER] });
    expect(hardBanHold(priced)).toEqual(["hard-ban:price"]);
    const linked = await followUp(id, "Details at https://thing.example/perks. Interested?");
    expect(hardBanHold(linked)).toEqual(["hard-ban:link"]);
    const restated = await followUp(id, `The offer stands: ${OFFER} Worth a look?`);
    expect(hardBanHold(restated)).toEqual([]);
  });

  it("keeps the member offer verbatim through the follow-up's cleanup and preview lints", async () => {
    memberOffer = "A month’s trial — with $50 credit for “each” member.";
    const id = prospect(false);
    const restated = await followUp(
      id,
      `The offer stands — “as before”: ${memberOffer} Worth a look?`,
    );
    // The founder's punctuation comes through; the model's own is cleaned.
    expect(restated).toMatchObject({
      kind: "email",
      body: `The offer stands, "as before": ${memberOffer} Worth a look?`,
      hardBanAllow: [memberOffer],
    });
    expect(hardBanHold(restated)).toEqual([]);
    // The previewed step (the follow-up: no address, so no letter) carries no
    // hold for the offer's own quotes or its price.
    enrollInCadence({ prospectId: id, playName: PLAY });
    const preview = await previewCadenceStep({ prospectId: id, playName: PLAY });
    expect(preview).toMatchObject({ flags: [], body: expect.stringContaining(memberOffer) });
  });

  it("allows the offer of the trigger whose row was sent, and holds the workspace's price", async () => {
    const id = prospect(false);
    sentFromTriggerA(id);
    const restated = await followUp(id, `The offer stands: ${OFFER_A} Worth a look?`);
    expect(restated).toMatchObject({ hardBanAllow: [OFFER_A] });
    expect(hardBanHold(restated)).toEqual([]);
    expect(hardBanHold(await followUp(id, `The offer stands: ${OFFER} Worth a look?`))).toEqual([
      "hard-ban:price",
    ]);
  });
});
