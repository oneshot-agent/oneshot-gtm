import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      return { content: letterText };
    },
  };
});

const { effectiveSequence, enrollInCadence } = await import("../src/_cadence.ts");
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
  letterInputs.length = 0;
});
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
});
