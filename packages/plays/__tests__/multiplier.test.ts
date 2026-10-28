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
/** Saved trigger configs by name; a trigger not listed does not exist. */
let triggers: Record<string, string> = {};

const OFFER =
  "A two-week onboarding sprint for your cohort: a 30-minute setup for each company, up to $300 in onboarding hours earned as they go ($40 at setup, $80 after their first ten booked jobs), and a free trial of the reporting add-on at the end.";

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
      getTrigger: (name: string) => (name in triggers ? { config_json: triggers[name]! } : null),
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

const { runMultiplier, multiplierDraftFlags, multiplierPreflight } =
  await import("../src/multiplier.ts");
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
  triggers = {};
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

    calls.replies.push(
      quoting().replace("up to $300 in onboarding hours", "up to $3000 in onboarding hours"),
    );
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
    triggers["orgs"] = JSON.stringify({ memberOffer: "Three months free for every member." });
    await runMultiplier({ dryRun: true, targets: [base], queueSource: "find:orgs:1" });
    expect(calls.llmInputBlocks[0]).toContain("MEMBER OFFER: Three months free for every member.");
    expect(calls.llmInputBlocks[0]).not.toContain(OFFER);
  });

  it("a batch from the queue pitches each row's own trigger offer, and a manual row the workspace's", async () => {
    triggers["orgA"] = JSON.stringify({ memberOffer: "Offer A: two seats free for each member." });
    triggers["orgB"] = JSON.stringify({ memberOffer: "Offer B: a free month for each member." });
    const rows = [
      { ...base, organization: "Org A" },
      { ...base, organization: "Org B", email: "b@b.example" },
      { ...base, organization: "Manual Org", email: "m@m.example" },
    ];
    await runMultiplier({
      dryRun: true,
      targets: rows,
      queueSources: ["find:orgA:1", "find:orgB:1", null],
    });
    const block = (org: string) =>
      calls.llmInputBlocks.find((b) => b.includes(`ORGANIZATION: ${org}`)) ?? "";
    expect(block("Org A")).toContain("MEMBER OFFER: Offer A: two seats free for each member.");
    expect(block("Org B")).toContain("MEMBER OFFER: Offer B: a free month for each member.");
    expect(block("Manual Org")).toContain(`MEMBER OFFER: ${OFFER}`);
  });

  it("keeps the row's trigger offer when angle selection drafts from a copy of the target", async () => {
    // A queue row hydrated with a multi-angle `yourEdge` and the arm split:
    // the executor picks one angle into a copy of the target before the
    // prompt sees it. The prompt, the allowed span and the verbatim check
    // must still all read the row's own trigger offer, not the workspace's.
    const offerA = "Offer A: two seats free for each member.";
    triggers["orgA"] = JSON.stringify({ memberOffer: offerA });
    const row = { ...base, yourEdge: "first angle // second angle", angleAssignment: "arm" };
    calls.replies.push(JSON.stringify({ subject: "s", body: `My offer: ${offerA} Any use?` }));
    const { drafted } = await runMultiplier({
      dryRun: false,
      targets: [row],
      queueSources: ["find:orgA:1"],
    });
    expect(calls.llmInputBlocks[0]).toContain(`MEMBER OFFER: ${offerA}`);
    expect(calls.llmInputBlocks[0]).not.toContain(OFFER);
    expect(drafted[0]!.flags).toEqual([]);
    expect(drafted[0]!.sent).toBe(true);

    // Trigger-only configuration: the workspace has no offer, the row's trigger does.
    memberOffer = null;
    calls.replies.push(JSON.stringify({ subject: "s", body: `My offer: ${offerA} Any use?` }));
    const triggerOnly = await runMultiplier({
      dryRun: false,
      targets: [row],
      queueSources: ["find:orgA:1"],
    });
    expect(calls.llmInputBlocks[1]).toContain(`MEMBER OFFER: ${offerA}`);
    expect(triggerOnly.drafted[0]!.flags).toEqual([]);
    expect(triggerOnly.drafted[0]!.sent).toBe(true);
  });

  // The founder's own typographic apostrophe, quotes and em dash.
  const TYPOGRAPHIC = "A month’s trial — with $50 credit for “each” member.";
  const STRAIGHTENED = `A month's trial, with $50 credit for "each" member.`;

  it("keeps the offer verbatim through cleanup: its own punctuation survives, the model's is straightened", async () => {
    memberOffer = TYPOGRAPHIC;
    calls.replies.push(
      JSON.stringify({
        subject: "for your cohort",
        body: `The offer — in the founder’s words: ${TYPOGRAPHIC} Any use?`,
      }),
    );
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(drafted[0]!.flags).toEqual([]);
    expect(drafted[0]!.sent).toBe(true);
    expect(drafted[0]!.body).toContain(TYPOGRAPHIC);
    expect(drafted[0]!.body).not.toContain(STRAIGHTENED);
    // The model's own em dash and apostrophe around it were still cleaned.
    expect(drafted[0]!.body).toBe(`The offer, in the founder's words: ${TYPOGRAPHIC} Any use?`);

    calls.replies.push(
      JSON.stringify({ subject: "for your cohort", body: `${TYPOGRAPHIC} Normally $900.` }),
    );
    const priced = await runMultiplier({ dryRun: false, targets: [base] });
    expect(priced.drafted[0]!.flags).toEqual(["hard-ban:price"]);
    expect(priced.drafted[0]!.sent).toBe(false);
  });

  it("holds an offer quoted in other punctuation or case: only the founder's exact text is verbatim", async () => {
    memberOffer = TYPOGRAPHIC;
    calls.replies.push(
      JSON.stringify({ subject: "for your cohort", body: `The offer: ${STRAIGHTENED} Any use?` }),
    );
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(drafted[0]!.flags).toEqual(
      expect.arrayContaining(["multiplier:offer-missing", "hard-ban:price"]),
    );
    expect(drafted[0]!.sent).toBe(false);
    expect(multiplierDraftFlags(`The offer: ${TYPOGRAPHIC.toLowerCase()}`, TYPOGRAPHIC)).toEqual([
      "multiplier:offer-missing",
    ]);
    expect(hardBanFlags(`The offer: ${TYPOGRAPHIC.toUpperCase()}`, [TYPOGRAPHIC])).toEqual([
      "hard-ban:price",
    ]);
  });

  it("keeps the offer verbatim through a writing repair's redraft", async () => {
    memberOffer = TYPOGRAPHIC;
    calls.replies.push(
      JSON.stringify({
        subject: "for your cohort",
        body: `${TYPOGRAPHIC} Happy to tailor it! Ask me anything!`,
      }),
    );
    calls.replies.push(
      JSON.stringify({
        subject: "for your cohort",
        body: `${TYPOGRAPHIC} Happy to tailor it. Ask me anything?`,
      }),
    );
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(calls.llmInputBlocks).toHaveLength(2);
    expect(drafted[0]!.flags).toEqual([]);
    expect(drafted[0]!.sent).toBe(true);
    expect(drafted[0]!.body).toBe(`${TYPOGRAPHIC} Happy to tailor it. Ask me anything?`);
  });

  it("an offer ending in a number does not exempt a larger invented amount that begins with it", async () => {
    memberOffer = "A credit of $300";
    expect(hardBanFlags("A credit of $3000 for each member.", [memberOffer])).toEqual([
      "hard-ban:price",
    ]);
    expect(hardBanFlags("A credit of $300.50 for each member.", [memberOffer])).toEqual([
      "hard-ban:price",
    ]);
    expect(hardBanFlags("A credit of $300. For each member.", [memberOffer])).toEqual([]);
    expect(multiplierDraftFlags("A credit of $3000 for each member.", memberOffer)).toEqual([
      "multiplier:offer-missing",
    ]);
    // The model keeps the embellished figure on the repair turn too.
    const embellished = JSON.stringify({
      subject: "for your cohort",
      body: "I would offer: A credit of $3000 for each member.",
    });
    calls.replies.push(embellished, embellished);
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(drafted[0]!.flags).toEqual(
      expect.arrayContaining(["multiplier:offer-missing", "hard-ban:price"]),
    );
    expect(drafted[0]!.sent).toBe(false);
  });

  it("an offer ending in a number and a period or comma does not exempt the number going on past it", async () => {
    memberOffer = "A credit of $300.";
    expect(
      hardBanFlags("I would offer: A credit of $300.50 for each member.", [memberOffer]),
    ).toEqual(["hard-ban:price"]);
    expect(hardBanFlags("A credit of $300. For each member.", [memberOffer])).toEqual([]);
    expect(
      multiplierDraftFlags("I would offer: A credit of $300.50 for each member.", memberOffer),
    ).toEqual(["multiplier:offer-missing"]);
    expect(hardBanFlags("A credit of $300,000 a year.", ["A credit of $300,"])).toEqual([
      "hard-ban:price",
    ]);
    expect(hardBanFlags("A credit of $300, paid monthly.", ["A credit of $300,"])).toEqual([]);
    // The model keeps the embellished figure on the repair turn too.
    const embellished = JSON.stringify({
      subject: "for your cohort",
      body: "I would offer: A credit of $300.50 for each member.",
    });
    calls.replies.push(embellished, embellished);
    const { drafted } = await runMultiplier({ dryRun: false, targets: [base] });
    expect(drafted[0]!.flags).toEqual(
      expect.arrayContaining(["multiplier:offer-missing", "hard-ban:price"]),
    );
    expect(drafted[0]!.sent).toBe(false);
  });
});

describe("multiplierPreflight", () => {
  it("throws before anything is billed when any target's offer is empty, the trigger's or the workspace's", () => {
    memberOffer = " ";
    expect(() => multiplierPreflight([base])).toThrow(/memberOffer is empty/);
    triggers["orgs"] = JSON.stringify({ memberOffer: "Three months free for every member." });
    expect(() => multiplierPreflight([base], ["find:orgs:1"])).not.toThrow();
    memberOffer = OFFER;
    triggers["orgs"] = JSON.stringify({ memberOffer: "" });
    expect(() => multiplierPreflight([base, base], [null, "find:orgs:1"])).toThrow(
      /memberOffer is empty/,
    );
    expect(calls.enrich + calls.search + calls.llmInputBlocks.length).toBe(0);
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
