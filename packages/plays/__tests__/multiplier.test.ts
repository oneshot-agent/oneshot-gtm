import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The multiplier play (#883) pitches an organization that serves many of the
// founder's buyers. Its one offer is `memberOffer`, founder truth from config
// (or the trigger's), quoted verbatim: the model never writes it, a price inside
// it passes the hard bans, and a price the model adds anywhere else still flags.

const calls = {
  llmInputBlocks: [] as string[],
  replies: [] as string[],
  enrich: 0,
  search: 0,
  prospectMeta: [] as Array<Record<string, unknown>>,
};
let memberOffer: string | null = null;
let triggerConfig: string | null = null;

const OFFER =
  "A two-week GTM sprint for your cohort: a 30-minute setup for each company, up to $150 in credit earned as they go ($25 at setup, $50 after their first 100 sends), and a free trial of the benchmark at the end.";

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
      memberOffer,
    }),
    enrichProfile: async () => {
      calls.enrich++;
      return { result: { profile: {} }, receiptId: 1 };
    },
    webSearch: async () => {
      calls.search++;
      return {
        result: { results: [{ url: "https://org.example/perks", title: "Perks", snippet: "x" }] },
        receiptId: 2,
      };
    },
    sendEmail: async () => ({ receiptId: 3 }),
    getLedger: () => ({
      upsertProspect: (meta: Record<string, unknown>) => {
        calls.prospectMeta.push(meta);
        return 1;
      },
      recordSequenceEvent: () => 1,
      hasSentSequenceEvent: () => false,
      findProspectByEmail: () => null,
      getProspectById: () => null,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      setProspectIcpVerdict: () => {},
      getTrigger: (name: string) =>
        name === "orgs" && triggerConfig !== null ? { config_json: triggerConfig } : null,
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
      return {
        content: calls.replies.shift() ?? JSON.stringify({ subject: "s", body: "b" }),
        provider: "t",
        model: "t",
      };
    },
  };
});

const { runMultiplier, multiplierDraftFlags } = await import("../src/multiplier.ts");
const { hardBanFlags } = await import("../src/_lib.ts");

const base = {
  organization: "Harbor Founders Program",
  orgType: "accelerator" as const,
  name: "Jordan Lee",
  email: "jordan@harbor.example",
  role: "Head of Partnerships",
  memberDescription: "Forty pre-seed B2B software companies a year.",
  whyFit: "Each cohort company has to find its first twenty customers in six months.",
};

/** A draft whose body quotes the offer whole, plus `extra` text the model wrote around it. */
const quoting = (extra = "") =>
  JSON.stringify({
    subject: "for your cohort",
    body: `Here is what I would offer: ${OFFER} ${extra}`,
  });

beforeEach(() => {
  calls.llmInputBlocks = [];
  calls.replies = [];
  calls.enrich = 0;
  calls.search = 0;
  calls.prospectMeta = [];
  memberOffer = OFFER;
  triggerConfig = null;
});
afterEach(() => vi.clearAllMocks());

describe("runMultiplier — the member offer", () => {
  it("refuses before any paid call when memberOffer is empty", async () => {
    memberOffer = "  ";
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(drafted[0]!.flags[0]).toMatch(/^error: multiplier: memberOffer is empty/);
    expect(drafted[0]!.sent).toBe(false);
    expect(calls.enrich).toBe(0);
    expect(calls.search).toBe(0);
    expect(calls.llmInputBlocks).toEqual([]);
  });

  it("hands the model the offer verbatim and keeps a draft that quotes it", async () => {
    calls.replies.push(quoting());
    const { drafted } = await runMultiplier({ dryRun: true, targets: [base] });
    expect(calls.llmInputBlocks[0]).toContain(`MEMBER OFFER: ${OFFER}`);
    expect(drafted[0]!.body).toContain(OFFER);
    expect(drafted[0]!.flags).not.toContain("hard-ban:price");
    expect(drafted[0]!.flags).not.toContain("hard-ban:discount-offer");
  });

  it("flags a price or discount the model adds outside the quoted offer", async () => {
    calls.replies.push(quoting("Normally this runs $2,000 per company."));
    const priced = await runMultiplier({ dryRun: true, targets: [base] });
    expect(priced.drafted[0]!.flags).toContain("hard-ban:price");

    calls.replies.push(quoting("Your members also get a discount on the annual plan."));
    const discounted = await runMultiplier({ dryRun: true, targets: [base] });
    expect(discounted.drafted[0]!.flags).toContain("hard-ban:discount-offer");
  });

  it("still flags a link, inside or outside the offer", async () => {
    calls.replies.push(quoting("Details at https://thing.example/perks"));
    const { drafted } = await runMultiplier({ dryRun: true, targets: [base] });
    expect(drafted[0]!.flags).toContain("hard-ban:link");
    expect(hardBanFlags("see www.thing.example", ["see www.thing.example"])).toEqual([
      "hard-ban:link",
    ]);
  });

  it("matches the allowed span across the model's line wrapping", () => {
    const wrapped = OFFER.replace("a 30-minute setup", "a 30-minute\nsetup");
    expect(hardBanFlags(`Offer:\n${wrapped}\nFounder`, [OFFER])).toEqual([]);
    expect(hardBanFlags(`Offer:\n${wrapped}\nAlso $9 extra`, [OFFER])).toEqual(["hard-ban:price"]);
  });

  it("holds a draft that omits the offer instead of sending it", async () => {
    calls.replies.push(
      JSON.stringify({ subject: "for your cohort", body: "I would offer your cohort a sprint." }),
    );
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(drafted[0]!.flags).toContain("multiplier:offer-missing");
    expect(drafted[0]!.sent).toBe(false);
    // Nothing rewrote the offer into the draft in the model's place.
    expect(drafted[0]!.body).not.toContain(OFFER);
  });

  it("holds a paraphrased offer, and one whose figure the model changed also trips the price ban", async () => {
    calls.replies.push(
      quoting().replace("a 30-minute setup for each company", "a short setup for each company"),
    );
    const paraphrased = await runMultiplier({ dryRun: false, targets: [base] });
    expect(paraphrased.drafted[0]!.flags).toContain("multiplier:offer-missing");
    expect(paraphrased.drafted[0]!.sent).toBe(false);

    calls.replies.push(quoting().replace("up to $150 in credit", "up to $1500 in credit"));
    const embellished = await runMultiplier({ dryRun: false, targets: [base] });
    expect(embellished.drafted[0]!.flags).toEqual(
      expect.arrayContaining(["multiplier:offer-missing", "hard-ban:price"]),
    );
    expect(embellished.drafted[0]!.sent).toBe(false);
  });

  it("sends a draft that quotes the offer whole, re-wrapped across lines", async () => {
    const wrapped = OFFER.replace("a 30-minute setup", "a 30-minute\nsetup").replace(
      "and a free trial",
      "and a\n  free trial",
    );
    calls.replies.push(
      JSON.stringify({
        subject: "for your cohort",
        body: `Here is what I would offer:\n${wrapped}`,
      }),
    );
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(drafted[0]!.flags).toEqual([]);
    expect(drafted[0]!.sent).toBe(true);
  });

  it("a price glued to the quoted offer still flags: the allowed span is the offer alone", () => {
    expect(hardBanFlags(`${OFFER}$500 after that.`, [OFFER])).toEqual(["hard-ban:price"]);
    expect(hardBanFlags(`Waive the $99 fee.${OFFER}`, [OFFER])).toEqual(["hard-ban:price"]);
    expect(multiplierDraftFlags(`${OFFER}$500 after that.`, OFFER)).toEqual([]);
  });

  it("keeps the offer through a writing repair: a retry that drops it is not adopted", async () => {
    // First draft quotes the offer but has two exclamation marks; the repair
    // retry fixes those and drops the offer, so the first draft is kept, held.
    calls.replies.push(quoting("Happy to tailor it! Ask me anything!"));
    calls.replies.push(
      JSON.stringify({ subject: "for your cohort", body: "A sprint for your cohort. Ask me." }),
    );
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(calls.llmInputBlocks).toHaveLength(2);
    expect(drafted[0]!.body).toContain(OFFER);
    expect(drafted[0]!.flags).toContain("excess-exclamations");
    expect(drafted[0]!.flags).not.toContain("multiplier:offer-missing");
    expect(drafted[0]!.sent).toBe(false);
  });

  it("reads the trigger's memberOffer over the workspace's", async () => {
    triggerConfig = JSON.stringify({ memberOffer: "Three months free for every member." });
    await runMultiplier({ dryRun: true, targets: [base], queueSource: "find:orgs:1" });
    expect(calls.llmInputBlocks[0]).toContain("MEMBER OFFER: Three months free for every member.");
    expect(calls.llmInputBlocks[0]).not.toContain(OFFER);
  });
});

describe("runMultiplier — the row", () => {
  it("names the introducer only when the row sets one", async () => {
    calls.replies.push(quoting());
    const plain = await runMultiplier({ dryRun: false, targets: [base] });
    expect(calls.llmInputBlocks[0]).not.toContain("INTRODUCED BY");
    expect(plain.drafted[0]!.body).not.toContain("Sam Ortiz");
    expect(plain.drafted[0]!.sent).toBe(true);

    calls.replies.push(quoting("Sam Ortiz suggested I write to you."));
    const introduced = await runMultiplier({
      dryRun: false,
      targets: [{ ...base, introducedBy: "Sam Ortiz" }],
    });
    expect(calls.llmInputBlocks[1]).toContain("INTRODUCED BY: Sam Ortiz");
    expect(introduced.drafted[0]!.body).toContain("Sam Ortiz");
    expect(introduced.drafted[0]!.flags).toEqual([]);
    expect(introduced.drafted[0]!.sent).toBe(true);
  });

  it("holds a draft that leaves a named introducer out", async () => {
    calls.replies.push(quoting());
    const { drafted } = await runMultiplier({
      dryRun: false,
      targets: [{ ...base, introducedBy: "Sam Ortiz" }],
    });
    expect(drafted[0]!.flags).toEqual(["multiplier:introducer-missing"]);
    expect(drafted[0]!.sent).toBe(false);
  });

  it("states a member count only when the row carries one, as a number or from a form", async () => {
    await runMultiplier({ dryRun: true, targets: [base] });
    expect(calls.llmInputBlocks[0]).not.toContain("MEMBER COUNT");
    await runMultiplier({ dryRun: true, targets: [{ ...base, memberCount: "40" }] });
    expect(calls.llmInputBlocks[1]).toContain("MEMBER COUNT: 40");
  });

  it("records the prospect with source multiplier-<orgType> and the organization as company", async () => {
    calls.replies.push(quoting());
    const { drafted } = await runMultiplier({
      dryRun: false,
      targets: [{ ...base, orgType: "association" }],
    });
    expect(drafted[0]!.sent).toBe(true);
    expect(calls.search).toBe(1);
    expect(calls.prospectMeta[0]).toMatchObject({
      source: "multiplier-association",
      company: "Harbor Founders Program",
      email: base.email,
    });
    expect(calls.llmInputBlocks[0]).toContain("ORGANIZATION SITE SEARCH");
  });

  it("does not search the organization's site on a dry run", async () => {
    await runMultiplier({ dryRun: true, targets: [base] });
    expect(calls.enrich).toBe(1);
    expect(calls.search).toBe(0);
  });
});
