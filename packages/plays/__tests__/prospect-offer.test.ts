import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The prospect offer: written from research, linted on its output alone,
// stored once and carried to every touch.

// Judge calls (the prospect-offer-judge prompt) take their own replies, so a
// test of the writer is not shifted by them. With none queued the judge's
// reply is unreadable and the offers are kept unjudged.
const llm = {
  replies: [] as string[],
  inputs: [] as string[],
  judge: [] as string[],
  judgeInputs: [] as string[],
};
const cfg: {
  founderName: string;
  productOneLiner: string;
  productBrief: string;
  pilotOffer: string;
  llmModel?: string;
  offerJudge?: { engine: "llm" | "decisions"; model?: string; minConfidence?: number };
} = {
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
    loadPrompt: (name: string) => name,
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      if (input.messages[0]?.content === "prospect-offer-judge") {
        llm.judgeInputs.push(input.messages.at(-1)?.content ?? "");
        return { content: llm.judge.shift() ?? "{}", provider: "t", model: "t" };
      }
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
  llm.judge = [];
  llm.judgeInputs = [];
  delete cfg.offerJudge;
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

describe("offer angles are written once", () => {
  it("records a finished attempt with nothing usable, so the next draft does not repeat it", async () => {
    const mod = await import("../src/_prospect-offer.ts");
    const research = mod.offerResearchText(target);
    const stored = {
      ...good,
      level: "researched" as const,
      version: OFFER_PROMPT_VERSION,
      inputHash: mod.offerInputHash(research, cfg),
      productHash: mod.offerProductHash(cfg),
      derivedAt: "",
    };
    llm.replies = [
      JSON.stringify({ angles: ["Monitor every slot."] }),
      JSON.stringify({ angles: [] }),
    ];
    const first = await mod.ensureOfferSet({
      target: { ...target, offer: stored },
      playName: "new-business",
    });
    expect(first?.offer.angles).toEqual([]);
    expect(first?.changed).toBe(true);
    const calls = llm.inputs.length;
    const second = await mod.ensureOfferSet({
      target: { ...target, offer: first!.offer },
      playName: "new-business",
    });
    expect(second?.changed).toBe(false);
    expect(llm.inputs.length).toBe(calls);
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

// Relevance: each written offer rests on an anchor (their product, their
// firm) and is judged before it is kept. The judge drops what it does not
// pass, one replacement round asks for the missing count, and the five are
// made up with weak ones, never irrelevant ones.

const third = {
  ...good,
  offer: "clear the leeds depot's backlog of unbooked repair calls before the weekend",
  return: "repair calls booked instead of lost, counted per booking",
};
const fourth = {
  ...good,
  offer: "get every leeds customer a confirmed arrival window on the day they call",
  return: "missed visits avoided, counted per job",
};
const fifth = {
  ...good,
  offer: "close out the depot's healthcare vendor compliance review",
  return: "a compliance review closed, counted once",
};
const replacement = {
  ...good,
  offer: "win back leeds customers whose jobs were cancelled with a rebooked visit",
  return: "cancelled jobs rebooked, counted per job",
};
const replacementTwo = {
  ...good,
  offer: "fill the leeds depot's empty friday afternoons with waiting maintenance jobs",
  return: "friday slots filled, counted per job",
};

function judgeReply(labels: Array<[label: string, why: string]>): string {
  return JSON.stringify({
    judgements: labels.map(([label, why], i) => ({ offer: i + 1, label, why })),
  });
}

function decisionsResponse(
  answers: Array<{ choice: string; confidence: number; relevant: number }>,
): Response {
  return new Response(
    JSON.stringify({
      model: "test/decisions-model",
      answers: Object.fromEntries(
        answers.map((a, i) => [
          `offer_${i + 1}`,
          {
            type: "choice",
            choice: a.choice,
            confidence: a.confidence,
            probabilities: { relevant: a.relevant, [a.choice]: a.confidence },
          },
        ]),
      ),
      usage: { cost: 0.002 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("offer fit", () => {
  const research = offerResearchText(target);
  it("is parsed and stored on the offer", async () => {
    const fit = "their firm: a second depot in leeds with booking done by hand";
    llm.replies = [JSON.stringify({ offers: [{ ...good, fit: `${fit}.` }] })];
    const [offer] = await deriveOffers({ target, playName: "new-business" });
    expect(offer?.fit).toBe(fit);
  });

  it("is length-capped and its numbers come from the research", () => {
    expect(lintOffer({ ...good, level: "researched", fit: "x".repeat(200) }, research)).toContain(
      "fit-too-long",
    );
    expect(
      lintOffer({ ...good, level: "researched", fit: "their firm: 40 staff in leeds" }, research),
    ).toContain("number-not-in-research:40");
  });

  it("the test offers pass the lint, so only the judge decides", () => {
    for (const o of [good, second, third, fourth, fifth, replacement, replacementTwo]) {
      expect(lintOffer({ ...o, level: "researched" }, research, cfg.productBrief)).toEqual([]);
    }
  });

  it("bumps the prompt version so unedited offers re-derive", () => {
    expect(OFFER_PROMPT_VERSION).toBe("offer-v4");
  });
});

describe("judgeOffers", () => {
  const research = offerResearchText(target);
  const offers = [good, { ...fifth, fit: "their firm: they serve healthcare" }];

  afterEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
  });

  it("llm engine (the default): one label and reason per offer, from the judge prompt", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot is theirs"],
        ["irrelevant", "rests on the word healthcare"],
      ]),
    ];
    const out = await judgeOffers(offers, research, target, {
      ...cfg,
      llmModel: "test/llm",
    } as never);
    expect(out).toEqual([
      {
        label: "relevant",
        score: null,
        why: "the second depot is theirs",
        classifier: "llm:test/llm",
        pass: true,
      },
      {
        label: "irrelevant",
        score: null,
        why: "rests on the word healthcare",
        classifier: "llm:test/llm",
        pass: false,
      },
    ]);
    expect(llm.judgeInputs[0]).toContain("COMPANY: Northside Plumbing");
    expect(llm.judgeInputs[0]).toContain("TITLE: Operations Manager");
    expect(llm.judgeInputs[0]).toContain(`offer: ${fifth.offer}`);
    expect(llm.judgeInputs[0]).toContain("fit: their firm: they serve healthcare");
    expect(llm.judgeInputs[0]).toContain("opened a second depot in Leeds");
  });

  it("decisions engine: one request, one choice question per offer, score is P(relevant)", async () => {
    const { judgeOffers, offerRelevanceCriteria } = await import("../src/_prospect-offer.ts");
    process.env["OPENROUTER_API_KEY"] = "test-key";
    const fetchImpl = vi.fn(async () =>
      decisionsResponse([
        { choice: "relevant", confidence: 0.82, relevant: 0.82 },
        { choice: "relevant", confidence: 0.41, relevant: 0.41 },
      ]),
    );
    const out = await judgeOffers(
      offers,
      research,
      target,
      { ...cfg, offerJudge: { engine: "decisions", model: "test/decisions-model" } } as never,
      { fetchImpl: fetchImpl as never },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/alpha/decisions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("test/decisions-model");
    expect(Object.keys(body.questions)).toEqual(["offer_1", "offer_2"]);
    expect(body.questions.offer_2.type).toBe("choice");
    expect(body.questions.offer_2.criteria).toEqual(offerRelevanceCriteria());
    expect(Object.keys(body.questions.offer_2.criteria)).toEqual([
      "relevant",
      "weak",
      "irrelevant",
    ]);
    expect(body.questions.offer_2.instructions).toContain(fifth.offer);
    expect(body.state).toContain("opened a second depot in Leeds");
    expect(body.state).toContain(`offer: ${good.offer}`);
    expect(out?.map((j) => [j?.label, j?.score, j?.pass, j?.classifier])).toEqual([
      ["relevant", 0.82, true, "decisions:test/decisions-model"],
      // Relevant, but under the default 0.5 confidence: it does not pass.
      ["relevant", 0.41, false, "decisions:test/decisions-model"],
    ]);
    expect(llm.judgeInputs).toHaveLength(0);
  });

  it("decisions engine falls back to the llm judge on a failed request", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    process.env["OPENROUTER_API_KEY"] = "test-key";
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    llm.judge = [
      judgeReply([
        ["relevant", "ok"],
        ["weak", "generic"],
      ]),
    ];
    const out = await judgeOffers(
      offers,
      research,
      target,
      { ...cfg, llmModel: "test/llm", offerJudge: { engine: "decisions", model: "m" } } as never,
      { fetchImpl: fetchImpl as never },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out?.map((j) => [j?.label, j?.classifier])).toEqual([
      ["relevant", "llm:test/llm"],
      ["weak", "llm:test/llm"],
    ]);
  });

  it("decisions engine falls back without calling out when there is no key", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    const fetchImpl = vi.fn();
    llm.judge = [
      judgeReply([
        ["relevant", "ok"],
        ["irrelevant", "no"],
      ]),
    ];
    const out = await judgeOffers(
      offers,
      research,
      target,
      { ...cfg, offerJudge: { engine: "decisions", model: "m" } } as never,
      { fetchImpl: fetchImpl as never },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out?.map((j) => j?.label)).toEqual(["relevant", "irrelevant"]);
  });
});

describe("deriveOffers with the relevance judge", () => {
  afterEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
  });

  it("drops what the judge does not pass and asks for exactly the missing count", async () => {
    const bad = { ...replacementTwo, offer: "book 40 jobs a day" };
    llm.replies = [
      JSON.stringify({ offers: [good, second, third, fourth, fifth] }),
      JSON.stringify({ offers: [replacement, bad] }),
    ];
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot"],
        ["relevant", "cancellations at the depot"],
        ["relevant", "their backlog"],
        ["weak", "would fit any trade business"],
        ["irrelevant", "rests on the word healthcare"],
      ]),
      judgeReply([["relevant", "their cancelled jobs"]]),
    ];
    const offers = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(2);
    expect(llm.inputs[1]).toContain("Write exactly 2 new offers");
    expect(llm.inputs[1]).toContain("rests on the word healthcare");
    expect(llm.inputs[1]).toContain(`- ${good.offer}`);
    // The replacement that fails lint never reaches the judge.
    expect(llm.judgeInputs[1]).toContain(replacement.offer);
    expect(llm.judgeInputs[1]).not.toContain(bad.offer);
    // Passing offers in the model's order, the replacement next, a weak one
    // making up the five; the irrelevant one is gone.
    expect(offers.map((o) => [o.offer, o.relevance])).toEqual([
      [good.offer, "relevant"],
      [second.offer, "relevant"],
      [third.offer, "relevant"],
      [replacement.offer, "relevant"],
      [fourth.offer, "weak"],
    ]);
    expect(offers[4]?.relevanceWhy).toBe("would fit any trade business");
    expect(offers[0]?.relevanceClassifier).toMatch(/^llm:/);
  });

  it("fills with the best-scored weak offers, never an irrelevant one", async () => {
    process.env["OPENROUTER_API_KEY"] = "test-key";
    cfg.offerJudge = { engine: "decisions", model: "test/decisions-model" };
    llm.replies = [
      JSON.stringify({ offers: [good, second, third, fourth, fifth] }),
      JSON.stringify({ offers: [replacement, replacementTwo] }),
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        decisionsResponse([
          { choice: "relevant", confidence: 0.9, relevant: 0.9 },
          { choice: "relevant", confidence: 0.8, relevant: 0.8 },
          { choice: "weak", confidence: 0.6, relevant: 0.3 },
          { choice: "weak", confidence: 0.5, relevant: 0.45 },
          { choice: "irrelevant", confidence: 0.9, relevant: 0.05 },
        ]),
      )
      .mockResolvedValueOnce(
        decisionsResponse([
          { choice: "weak", confidence: 0.7, relevant: 0.2 },
          { choice: "irrelevant", confidence: 0.8, relevant: 0.1 },
        ]),
      );
    const offers = await deriveOffers({
      target,
      playName: "new-business",
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second_ = JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body));
    expect(Object.keys(second_.questions)).toEqual(["offer_1", "offer_2"]);
    expect(llm.inputs[1]).toContain("Write exactly 3 new offers");
    expect(offers.map((o) => [o.offer, o.relevance, o.relevanceScore])).toEqual([
      [good.offer, "relevant", 0.9],
      [second.offer, "relevant", 0.8],
      [fourth.offer, "weak", 0.45],
      [third.offer, "weak", 0.3],
      [replacement.offer, "weak", 0.2],
    ]);
    expect(offers.some((o) => o.offer === fifth.offer || o.offer === replacementTwo.offer)).toBe(
      false,
    );
  });

  it("asks for nothing more when the judge drops nothing", async () => {
    llm.replies = [JSON.stringify({ offers: [good, second] })];
    llm.judge = [
      judgeReply([
        ["relevant", "a"],
        ["relevant", "b"],
      ]),
    ];
    const offers = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(1);
    expect(offers.map((o) => o.relevance)).toEqual(["relevant", "relevant"]);
  });

  it("keeps the offers unjudged when the judge's reply cannot be read", async () => {
    llm.replies = [JSON.stringify({ offers: [good, second] })];
    llm.judge = ["not json"];
    const offers = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer]);
    expect(offers[0]?.relevance).toBeUndefined();
  });
});
