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
  lintOffer,
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
  it("lets a role-level offer go without evidence", () => {
    expect(lintOffer({ ...good, level: "role", evidence: [] }, research)).toEqual([]);
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
    const stored = {
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
    expect(lintEmail("s", body, 110, undefined, { offerFirst: true })).toContain(
      "opens-on-observation",
    );
    expect(lintEmail("s", body, 110, undefined, {})).not.toContain("opens-on-observation");
  });
});
