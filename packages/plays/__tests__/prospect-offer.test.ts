import { beforeEach, describe, expect, it, vi } from "vitest";

// The prospect offer: written from research, linted on its output alone,
// stored once and carried to every touch.

const llm = { replies: [] as string[], inputs: [] as string[] };
const cfg = {
  founderName: "Founder",
  productOneLiner: "Acme schedules field crews",
  productBrief:
    "Acme plans crew routes, books jobs into open slots and texts customers the arrival time.",
  pilotOffer: "a free month on one depot",
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, loadConfig: () => cfg, logEvent: () => {}, getCachedNewsfeed: () => null };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      llm.inputs.push(input.messages.at(-1)?.content ?? "");
      return { content: llm.replies.shift() ?? "{}", provider: "t", model: "t" };
    },
  };
});

const {
  deriveOffer,
  deriveOffers,
  deriveOfferSet,
  lintOffer,
  lintOfferAngle,
  offerBlock,
  offerForDraft,
  offerResearchText,
  OFFER_PROMPT_VERSION,
  playMakesOffer,
} = await import("../src/_prospect-offer.ts");

const target = {
  name: "Dana Lee",
  company: "Northside Plumbing",
  title: "Operations Manager",
  email: "dana@northside.example",
  signal: "opened a second depot in Leeds",
};

const good = {
  offer: "get the leeds depot's crews booked into same-day slots without a dispatcher",
  steps: "plans crew routes, books jobs into open slots and texts customers the arrival time",
  evidence: ["opened a second depot in Leeds"],
  stage: "established local business",
  level: "researched",
  return: "same-day jobs the leeds depot would otherwise turn away, counted per booked job",
};

beforeEach(() => {
  llm.replies = [];
  llm.inputs = [];
});

describe("offerResearchText", () => {
  it("carries the row's own facts, never its edge or address", () => {
    const text = offerResearchText({ ...target, yourEdge: "secret argument" });
    expect(text).toContain("opened a second depot in Leeds");
    expect(text).not.toContain("secret argument");
    expect(text).not.toContain("dana@northside.example");
  });
});

describe("lintOffer", () => {
  const research = offerResearchText(target);
  it("passes an offer grounded in the research", () => {
    expect(lintOffer({ ...good, level: "researched" }, research)).toEqual([]);
  });
  it("flags a number the research does not have", () => {
    const flags = lintOffer(
      { ...good, level: "researched", offer: "book 40 jobs a day in leeds" },
      research,
    );
    expect(flags).toContain("number-not-in-research:40");
  });
  it("flags evidence that is not a quote from the research", () => {
    const flags = lintOffer(
      { ...good, level: "researched", evidence: ["runs ten depots"] },
      research,
    );
    expect(flags.some((f) => f.startsWith("evidence-not-in-research"))).toBe(true);
  });
  it("flags an observation, a price and a link", () => {
    const flags = lintOffer(
      { ...good, level: "researched", offer: "saw you opened leeds; $99 at acme.com" },
      research,
    );
    expect(flags).toEqual(expect.arrayContaining(["observation", "price", "link"]));
  });
  it("flags a guarantee", () => {
    const flags = lintOffer(
      { ...good, level: "researched", offer: "guarantee same-day slots for the leeds depot" },
      research,
    );
    expect(flags).toContain("guarantee");
  });
  it("flags an offer that reuses the product's own wording", () => {
    const flags = lintOffer(
      { ...good, level: "researched", offer: "books jobs into open slots for the leeds depot" },
      research,
      cfg.productBrief,
    );
    expect(flags.some((f) => f.startsWith("offer-echoes-product"))).toBe(true);
  });
  it("catches the product's wording even when it is rephrased", () => {
    const flags = lintOffer(
      {
        ...good,
        level: "researched",
        offer: "get leeds depot crews routed and booked, open slot by open slot",
      },
      research,
      "Acme plans crew routes and fills every open slot.",
      "Acme fills every open slot.",
    );
    expect(flags.some((f) => f.startsWith("offer-echoes-product") && f.includes("open slot"))).toBe(
      true,
    );
  });
  it("allows a pair their own research uses", () => {
    const own = offerResearchText({ ...target, signal: "every open slot is a lost job" });
    const flags = lintOffer(
      {
        ...good,
        level: "researched",
        evidence: ["every open slot is a lost job"],
        offer: "fill the leeds depot's open slots",
      },
      own,
      "Acme fills every open slot.",
      "Acme fills every open slot.",
    );
    expect(flags.some((f) => f.startsWith("offer-echoes-product"))).toBe(false);
  });
  it("lets a role-level offer go without evidence", () => {
    expect(lintOffer({ ...good, level: "role", evidence: [] }, research)).toEqual([]);
  });
  it("flags an offer that watches instead of doing", () => {
    for (const offer of [
      "track leeds depot bookings across every crew",
      "monitor same-day demand at the leeds depot",
      "keep the leeds depot's crew rota aligned with demand",
      "give the leeds depot visibility into missed jobs",
    ]) {
      expect(lintOffer({ ...good, level: "researched", offer }, research)).toContain(
        "offer-not-execution",
      );
    }
  });
  it("needs a return on a researched offer, not on a role-level one", () => {
    const { return: _ret, ...bare } = good;
    expect(lintOffer({ ...bare, level: "researched" }, research)).toContain("no-return");
    expect(lintOffer({ ...bare, level: "role", evidence: [] }, research)).toEqual([]);
  });
  it("checks the return's numbers against the research", () => {
    expect(
      lintOffer({ ...good, level: "researched", return: "40 more jobs a week" }, research),
    ).toContain("number-not-in-research:40");
  });
});

describe("lintOfferAngle", () => {
  const research = offerResearchText(target);
  it("passes a reason the job pays back", () => {
    expect(
      lintOfferAngle(
        "Every same-day call the second depot turns away goes to a rival, so filling those slots is revenue the crews already have time for.",
        research,
        cfg.productBrief,
      ),
    ).toEqual([]);
  });
  it("flags an angle that leads with watching, a number from nowhere, or a joined pair", () => {
    expect(lintOfferAngle("Track every open slot in Leeds.", research, "")).toContain(
      "awareness-lead",
    );
    expect(lintOfferAngle("Saves 12 hours a week.", research, "")).toContain("number:12");
    expect(lintOfferAngle("one // two", research, "")).toContain("separator");
  });
});

const second = {
  ...good,
  offer: "fill the leeds depot's cancelled slots with waiting jobs the same morning",
  return: "slots refilled after a cancellation, counted per job",
};
const angles = [
  "A same-day call the depot cannot take goes to a rival, so every filled slot is a job kept.",
  "The second depot doubled the slots to fill while dispatch stayed one person.",
];

describe("deriveOffers", () => {
  it("keeps the ranked offers that pass, in the model's order", async () => {
    llm.replies = [JSON.stringify({ offers: [good, second] })];
    const offers = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer]);
    expect(offers[0]?.return).toBe(good.return);
  });

  it("asks again for the ones that fail, keeping those that passed", async () => {
    const watching = { ...second, offer: "monitor cancellations at the leeds depot" };
    llm.replies = [
      JSON.stringify({ offers: [good, watching] }),
      JSON.stringify({ offers: [good, second] }),
    ];
    const offers = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[1]).toContain("offer 2: offer-not-execution");
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer]);
  });
});

describe("deriveOfferSet", () => {
  it("makes the best offer active and writes its angles", async () => {
    llm.replies = [
      JSON.stringify({ offers: [good, second] }),
      JSON.stringify({ angles: [...angles, "Monitor every slot."] }),
    ];
    const set = await deriveOfferSet({
      target: { ...target, yourEdge: "Founder reason one // Founder reason two" },
      playName: "new-business",
    });
    expect(set?.offer.offer).toBe(good.offer);
    // The angle leading with watching is dropped.
    expect(set?.offer.angles).toEqual(angles);
    expect(set?.candidates.map((c) => c.offer)).toEqual([good.offer, second.offer]);
    expect(llm.inputs[1]).toContain(`OFFER: ${good.offer}`);
    expect(llm.inputs[1]).toContain(
      "FOUNDER'S ANGLES:\n- Founder reason one\n- Founder reason two",
    );
  });
});

describe("deriveOffer", () => {
  it("writes an offer from the brief and the research", async () => {
    llm.replies = [JSON.stringify(good)];
    const offer = await deriveOffer({ target, playName: "new-business" });
    expect(offer?.offer).toBe(good.offer);
    expect(offer?.version).toBe(OFFER_PROMPT_VERSION);
    expect(llm.inputs[0]).toContain("PRODUCT BRIEF:");
    expect(llm.inputs[0]).toContain("OFFER TERMS: a free month on one depot");
  });

  it("repairs once, then gives up", async () => {
    const bad = JSON.stringify({ ...good, offer: "book 40 jobs a day" });
    llm.replies = [bad, bad];
    expect(await deriveOffer({ target, playName: "new-business" })).toBeNull();
    expect(llm.inputs[1]).toContain("number-not-in-research:40");
  });

  it("writes nothing for a play that makes no offer", async () => {
    expect(playMakesOffer("discovery-interview")).toBe(false);
    expect(await deriveOffer({ target, playName: "discovery-interview" })).toBeNull();
    expect(llm.inputs).toHaveLength(0);
  });
});

describe("offerForDraft", () => {
  it("keeps a stored offer of the current version without a model call", async () => {
    const { offerProductHash } = await import("../src/_prospect-offer.ts");
    const stored = {
      productHash: offerProductHash(cfg),
      ...good,
      level: "researched" as const,
      version: OFFER_PROMPT_VERSION,
      inputHash: "x",
      derivedAt: "",
    };
    expect(
      await offerForDraft({ target: { ...target, offer: stored }, playName: "new-business" }),
    ).toBe(stored);
    expect(llm.inputs).toHaveLength(0);
  });

  it("keeps a founder-edited offer whatever its version", async () => {
    const stored = {
      ...good,
      level: "researched" as const,
      version: "old",
      inputHash: "x",
      derivedAt: "",
      editedBy: "founder" as const,
    };
    expect(
      await offerForDraft({ target: { ...target, offer: stored }, playName: "new-business" }),
    ).toBe(stored);
  });

  it("re-writes an outdated one", async () => {
    llm.replies = [JSON.stringify(good)];
    const stored = {
      ...good,
      offer: "old offer",
      level: "researched" as const,
      version: "old",
      inputHash: "x",
      derivedAt: "",
    };
    const out = await offerForDraft({
      target: { ...target, offer: stored },
      playName: "new-business",
    });
    expect(out?.offer).toBe(good.offer);
  });
});

describe("offerBlock", () => {
  it("gives the writer the offer, how, terms and brief", () => {
    const block = offerBlock(good, cfg, "new-business")!;
    expect(block).toContain(
      `OFFER (what you offer to do for them; the message opens with it): ${good.offer}`,
    );
    expect(block).toContain("HOW (");
    expect(block).toContain(`RETURN (what they get back when it is done): ${good.return}`);
    expect(block).toContain("OFFER TERMS");
    expect(block).toContain("PRODUCT BRIEF");
  });
  it("is absent for a play that makes no offer", () => {
    expect(offerBlock(good, cfg, "pmf-survey")).toBeNull();
  });
  it("leaves the terms off accelerator-batch", () => {
    expect(offerBlock(good, cfg, "accelerator-batch")).not.toContain("OFFER TERMS");
  });
});

describe("opensOnObservation", async () => {
  const { opensOnObservation, lintEmail } = await import("../src/_lib.ts");
  it("flags a first sentence that describes the reader back to them", () => {
    expect(opensOnObservation("Hey Dana,\n\nYou mentioned the Leeds depot. We can help.")).toBe(
      true,
    );
    expect(opensOnObservation("I noticed your second depot opened.")).toBe(true);
    expect(opensOnObservation("Congrats on the round. Here is an idea.")).toBe(true);
  });
  it("passes an opening that makes the offer", () => {
    expect(
      opensOnObservation("Hey Dana,\n\nI can get Leeds crews booked same day. You mentioned it."),
    ).toBe(false);
  });
  it("is a lint flag only when the draft was given an offer", () => {
    const body = "I noticed your depot. We help.";
    expect(lintEmail("s", body, 110, undefined, { offer: "book leeds crews same day" })).toContain(
      "opens-on-observation",
    );
    expect(lintEmail("s", body, 110, undefined, {})).not.toContain("opens-on-observation");
  });
  it("flags an opening that never makes the offer", () => {
    const offer = "get the leeds depot's crews booked into same-day slots";
    const flagsFor = (body: string) => lintEmail("s", body, 110, undefined, { offer });
    expect(flagsFor("Could we connect next week? It's brief.")).toContain("opens-without-offer");
    expect(flagsFor("Want me to fill your open slots? It's brief.")).not.toContain(
      "opens-without-offer",
    );
    expect(flagsFor("Same-day slots for the Leeds depot crews, booked for you.")).not.toContain(
      "opens-without-offer",
    );
  });
});
