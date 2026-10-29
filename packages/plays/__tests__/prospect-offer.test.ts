import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The prospect offer: written from research, linted on its output alone,
// stored once and carried to every touch.

// Judge calls (the prospect-offer-judge prompt) take their own replies, so a
// test of the writer is not shifted by them. With none queued the judge's
// reply is unreadable and the offers are kept unjudged.
/** A writer reply that makes the mocked call throw instead. */
const WRITER_FAILS = "<writer fails>";
const llm = {
  replies: [] as string[],
  inputs: [] as string[],
  temperatures: [] as number[],
  judge: [] as string[],
  judgeInputs: [] as string[],
  /** The `model` each writer call named (undefined = the workspace's). */
  models: [] as Array<string | undefined>,
  /** The `model` each judge call named. */
  judgeModels: [] as Array<string | undefined>,
};
const cfg: {
  founderName: string;
  productOneLiner: string;
  productBrief: string;
  pilotOffer: string;
  llmModel?: string;
  offerJudge?: { engine: "llm" | "decisions"; model?: string; minConfidence?: number };
  offerExclusions?: string[];
  offerAnchor?: "prefer-product" | "either";
  noOfferPlays?: string[];
  offerWriter?: { rounds?: number; fallbackModel?: string; fallbackOnWeak?: boolean };
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
    // The rescue round's text is the test's subject: read as shipped.
    loadPrompt: (name: string) =>
      name === "prospect-offer-rescue" ? actual.loadPrompt(name) : name,
    complete: async (input: {
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      model?: string;
    }) => {
      if (input.messages[0]?.content === "prospect-offer-judge") {
        llm.judgeInputs.push(input.messages.at(-1)?.content ?? "");
        llm.judgeModels.push(input.model);
        return { content: llm.judge.shift() ?? "{}", provider: "t", model: "t", costUsd: 0.001 };
      }
      llm.inputs.push(input.messages.at(-1)?.content ?? "");
      llm.temperatures.push(input.temperature ?? -1);
      llm.models.push(input.model);
      const reply = llm.replies.shift() ?? "{}";
      // A provider failure on this call.
      if (reply === WRITER_FAILS) throw new Error("provider 503");
      // As the real client answers: the model the call named, else the workspace's.
      return { content: reply, provider: "t", model: input.model ?? "main/writer", costUsd: 0.002 };
    },
  };
});

const {
  deriveOffer,
  deriveOffers,
  deriveOfferSet,
  ensureOfferSet,
  isOfferSkipped,
  lintOffer,
  lintOfferAngle,
  offerBlock,
  offerForDraft,
  offerInputHash,
  offerProductHash,
  offerResearchText,
  offerSetForDraft,
  activeOfferPatch,
  OFFER_PROMPT_VERSION,
  playMakesOffer,
  weakOfferHold,
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
  llm.temperatures = [];
  llm.judge = [];
  llm.judgeInputs = [];
  llm.models = [];
  llm.judgeModels = [];
  delete cfg.offerJudge;
  delete cfg.offerWriter;
  delete cfg.offerExclusions;
  delete cfg.offerAnchor;
  // Judge paths must not depend on a key in the developer's or CI's environment.
  delete process.env["OPENROUTER_API_KEY"];
});

describe("offerResearchText", () => {
  it("carries the row's own facts, never its edge or address", () => {
    const text = offerResearchText({ ...target, yourEdge: "secret argument" });
    expect(text).toContain("opened a second depot in Leeds");
    expect(text).not.toContain("secret argument");
    expect(text).not.toContain("dana@northside.example");
  });

  // The row drops any field over 240 characters; the GitHub record (their
  // profile and their own repositories) is read whole, in its own section.
  const githubEvidence = [
    "Profile: Sam Ortiz @ Tidewater Labs — account created 2019 — 14 public repos",
    "Own repos (most recently pushed):",
    "- harbor-sync (Rust, pushed 2026-08) — syncs berth schedules between port systems",
    "- tide-cli (Go, pushed 2026-06) — command line for tide tables",
    "- notes (Markdown, pushed 2025-11) — personal notes and talks",
  ].join("\n");
  const starrer = { name: "Sam Ortiz", repo: "someone-else/popular-tool", githubEvidence };

  it("reads the GitHub record in its own section, after the row", () => {
    expect(githubEvidence.length).toBeGreaterThan(240);
    const text = offerResearchText(starrer);
    expect(text).toContain(`THEIR GITHUB:\n${githubEvidence}`);
    expect(text.indexOf("HOW THEY WERE FOUND")).toBeLessThan(text.indexOf("THEIR GITHUB:"));
    expect(text).toContain("repo: someone-else/popular-tool");
  });

  it("reads a short record once, in its own section, not as a row line too", () => {
    const text = offerResearchText({ ...starrer, githubEvidence: "Own repos: tide-cli" });
    expect(text).toContain("THEIR GITHUB:\nOwn repos: tide-cli");
    expect(text).not.toContain("githubEvidence:");
  });

  it("clips a long record", () => {
    const long = `${githubEvidence}\n${"- more-repo (Go) — another tool\n".repeat(400)}`;
    const section = offerResearchText({ ...starrer, githubEvidence: long }).split(
      "THEIR GITHUB:\n",
    )[1]!;
    expect(section.length).toBe(3_000);
    expect(section.endsWith("…")).toBe(true);
  });

  it("adds no section for an empty record, or under an older prompt version", () => {
    expect(offerResearchText({ ...starrer, githubEvidence: "  " })).not.toContain("THEIR GITHUB");
    expect(offerResearchText(starrer, null, "offer-v5")).not.toContain("THEIR GITHUB");
    expect(offerResearchText(starrer, null, "offer-v5")).toBe(
      offerResearchText({ ...starrer, githubEvidence: undefined }),
    );
  });

  it("reaches the writer and the judge", async () => {
    llm.replies = [JSON.stringify({ offers: [good] })];
    llm.judge = [JSON.stringify({ judgements: [{ offer: 1, label: "relevant", why: "ok" }] })];
    await deriveOffers({ target: { ...target, githubEvidence }, playName: "repo-interest" });
    expect(llm.inputs[0]).toContain(`THEIR GITHUB:\n${githubEvidence}`);
    expect(llm.judgeInputs[0]).toContain(`THEIR GITHUB:\n${githubEvidence}`);
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
  it("flags an offer that is one pass of checking", () => {
    for (const offer of [
      "vet every new leeds supplier before the next contract",
      "verify each crew's certificates at the leeds depot",
      "validate the leeds depot's job addresses",
      "screen new leeds subcontractors",
      "scan the leeds depot's job history for missed visits",
      "audit leeds depot invoices",
      "check every leeds booking for a double slot",
      "Verify the leeds depot's insurance documents",
    ]) {
      expect(lintOffer({ ...good, level: "researched", offer }, research)).toContain(
        "offer-is-a-check",
      );
    }
  });
  it("flags an offer that names the system instead of the result", () => {
    for (const offer of [
      "put into production the system that books every leeds job into an open slot",
      "Put it into production across the leeds depot crews",
      "ship the system that re-plans leeds crew routes before peak season",
    ]) {
      expect(lintOffer({ ...good, level: "researched", offer }, research)).toContain(
        "offer-names-the-system",
      );
    }
    expect(
      lintOffer(
        { ...good, level: "researched", offer: "every leeds job booked into an open slot" },
        research,
      ),
    ).not.toContain("offer-names-the-system");
  });
  it("passes a goal that leads with what the work wins, a check named later included", () => {
    for (const offer of [
      "renegotiate the leeds depot's van leases after auditing what each van costs",
      "recover unpaid leeds invoices from the last quarter",
      "sign the leeds depot's first commercial maintenance contract",
      "get the leeds depot's crews booked into same-day slots once every address is checked",
    ]) {
      expect(lintOffer({ ...good, level: "researched", offer }, research)).not.toContain(
        "offer-is-a-check",
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
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer]);
    expect(offers[0]?.return).toBe(good.return);
  });

  it("asks again for the ones that fail, keeping those that passed", async () => {
    const watching = { ...second, offer: "monitor cancellations at the leeds depot" };
    llm.replies = [
      JSON.stringify({ offers: [good, watching] }),
      JSON.stringify({ offers: [good, second] }),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[1]).toContain("offer 2: offer-not-execution");
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer]);
  });

  it("asks again for a check, telling the writer what the flag means", async () => {
    const check = { ...good, offer: "vet every new leeds subcontractor before they start" };
    llm.replies = [
      JSON.stringify({ offers: [check, second] }),
      JSON.stringify({ offers: [good, second] }),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(2);
    expect(llm.inputs[1]).toContain("offer 1: offer-is-a-check");
    expect(llm.inputs[1]).toContain(
      "offer-is-a-check: the offer is one pass of checking; name the multi-week goal that checking wins",
    );
    expect(offers.map((o) => o.offer)).toEqual([second.offer, good.offer]);
  });

  it("drops an offer that repeats a kept one in other words, and asks again for the place", async () => {
    const reworded = {
      ...good,
      offer: "get the leeds crews booked into same-day slots without a dispatcher",
    };
    expect(lintOffer({ ...reworded, level: "researched" }, offerResearchText(target))).toEqual([]);
    llm.replies = [
      JSON.stringify({ offers: [good, reworded, second] }),
      // The repair round restates the kept ones: they are repeats too.
      JSON.stringify({ offers: [reworded, second, third] }),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(2);
    expect(llm.inputs[1]).toContain("offer 2: the same job as another offer");
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer, third.offer]);
  });

  it("shows a mid-sequence writer the THREAD SO FAR, as context it may not quote as evidence", async () => {
    const thread = [
      { subject: "crews in leeds", body: "Your crews in Leeds run 412 jobs a week by hand." },
      { subject: "Re: crews in leeds", body: "Still worth a look?" },
    ];
    const quoting = { ...good, evidence: ["Your crews in Leeds run 412 jobs a week by hand."] };
    llm.replies = [
      JSON.stringify({ offers: [quoting, second] }),
      JSON.stringify({ offers: [good, second] }),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business", thread });
    expect(llm.inputs[0]).toContain("THREAD SO FAR:");
    expect(llm.inputs[0]).toContain("--- email 1 ---\nSubject: crews in leeds");
    expect(llm.inputs[0]).toContain("Still worth a look?");
    // A quote from our own emails is not research: the offer resting on it is sent back.
    expect(llm.inputs[1]).toContain("offer 1:");
    expect(offers.map((o) => o.offer).toSorted()).toEqual([good.offer, second.offer].toSorted());
    expect(offers.flatMap((o) => o.evidence)).not.toContain(quoting.evidence[0]);
  });

  it("adds no THREAD SO FAR block for an intro", async () => {
    llm.replies = [JSON.stringify({ offers: [good] })];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[0]).not.toContain("THREAD SO FAR");
  });
});

describe("the writer's skip", () => {
  const why = "They left the firm in October and no longer hold the role.";

  it("comes back with its why and the input hash it read", async () => {
    llm.replies = [JSON.stringify({ skip: true, why: `  ${why}\n` })];
    const out = await deriveOffers({ target, playName: "new-business" });
    expect(out.offers).toEqual([]);
    expect(out.skip?.why).toBe(why);
    expect(out.skip?.version).toBe(OFFER_PROMPT_VERSION);
    expect(out.skip?.inputHash).toBe(offerInputHash(offerResearchText(target), cfg));
    expect(out.skip?.productHash).toBe(offerProductHash(cfg));
  });

  it("is no skip when an earlier round kept offers", async () => {
    const watching = { ...second, offer: "monitor cancellations at the leeds depot" };
    llm.replies = [
      JSON.stringify({ offers: [good, watching] }),
      JSON.stringify({ skip: true, why }),
    ];
    const out = await deriveOffers({ target, playName: "new-business" });
    expect(out.offers.map((o) => o.offer)).toEqual([good.offer]);
    expect(out.skip).toBeNull();
  });

  it("reaches deriveOfferSet as `skipped`, and a lint failure stays null", async () => {
    llm.replies = [JSON.stringify({ skip: true, why })];
    const set = await deriveOfferSet({ target, playName: "new-business" });
    expect(isOfferSkipped(set) && set.skipped.why).toBe(why);
    const bad = JSON.stringify({ ...good, offer: "book 40 jobs a day" });
    llm.replies = [bad, bad];
    expect(await deriveOfferSet({ target, playName: "new-business" })).toBeNull();
  });

  it("stored and current, answers ensureOfferSet with no writer call; changed research asks again", async () => {
    llm.replies = [JSON.stringify({ skip: true, why })];
    const first = await ensureOfferSet({ target, playName: "new-business" });
    if (!isOfferSkipped(first)) throw new Error("expected a skip");
    expect(first.changed).toBe(true);
    const calls = llm.inputs.length;

    const again = await ensureOfferSet({
      target: { ...target, offerSkip: first.skipped },
      playName: "new-business",
    });
    expect(isOfferSkipped(again) && again.changed).toBe(false);
    expect(llm.inputs.length).toBe(calls);

    llm.replies = [JSON.stringify({ offers: [good] })];
    const moved = await ensureOfferSet({
      target: { ...target, update: "hired a dispatcher for leeds", offerSkip: first.skipped },
      playName: "new-business",
    });
    expect(llm.inputs.length).toBeGreaterThan(calls);
    expect(moved && !isOfferSkipped(moved) && moved.offer.offer).toBe(good.offer);
  });

  it("stored under today's prompt and product, is kept by offerSetForDraft", async () => {
    llm.replies = [JSON.stringify({ skip: true, why })];
    const first = await offerSetForDraft({ target, playName: "new-business" });
    if (!isOfferSkipped(first)) throw new Error("expected a skip");
    expect(first.derived).toBe(true);
    const calls = llm.inputs.length;
    const kept = await offerSetForDraft({
      target: { ...target, offerSkip: first.skipped },
      dossier: "more research the row never had",
      playName: "new-business",
    });
    expect(isOfferSkipped(kept) && kept.derived).toBe(false);
    expect(
      await offerForDraft({
        target: { ...target, offerSkip: first.skipped },
        playName: "new-business",
      }),
    ).toBeNull();
    expect(llm.inputs.length).toBe(calls);
  });

  it("is deleted by the patch that makes an offer active", async () => {
    llm.replies = [JSON.stringify(good)];
    const offer = (await deriveOffer({ target, playName: "new-business" }))!;
    expect(activeOfferPatch(null, offer, [offer]).offerSkip).toBeNull();
  });

  it("kept on a row, deletes a weak or stale offer with it, never one that stands", async () => {
    const { offerSkipPatch } = await import("../src/_prospect-offer.ts");
    llm.replies = [JSON.stringify({ skip: true, why })];
    const { skip } = await deriveOffers({ target, playName: "new-business" });
    const stored = { ...good, level: "researched" as const, inputHash: "h", derivedAt: "" };
    const cleared = { offerSkip: skip, offer: null, offerCandidates: null };
    expect(offerSkipPatch({ ...stored, version: "offer-v6" }, skip!)).toEqual(cleared);
    expect(
      offerSkipPatch({ ...stored, version: OFFER_PROMPT_VERSION, relevance: "weak" }, skip!),
    ).toEqual(cleared);
    expect(offerSkipPatch(null, skip!)).toEqual(cleared);
    for (const standing of [
      { ...stored, version: OFFER_PROMPT_VERSION, relevance: "relevant" as const },
      { ...stored, version: "offer-v6", editedBy: "founder" as const },
      { ...stored, version: "offer-v6", relevance: "weak" as const, weakApprovedAt: "2026-10-01" },
    ]) {
      expect(offerSkipPatch(standing, skip!)).toEqual({ offerSkip: skip });
    }
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
    if (!set || isOfferSkipped(set)) throw new Error("expected offers");
    expect(set.offer.offer).toBe(good.offer);
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
    if (!first || isOfferSkipped(first)) throw new Error("expected the stored offer");
    expect(first.offer.angles).toEqual([]);
    expect(first?.changed).toBe(true);
    const calls = llm.inputs.length;
    const second = await mod.ensureOfferSet({
      target: { ...target, offer: first.offer },
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

describe("a workspace's noOfferPlays", () => {
  afterEach(() => {
    delete cfg.noOfferPlays;
  });

  it("turns offers off for the plays it lists and no other", () => {
    const own = { noOfferPlays: ["repo-interest"] };
    expect(playMakesOffer("repo-interest", own)).toBe(false);
    expect(playMakesOffer("design-partner-loi", own)).toBe(true);
    // The plays that never make an offer stay that way whatever it says.
    expect(playMakesOffer("discovery-interview", { noOfferPlays: [] })).toBe(false);
  });

  it("writes no offer and asks no model for a listed play", async () => {
    cfg.noOfferPlays = ["repo-interest"];
    llm.replies = [];
    llm.inputs = [];
    const out = await deriveOffers({ target: { company: "Acme" }, playName: "repo-interest" });
    expect(out).toEqual({ offers: [], skip: null });
    expect(llm.inputs).toHaveLength(0);
    expect(
      await ensureOfferSet({ target: { company: "Acme" }, playName: "repo-interest" }),
    ).toBeNull();
    expect(
      await offerSetForDraft({ target: { company: "Acme" }, playName: "repo-interest" }),
    ).toBeNull();
  });

  it("lifts the weak-offer hold for a listed play, read from the config file", async () => {
    const { configDir } =
      await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
    const file = join(configDir(), "config.json");
    const payload = { offer: { ...good, relevance: "weak" } };
    try {
      mkdirSync(configDir(), { recursive: true });
      writeFileSync(file, JSON.stringify({ noOfferPlays: ["repo-interest"] }));
      expect(weakOfferHold("repo-interest", payload)).toBe(false);
      expect(weakOfferHold("design-partner-loi", payload)).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
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
// pass and one replacement round asks for the missing count. Only offers
// that pass are kept: a set is one to five, never made up with weak ones.

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
    const [offer] = (await deriveOffers({ target, playName: "new-business" })).offers;
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
    expect(OFFER_PROMPT_VERSION).toBe("offer-v7");
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

// The decisions answer as the API gives it: `confidence` is its own number,
// separate from (and often lower than) the label's probability.
function decisionsRaw(
  answers: Array<{ choice: string; confidence?: number; probabilities?: Record<string, number> }>,
): Response {
  return new Response(
    JSON.stringify({
      model: "test/decisions-model",
      answers: Object.fromEntries(
        answers.map((a, i) => [`offer_${i + 1}`, { type: "choice", ...a }]),
      ),
      usage: { cost: 0.001 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("judgeOffers pass rule (decisions)", () => {
  const research = offerResearchText(target);
  const decisionsCfg = {
    ...cfg,
    offerJudge: { engine: "decisions", model: "test/decisions-model" },
  } as never;

  afterEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
  });

  it("passes on P(relevant), not on the separate confidence", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    process.env["OPENROUTER_API_KEY"] = "test-key";
    const fetchImpl = vi.fn(async () =>
      decisionsRaw([
        // Labelled relevant at 0.66 with a confidence of 0.3: passes.
        { choice: "relevant", confidence: 0.3, probabilities: { relevant: 0.66, weak: 0.3 } },
        // Relevant on top, but P(relevant) under the 0.5 bar: fails.
        {
          choice: "relevant",
          confidence: 0.6,
          probabilities: { relevant: 0.45, weak: 0.4, irrelevant: 0.15 },
        },
        // Weak on top: fails whatever the numbers.
        { choice: "weak", confidence: 0.9, probabilities: { weak: 0.4, relevant: 0.35 } },
        // No probabilities: the confidence stands in.
        { choice: "relevant", confidence: 0.7 },
        { choice: "relevant", confidence: 0.3 },
      ]),
    );
    const offers = [good, second, third, fourth, fifth];
    const out = await judgeOffers(offers, research, target, decisionsCfg, {
      fetchImpl: fetchImpl as never,
    });
    expect(out?.map((j) => [j?.label, j?.score, j?.pass])).toEqual([
      ["relevant", 0.66, true],
      ["relevant", 0.45, false],
      ["weak", 0.35, false],
      ["relevant", 0.7, true],
      ["relevant", 0.3, false],
    ]);
  });

  it("uses the workspace's minConfidence as the bar on P(relevant)", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    process.env["OPENROUTER_API_KEY"] = "test-key";
    const fetchImpl = vi.fn(async () =>
      decisionsRaw([
        { choice: "relevant", confidence: 0.2, probabilities: { relevant: 0.66, weak: 0.3 } },
      ]),
    );
    const out = await judgeOffers(
      [good],
      research,
      target,
      {
        ...cfg,
        offerJudge: { engine: "decisions", model: "test/decisions-model", minConfidence: 0.7 },
      } as never,
      { fetchImpl: fetchImpl as never },
    );
    expect(out?.[0]?.pass).toBe(false);
  });

  it("passes a weak top label whose P(relevant) clears the bar, never an irrelevant one", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    process.env["OPENROUTER_API_KEY"] = "test-key";
    const fetchImpl = vi.fn(async () =>
      decisionsRaw([
        // Weak on top at P(relevant) 0.41: one the founder would send.
        { choice: "weak", confidence: 0.5, probabilities: { weak: 0.5, relevant: 0.41 } },
        // Under the bar: fails.
        { choice: "weak", confidence: 0.6, probabilities: { weak: 0.66, relevant: 0.3 } },
        // A job the firm does not have: fails whatever P(relevant) says.
        {
          choice: "irrelevant",
          confidence: 0.4,
          probabilities: { irrelevant: 0.42, relevant: 0.4, weak: 0.18 },
        },
      ]),
    );
    const out = await judgeOffers(
      [good, second, third],
      research,
      target,
      {
        ...cfg,
        offerJudge: { engine: "decisions", model: "test/decisions-model", minConfidence: 0.35 },
      } as never,
      { fetchImpl: fetchImpl as never },
    );
    expect(out?.map((j) => [j?.label, j?.pass])).toEqual([
      ["weak", true],
      ["weak", false],
      ["irrelevant", false],
    ]);
  });
});

describe("storedRelevance", () => {
  it("stores a pass as relevant whatever its top label, and every miss as weak", async () => {
    const { storedRelevance } = await import("../src/_prospect-offer.ts");
    expect(storedRelevance({ label: "relevant", pass: true })).toBe("relevant");
    expect(storedRelevance({ label: "weak", pass: true })).toBe("relevant");
    expect(storedRelevance({ label: "weak", pass: false })).toBe("weak");
    expect(storedRelevance({ label: "relevant", pass: false })).toBe("weak");
    expect(storedRelevance({ label: "irrelevant", pass: false })).toBe("weak");
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
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(2);
    expect(llm.inputs[1]).toContain("Write exactly 2 new offers");
    expect(llm.inputs[1]).toContain("rests on the word healthcare");
    expect(llm.inputs[1]).toContain(`- ${good.offer}`);
    // The replacement that fails lint never reaches the judge.
    expect(llm.judgeInputs[1]).toContain(replacement.offer);
    expect(llm.judgeInputs[1]).not.toContain(bad.offer);
    // Passing offers in the model's order, the replacement next; the weak
    // and the irrelevant one are gone, and nothing makes up the five.
    expect(offers.map((o) => [o.offer, o.relevance])).toEqual([
      [good.offer, "relevant"],
      [second.offer, "relevant"],
      [third.offer, "relevant"],
      [replacement.offer, "relevant"],
    ]);
    expect(offers[0]?.relevanceClassifier).toMatch(/^llm:/);
  });

  it("drops a replacement that repeats a kept offer in other words", async () => {
    const reworded = {
      ...second,
      offer: "fill the leeds depot's cancelled slots with jobs the same morning",
    };
    llm.replies = [
      JSON.stringify({ offers: [good, second, third, fourth, fifth] }),
      JSON.stringify({ offers: [reworded, replacement] }),
    ];
    llm.judge = [
      judgeReply([
        ["relevant", "a"],
        ["relevant", "b"],
        ["relevant", "c"],
        ["relevant", "d"],
        ["irrelevant", "rests on the word healthcare"],
      ]),
      judgeReply([["relevant", "their cancelled jobs"]]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[1]).toContain("Write exactly 1 new offer");
    expect(llm.judgeInputs[1]).not.toContain(reworded.offer);
    expect(offers.map((o) => o.offer)).toEqual([
      good.offer,
      second.offer,
      third.offer,
      fourth.offer,
      replacement.offer,
    ]);
  });

  it("returns only the offers that pass: 2 of 5 passing is a set of those 2", async () => {
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
    const { offers } = await deriveOffers({
      target,
      playName: "new-business",
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second_ = JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body));
    expect(Object.keys(second_.questions)).toEqual(["offer_1", "offer_2"]);
    expect(llm.inputs[1]).toContain("Write exactly 3 new offers");
    // Two passed, so no rescue round runs.
    expect(llm.inputs).toHaveLength(2);
    expect(offers.map((o) => [o.offer, o.relevance, o.relevanceScore])).toEqual([
      [good.offer, "relevant", 0.9],
      [second.offer, "relevant", 0.8],
    ]);
    expect(offers.some((o) => o.relevance !== "relevant")).toBe(false);
  });

  it("drops a relevant under the bar as it drops a weak one", async () => {
    process.env["OPENROUTER_API_KEY"] = "test-key";
    cfg.offerJudge = { engine: "decisions", model: "test/decisions-model" };
    llm.replies = [
      JSON.stringify({ offers: [good, second, third, fourth, fifth] }),
      JSON.stringify({ offers: [] }),
    ];
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      decisionsRaw([
        // Confidence 0.3, P(relevant) 0.66: passes (the old rule dropped it).
        { choice: "relevant", confidence: 0.3, probabilities: { relevant: 0.66, weak: 0.3 } },
        { choice: "relevant", confidence: 0.8, probabilities: { relevant: 0.8, weak: 0.15 } },
        // Relevant on top, under the bar: not passed, so dropped.
        {
          choice: "relevant",
          confidence: 0.4,
          probabilities: { relevant: 0.45, weak: 0.4, irrelevant: 0.15 },
        },
        { choice: "weak", confidence: 0.5, probabilities: { weak: 0.6, relevant: 0.3 } },
        { choice: "irrelevant", confidence: 0.9, probabilities: { irrelevant: 0.9 } },
      ]),
    );
    const { offers } = await deriveOffers({
      target,
      playName: "new-business",
      fetchImpl: fetchImpl as never,
    });
    expect(offers.map((o) => [o.offer, o.relevance, o.relevanceScore])).toEqual([
      [good.offer, "relevant", 0.66],
      [second.offer, "relevant", 0.8],
    ]);
    // The replacement round was told the judge's own verdict on each.
    expect(llm.inputs[1]).toContain("relevant 0.45, weak 0.40, irrelevant 0.15");
    expect(llm.inputs[1]).toContain("weak 0.60, relevant 0.30");
  });

  it("an llm weak verdict is dropped, never kept to make up the set", async () => {
    llm.replies = [JSON.stringify({ offers: [good, second] }), JSON.stringify({ offers: [] })];
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot"],
        ["weak", "would fit any trade business"],
      ]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => [o.relevance, o.relevanceWhy])).toEqual([
      ["relevant", "the second depot"],
    ]);
  });

  it("asks for nothing more when the judge drops nothing", async () => {
    llm.replies = [JSON.stringify({ offers: [good, second] })];
    llm.judge = [
      judgeReply([
        ["relevant", "a"],
        ["relevant", "b"],
      ]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(1);
    expect(offers.map((o) => o.relevance)).toEqual(["relevant", "relevant"]);
  });

  it("keeps the offers unjudged when the judge's reply cannot be read", async () => {
    llm.replies = [JSON.stringify({ offers: [good, second] })];
    llm.judge = ["not json"];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer]);
    expect(offers[0]?.relevance).toBeUndefined();
  });
});

// The rescue: a set the judge passed none of is written once more, after
// the firm's research is read when the row has none complete, with the
// rejected offers and what the judge means by weak; when that passes none,
// once more from the person's role. Nothing passing after all three
// rewrites is a skip, never a weak set.

describe("rescue of a set the judge passed none of", () => {
  const five = JSON.stringify({ offers: [good, second, third, fourth, fifth] });
  const allWeak = judgeReply([
    ["weak", "would fit any trade business"],
    ["weak", "generic"],
    ["weak", "generic"],
    ["weak", "generic"],
    ["weak", "rests on the word healthcare"],
  ]);

  afterEach(async () => {
    const { registerOfferResearch } = await import("../src/_prospect-offer.ts");
    registerOfferResearch(null);
  });

  it("writes once more, with the rejected offers and what weak means, and keeps only what passes", async () => {
    const { offerRelevanceCriteria, OFFER_ROLE_RESCUE } = await import("../src/_prospect-offer.ts");
    llm.replies = [
      five,
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [replacement, replacementTwo] }),
    ];
    llm.judge = [
      allWeak,
      judgeReply([
        ["relevant", "their cancelled jobs"],
        ["weak", "generic"],
      ]),
    ];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    // First write, the replacement round, exactly one rescue: it passed one,
    // so the rounds stop there.
    expect(llm.inputs).toHaveLength(3);
    expect(llm.temperatures).toEqual([0.4, 0.4, 0.7]);
    const rescue = llm.inputs[2]!;
    expect(rescue).toContain(`- "${good.offer}": weak, would fit any trade business`);
    expect(rescue).toContain(`- "${fifth.offer}": weak, rests on the word healthcare`);
    expect(rescue).toContain(`What the check means by weak: ${offerRelevanceCriteria().weak}`);
    expect(rescue).toContain("list the most specific facts RESEARCH holds");
    expect(rescue).not.toContain("{{");
    expect(rescue).not.toContain(OFFER_ROLE_RESCUE);
    // The passing rescue offer alone: no weak one makes up the five.
    expect(offers.map((o) => [o.offer, o.relevance])).toEqual([[replacement.offer, "relevant"]]);
    expect(skip).toBeNull();
  });

  it("runs a third round from the person's role only when the first two passed none, told every rejected offer", async () => {
    const { registerOfferResearch, OFFER_ROLE_RESCUE } = await import("../src/_prospect-offer.ts");
    const research = vi.fn(async ({ target: t }: { target: Record<string, unknown> }) => ({
      target: {
        ...t,
        productResearch: {
          version: 1,
          status: "complete",
          sources: [],
          external: { answer: "Northside runs a fleet of vans from two depots" },
        },
      },
      researched: true,
      costUsd: 0.01,
    }));
    registerOfferResearch(research);
    llm.replies = [
      five,
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [replacement] }),
      JSON.stringify({ offers: [replacementTwo] }),
    ];
    llm.judge = [
      allWeak,
      judgeReply([["weak", "still any trade business"]]),
      judgeReply([["relevant", "the depot manager's friday utilisation"]]),
    ];
    const { offers, skip } = await deriveOffers({
      target,
      playName: "new-business",
      research: { queueRowId: 7, source: "find:x" },
    });
    // First write, replacement, rescue, role rescue.
    expect(llm.inputs).toHaveLength(4);
    expect(llm.temperatures).toEqual([0.4, 0.4, 0.7, 0.7]);
    // The research is read once, by the first rescue.
    expect(research).toHaveBeenCalledTimes(1);
    expect(llm.inputs[2]).toContain("New research about this firm was read.");
    expect(llm.inputs[2]).not.toContain(OFFER_ROLE_RESCUE);
    const role = llm.inputs[3]!;
    expect(role).not.toContain("New research about this firm was read.");
    expect(role).toContain(OFFER_ROLE_RESCUE);
    expect(role).not.toContain("{{");
    // Every offer rejected so far: the first five and the first rescue's.
    for (const o of [good, second, third, fourth, fifth])
      expect(role).toContain(`- "${o.offer}": weak`);
    expect(role).toContain(`- "${replacement.offer}": weak, still any trade business`);
    expect(offers.map((o) => [o.offer, o.relevance])).toEqual([[replacementTwo.offer, "relevant"]]);
    expect(skip).toBeNull();
  });

  it("refuses a role-round offer that repeats one an earlier rescue wrote", async () => {
    llm.replies = [
      five,
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [replacement] }),
      JSON.stringify({ offers: [replacement] }),
    ];
    llm.judge = [allWeak, judgeReply([["weak", "generic"]])];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    // The repeat never reaches the judge: no third verdict was asked for.
    expect(llm.judgeInputs).toHaveLength(2);
    expect(offers).toEqual([]);
  });

  it("all three rounds failing is no offer and a skip with its why, never a weak set", async () => {
    const { noStrongOfferWhy } = await import("../src/_prospect-offer.ts");
    llm.replies = [
      five,
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [replacement] }),
      JSON.stringify({ offers: [replacementTwo] }),
    ];
    llm.judge = [
      allWeak,
      judgeReply([["irrelevant", "not their job"]]),
      judgeReply([["weak", "generic"]]),
    ];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(4);
    expect(offers).toEqual([]);
    expect(skip).toMatchObject({
      why: "no offer passed the relevance check after 3 rewrites",
      version: OFFER_PROMPT_VERSION,
      inputHash: offerInputHash(offerResearchText(target), cfg),
      productHash: offerProductHash(cfg),
    });
    expect(noStrongOfferWhy(3)).toBe(skip?.why);

    // Kept on the row, it answers the next pass with no writer call.
    const calls = llm.inputs.length;
    const again = await ensureOfferSet({
      target: { ...target, offerSkip: skip },
      playName: "new-business",
    });
    expect(isOfferSkipped(again) && again.changed).toBe(false);
    expect(llm.inputs.length).toBe(calls);
  });

  it("stores no skip when a rescue round failed rather than judged its offers", async () => {
    llm.replies = [
      five,
      JSON.stringify({ offers: [] }),
      WRITER_FAILS,
      JSON.stringify({ offers: [] }),
    ];
    llm.judge = [allWeak];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(offers).toEqual([]);
    // The row was never fully judged: it is written again on the next pass.
    expect(skip).toBeNull();
  });

  it("stores no skip when the replacement round failed before its offers were judged", async () => {
    llm.replies = [
      five,
      WRITER_FAILS,
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [] }),
    ];
    llm.judge = [allWeak];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(offers).toEqual([]);
    expect(skip).toBeNull();
  });

  it("is not run when any offer passes, or when the judge gave no verdict", async () => {
    llm.replies = [five, JSON.stringify({ offers: [] })];
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot"],
        ["weak", "generic"],
        ["weak", "generic"],
        ["weak", "generic"],
        ["weak", "generic"],
      ]),
    ];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(2);
    llm.inputs = [];
    llm.replies = [five];
    llm.judge = ["not json"];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(1);
  });

  it("reads the firm's research first when the row has none complete, and writes from it", async () => {
    const { registerOfferResearch } = await import("../src/_prospect-offer.ts");
    const firm = {
      version: 1,
      status: "complete",
      sources: [],
      external: { answer: "Northside runs a fleet of vans from two depots" },
    };
    const research = vi.fn(async ({ target: t }: { target: Record<string, unknown> }) => ({
      target: { ...t, productResearch: firm },
      researched: true,
      costUsd: 0.01,
    }));
    registerOfferResearch(research);
    llm.replies = [five, JSON.stringify({ offers: [] }), JSON.stringify({ offers: [replacement] })];
    llm.judge = [allWeak, judgeReply([["relevant", "their vans"]])];
    const costs: number[] = [];
    const { offers } = await deriveOffers({
      target,
      playName: "new-business",
      research: { queueRowId: 12, source: "find:x", waitMs: 5_000 },
      onCost: (usd) => costs.push(usd),
    });
    expect(research).toHaveBeenCalledTimes(1);
    expect(research.mock.calls[0]![0]).toMatchObject({
      playName: "new-business",
      queueRowId: 12,
      source: "find:x",
      waitMs: 5_000,
    });
    expect(llm.inputs[2]).toContain("New research about this firm was read. RESEARCH is now:");
    expect(llm.inputs[2]).toContain("Northside runs a fleet of vans from two depots");
    // Stamped with the research the row now holds, so the next pass keeps them.
    const now = offerResearchText({ ...target, productResearch: firm });
    expect(offers[0]?.inputHash).toBe(offerInputHash(now, cfg));
    // Three writer calls, two judge calls and the read.
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(3 * 0.002 + 2 * 0.001 + 0.01);
  });

  it("never reads research the row has complete, nor without its row", async () => {
    const { registerOfferResearch } = await import("../src/_prospect-offer.ts");
    const research = vi.fn();
    registerOfferResearch(research);
    const complete = {
      ...target,
      productResearch: { version: 1, status: "complete", sources: [], external: { a: "b" } },
    };
    llm.replies = [five, JSON.stringify({ offers: [] }), JSON.stringify({ offers: [] })];
    llm.judge = [allWeak];
    await deriveOffers({
      target: complete,
      playName: "new-business",
      research: { queueRowId: 12, source: "find:x" },
    });
    llm.replies = [five, JSON.stringify({ offers: [] }), JSON.stringify({ offers: [] })];
    llm.judge = [allWeak];
    await deriveOffers({ target, playName: "new-business" });
    expect(research).not.toHaveBeenCalled();
    // Both still got both rescues.
    expect(llm.inputs).toHaveLength(8);
  });
});

// `offerWriter`: how many rewrite rounds follow the first set, and the model
// that writes them when the first set passed none.

describe("offerWriter rounds and fallback model", () => {
  const five = JSON.stringify({ offers: [good, second, third, fourth, fifth] });
  const allWeak = judgeReply([
    ["weak", "generic"],
    ["weak", "generic"],
    ["weak", "generic"],
    ["weak", "generic"],
    ["weak", "generic"],
  ]);
  const renewals = {
    ...good,
    offer: "book the leeds depot's boiler service renewals before each contract lapses",
    return: "service contracts renewed, counted per contract",
  };
  const lateVans = {
    ...good,
    offer: "route the leeds vans so each crew reaches its last call of the day on time",
    return: "late arrivals avoided, counted per job",
  };

  it("rounds 0 runs no rewrite: a first set with none passing is the skip", async () => {
    const { noStrongOfferWhy } = await import("../src/_prospect-offer.ts");
    cfg.offerWriter = { rounds: 0 };
    llm.replies = [five, JSON.stringify({ offers: [replacement] })];
    llm.judge = [allWeak];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(1);
    expect(offers).toEqual([]);
    expect(skip?.why).toBe(noStrongOfferWhy(0));
    expect(skip?.why).toBe("no offer passed the relevance check, with rewrites turned off");
  });

  it("rounds 0 keeps the passing offers of the first set without a replacement round", async () => {
    cfg.offerWriter = { rounds: 0 };
    llm.replies = [five, JSON.stringify({ offers: [replacement] })];
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot"],
        ["weak", "generic"],
        ["weak", "generic"],
        ["weak", "generic"],
        ["weak", "generic"],
      ]),
    ];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(1);
    expect(offers.map((o) => o.offer)).toEqual([good.offer]);
    expect(skip).toBeNull();
  });

  it("rounds 1 runs the replacement round alone, and the skip names one rewrite", async () => {
    cfg.offerWriter = { rounds: 1 };
    llm.replies = [five, JSON.stringify({ offers: [replacement] }), JSON.stringify({ offers: [] })];
    llm.judge = [allWeak, judgeReply([["weak", "generic"]])];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(2);
    expect(llm.inputs[1]).toContain("Write exactly 5 new offers");
    expect(offers).toEqual([]);
    expect(skip?.why).toBe("no offer passed the relevance check after 1 rewrite");
  });

  it("rounds 1 stores no skip when the replacement round's writer failed", async () => {
    cfg.offerWriter = { rounds: 1 };
    llm.replies = [five, WRITER_FAILS];
    llm.judge = [allWeak];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(offers).toEqual([]);
    expect(skip).toBeNull();
  });

  it("rounds 5 runs five rewrites, the last three from the role, each told every rejected offer", async () => {
    const { OFFER_ROLE_RESCUE } = await import("../src/_prospect-offer.ts");
    cfg.offerWriter = { rounds: 5 };
    llm.replies = [
      five,
      JSON.stringify({ offers: [replacement] }),
      JSON.stringify({ offers: [replacementTwo] }),
      JSON.stringify({ offers: [renewals] }),
      JSON.stringify({ offers: [lateVans] }),
      JSON.stringify({ offers: [] }),
    ];
    llm.judge = [
      allWeak,
      judgeReply([["weak", "round one"]]),
      judgeReply([["weak", "round two"]]),
      judgeReply([["weak", "round three"]]),
      judgeReply([["weak", "round four"]]),
    ];
    const { offers, skip } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(6);
    expect(llm.temperatures).toEqual([0.4, 0.4, 0.7, 0.7, 0.7, 0.7]);
    expect(llm.inputs[2]).not.toContain(OFFER_ROLE_RESCUE);
    for (const i of [3, 4, 5]) expect(llm.inputs[i]).toContain(OFFER_ROLE_RESCUE);
    // The fifth round is told the offers every earlier round had rejected.
    const last = llm.inputs[5]!;
    for (const o of [good, fifth]) expect(last).toContain(`- "${o.offer}": weak`);
    expect(last).toContain(`- "${replacement.offer}": weak, round one`);
    expect(last).toContain(`- "${renewals.offer}": weak, round three`);
    expect(last).toContain(`- "${lateVans.offer}": weak, round four`);
    expect(offers).toEqual([]);
    expect(skip?.why).toBe("no offer passed the relevance check after 5 rewrites");
  });

  it("clamps rounds over 5 to five rewrites", async () => {
    cfg.offerWriter = { rounds: 9 };
    llm.replies = [
      five,
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [] }),
      JSON.stringify({ offers: [] }),
    ];
    llm.judge = [allWeak];
    const { skip } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(6);
    expect(skip?.why).toBe("no offer passed the relevance check after 5 rewrites");
  });

  it("with no offerWriter runs three rewrites, every call on the workspace's model", async () => {
    llm.replies = [
      five,
      JSON.stringify({ offers: [replacement] }),
      JSON.stringify({ offers: [replacementTwo] }),
      JSON.stringify({ offers: [renewals] }),
    ];
    llm.judge = [
      allWeak,
      judgeReply([["weak", "generic"]]),
      judgeReply([["weak", "generic"]]),
      judgeReply([["weak", "generic"]]),
    ];
    const { skip } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs).toHaveLength(4);
    expect(llm.models).toEqual([undefined, undefined, undefined, undefined]);
    expect(llm.judgeModels.every((m) => m === undefined)).toBe(true);
    expect(skip?.why).toBe("no offer passed the relevance check after 3 rewrites");
  });

  it("writes every rewrite round on the fallback model when the first set passed none; the judge stays on its own", async () => {
    cfg.offerWriter = { fallbackOnWeak: true, fallbackModel: "fallback/strong-writer" };
    llm.replies = [
      five,
      JSON.stringify({ offers: [replacement] }),
      JSON.stringify({ offers: [replacementTwo] }),
    ];
    llm.judge = [
      allWeak,
      judgeReply([["weak", "generic"]]),
      judgeReply([["relevant", "their friday slots"]]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    // First set on the workspace's model; the replacement and the rescue on the fallback.
    expect(llm.models).toEqual([undefined, "fallback/strong-writer", "fallback/strong-writer"]);
    expect(llm.judgeModels).toEqual([undefined, undefined, undefined]);
    expect(offers.map((o) => [o.offer, o.writtenBy])).toEqual([
      [replacementTwo.offer, "fallback/strong-writer"],
    ]);
  });

  it("keeps the workspace's model for the rewrites when any first-set offer passed", async () => {
    cfg.offerWriter = { fallbackOnWeak: true, fallbackModel: "fallback/strong-writer" };
    llm.replies = [five, JSON.stringify({ offers: [replacement] })];
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot"],
        ["weak", "generic"],
        ["weak", "generic"],
        ["weak", "generic"],
        ["weak", "generic"],
      ]),
      judgeReply([["relevant", "their cancelled jobs"]]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.models).toEqual([undefined, undefined]);
    expect(offers.map((o) => [o.offer, o.writtenBy])).toEqual([
      [good.offer, "main/writer"],
      [replacement.offer, "main/writer"],
    ]);
  });

  it("never uses the fallback with the toggle off, or with no model named", async () => {
    for (const writer of [
      { fallbackOnWeak: false, fallbackModel: "fallback/strong-writer" },
      { fallbackModel: "fallback/strong-writer" },
      { fallbackOnWeak: true },
      { fallbackOnWeak: true, fallbackModel: "  " },
    ]) {
      cfg.offerWriter = writer;
      llm.models = [];
      llm.replies = [
        five,
        JSON.stringify({ offers: [] }),
        JSON.stringify({ offers: [] }),
        JSON.stringify({ offers: [] }),
      ];
      llm.judge = [allWeak];
      await deriveOffers({ target, playName: "new-business" });
      expect(llm.models).toEqual([undefined, undefined, undefined, undefined]);
    }
  });

  it("records the workspace's model on offers the first set kept", async () => {
    llm.replies = [JSON.stringify({ offers: [good] })];
    llm.judge = [judgeReply([["relevant", "the second depot"]])];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => o.writtenBy)).toEqual(["main/writer"]);
  });
});

describe("mergeKeptOffers", () => {
  const stamp = { version: OFFER_PROMPT_VERSION, inputHash: "h", derivedAt: "2026-10-29" };
  const strong = (o: typeof good) => ({
    ...o,
    ...stamp,
    level: "researched" as const,
    relevance: "relevant" as const,
  });

  it("puts the new offers first, then the old strong ones, without weak, stale or repeated ones", async () => {
    const { mergeKeptOffers } = await import("../src/_prospect-offer.ts");
    const founders = {
      ...good,
      offer: "a founder's own words",
      version: "offer-v2",
      inputHash: "",
      derivedAt: "2026-01-01",
      level: "researched" as const,
      editedBy: "founder" as const,
    };
    const weak = { ...strong(third), relevance: "weak" as const };
    const approvedWeak = { ...weak, offer: fourth.offer, weakApprovedAt: "2026-10-28" };
    const stale = { ...strong(fifth), version: "offer-v6" };
    const unjudged = { ...good, ...stamp, level: "researched" as const, offer: "never judged" };
    const repeat = strong({ ...replacement, offer: `  ${replacement.offer.toUpperCase()} ` });
    const merged = mergeKeptOffers([strong(replacement), strong(replacementTwo)], founders, [
      strong(second),
      weak,
      approvedWeak,
      stale,
      unjudged,
      repeat,
      founders,
    ]);
    expect(merged.map((o) => o.offer)).toEqual([
      replacement.offer,
      replacementTwo.offer,
      founders.offer,
      second.offer,
    ]);
  });

  it("holds at most five, and nothing old when the new set is full", async () => {
    const { mergeKeptOffers, OFFER_COUNT } = await import("../src/_prospect-offer.ts");
    const fresh = [good, second, third, fourth, fifth].map(strong);
    expect(mergeKeptOffers(fresh, strong(replacement), [strong(replacementTwo)])).toEqual(fresh);
    expect(OFFER_COUNT).toBe(5);
  });
});

describe("New offers writes around the ones it replaces", () => {
  it("names them in the first message and drops a reply that repeats one", async () => {
    llm.replies = [JSON.stringify({ offers: [good, second] }), JSON.stringify({ offers: [third] })];
    const { offers } = await deriveOffers({
      target,
      playName: "new-business",
      avoid: [good.offer, "  "],
    });
    expect(llm.inputs[0]).toContain(`ALREADY OFFERED:\n- ${good.offer}`);
    expect(llm.inputs[0]).not.toContain("- \n");
    // The repeat failed as one, so the repair round asked again.
    expect(llm.inputs[1]).toContain("the same job as another offer");
    expect(offers.map((o) => o.offer)).toEqual([second.offer, third.offer]);
  });
});

describe("new research re-derives the offers", () => {
  it("a stored set is kept for the research it was written from and rewritten once research lands", async () => {
    const research = offerResearchText(target);
    const stored = {
      ...good,
      level: "researched" as const,
      angles: [],
      version: OFFER_PROMPT_VERSION,
      inputHash: offerInputHash(research, cfg),
      productHash: offerProductHash(cfg),
      derivedAt: "",
    };
    const kept = await ensureOfferSet({ target: { ...target, offer: stored }, playName: "x" });
    expect(kept?.changed).toBe(false);
    expect(llm.inputs).toHaveLength(0);
    llm.replies = [JSON.stringify({ offers: [second] })];
    const fresh = await ensureOfferSet({
      target: {
        ...target,
        offer: stored,
        productResearch: {
          version: 1,
          status: "complete",
          sources: [{ url: "https://northside.example", kind: "website", excerpt: "Two depots" }],
          external: { answer: "Northside runs a fleet of vans" },
        },
      },
      playName: "x",
    });
    expect(fresh?.changed).toBe(true);
    expect(llm.inputs[0]).toContain("Northside runs a fleet of vans");
  });
});

// The bar: an offer is a multi-week goal with a counted return, never one
// pass of checking. The writer prompt, the judge prompt and the decisions
// criteria carry the same rule; the lint backs the writer's lead list.

describe("the offer bar", () => {
  const prompts = join(import.meta.dirname, "..", "..", "prompts");
  const writer = readFileSync(join(prompts, "prospect-offer.md"), "utf8");
  const judge = readFileSync(join(prompts, "prospect-offer-judge.md"), "utf8");
  const checkPass =
    "a single pass of checking, screening, vetting, verifying, scanning, auditing, validating or patching";
  const leads = ["vet", "verify", "validate", "screen", "scan", "audit", "check"];

  it("the writer starts from the firm's goals and states the bar", () => {
    expect(writer).toContain("## The bar");
    expect(writer).toContain("most valuable outcomes this quarter");
    expect(writer.toLowerCase()).toContain(`${checkPass} is a step, never the offer`);
    expect(writer).toContain(
      "An offer never opens with vet, verify, validate, screen, scan, audit or check.",
    );
    expect(writer).toContain("only when nothing bigger is honest");
    // The weeks of work may be the machine's, outside parties', or both.
    expect(writer).toContain("by machine, with outside parties, or both");
    expect(writer).toContain("on its own is insight, never the offer");
  });

  it("the judge holds machine work and plans changed on a forecast to the same bar", () => {
    expect(judge).toContain("by machine, with outside parties, or both");
    expect(judge).toContain("a forecast or analysis offered without the plan it changes");
  });

  it("the lint flags every lead the writer prompt names, and no other", () => {
    const research = offerResearchText(target);
    for (const lead of leads) {
      expect(
        lintOffer({ ...good, level: "researched", offer: `${lead} the leeds bookings` }, research),
      ).toContain("offer-is-a-check");
    }
    for (const lead of ["review", "inspect", "assess"]) {
      expect(
        lintOffer({ ...good, level: "researched", offer: `${lead} the leeds bookings` }, research),
      ).not.toContain("offer-is-a-check");
    }
  });

  it("both judge engines carry the same test", async () => {
    const { offerRelevanceCriteria } = await import("../src/_prospect-offer.ts");
    const criteria = offerRelevanceCriteria();
    expect(criteria).toMatchInlineSnapshot(`
      {
        "irrelevant": "A job this firm does not have: work for a department a firm of its size and stage does not have, a process in a market it only sells into, or work far from this person's role.",
        "relevant": "A goal this firm at its stage would put on its plan and this person is measured on, carried over weeks of work (by machine, with outside parties, or both) to a counted return (money in or no longer spent, or something signed, closed, launched or shipped), resting on a specific fact about them: a piece their own product is missing to finish its job for its customers (never the job it already does), or a goal their own firm visibly has outside its core product.",
        "weak": "Plausible, but generic (it would fit most firms of this kind unchanged) or resting on an industry, sector or customer word rather than a fact about this firm. Also weak: an offer that does the job their own product already does or sells for its customers (it could be their own homepage headline), a goal another leader owns rather than one this person is measured on (a collecting, recovering, reconciling or re-planning job offered bare to a technology, engineering, data or AI leader, whose goal is the system that does it, shipped into a named workflow of theirs), a single pass of checking, screening, vetting, verifying, scanning, auditing, validating or patching offered as the job itself, a forecast or analysis offered without the plan it changes, a return that is not a counted outcome, an offer about a third party's project the person only follows, starred, forked or attended an event about, or one that restates the product's own capability rather than a goal of the prospect's firm or own project.",
      }
    `);
    // The llm judge's labels say the same as the decisions criteria.
    const label = (name: string): string =>
      judge.match(new RegExp(`^- \`${name}\`: (.+)$`, "m"))?.[1] ?? "";
    expect(label("relevant").toLowerCase()).toBe(criteria.relevant.toLowerCase());
    expect(label("weak").toLowerCase()).toBe(criteria.weak.toLowerCase());
    expect(criteria.weak).toContain(checkPass);
  });

  // An offer that does their product's own job reads as a competitor's pitch,
  // and a goal another leader owns is not this person's: writer, judge and
  // criteria carry both.
  it("their product's own job and another leader's goal are weak everywhere", async () => {
    const { offerRelevanceCriteria } = await import("../src/_prospect-offer.ts");
    const { weak } = offerRelevanceCriteria();
    for (const text of [writer, judge, weak]) {
      expect(text).toContain("homepage headline");
      expect(text).toContain("another leader owns");
    }
    expect(writer).toContain("a piece their product is missing to finish its job");
    expect(writer).toContain("What does this person's own leadership review them on this quarter");
    expect(writer).toContain("Specific in the sentence itself, not only in `evidence`");
  });

  // How they were found is a signal, not their project: the writer, the judge
  // prompt and the decisions criteria carry the same rule.
  it("how they were found is never their project, and the brief is never their goal", async () => {
    const signal =
      "How they were found (a repository they starred or follow, an event they joined, a post they reacted to, a tool they use) says what they are looking at, not what they own or run.";
    expect(writer).toContain(signal);
    expect(judge).toContain(signal);
    expect(writer).toContain(
      "A third party's project is never their firm or their project: never an offer to build, ship, improve, test or run it.",
    );
    expect(writer).toContain("is a restatement of the brief, not a goal of theirs");
    expect(writer).toContain(
      "A project they starred, follow, forked or attended an event about is not their project.",
    );
    expect(writer).toContain(
      "Skip when nothing is known beyond how they were found: no title, no company, no project of their own, no research. `why` says so.",
    );
    expect(writer).toContain("Their own project is never a reason to skip.");
    expect(writer).not.toContain("a repository they work on or follow");
    const rule =
      "an offer about a third party's project the person only follows, starred, forked or attended an event about, or one that restates the product's own capability rather than a goal of the prospect's firm or own project";
    expect(judge).toContain(rule);
    const { offerRelevanceCriteria } = await import("../src/_prospect-offer.ts");
    expect(offerRelevanceCriteria().weak).toContain(rule);
  });
});

describe("the prompt version bump", () => {
  const research = offerResearchText(target);
  const old = {
    ...good,
    offer: "the old offer for the leeds depot",
    level: "researched" as const,
    version: "offer-v4",
    inputHash: offerInputHash(research, cfg, "offer-v4"),
    productHash: offerProductHash(cfg),
    angles: [],
    derivedAt: "",
  };

  it("re-derives an unedited offer written under the old prompt", async () => {
    llm.replies = [JSON.stringify({ offers: [good] }), JSON.stringify({ angles: [] })];
    const out = await ensureOfferSet({
      target: { ...target, offer: old },
      playName: "new-business",
    });
    if (!out || isOfferSkipped(out)) throw new Error("expected offers");
    expect(out.changed).toBe(true);
    expect(out.offer.offer).toBe(good.offer);
    expect(out.offer.version).toBe(OFFER_PROMPT_VERSION);
    llm.replies = [JSON.stringify({ offers: [good] }), JSON.stringify({ angles: [] })];
    const draft = await offerForDraft({
      target: { ...target, offer: old },
      playName: "new-business",
    });
    expect(draft?.version).toBe(OFFER_PROMPT_VERSION);
  });

  it("keeps a founder-edited offer and a weak one the founder approved", async () => {
    const edited = { ...old, editedBy: "founder" as const };
    const approved = { ...old, relevance: "weak" as const, weakApprovedAt: "2026-10-01T00:00:00Z" };
    for (const offer of [edited, approved]) {
      const out = await ensureOfferSet({ target: { ...target, offer }, playName: "new-business" });
      if (!out || isOfferSkipped(out)) throw new Error("expected the stored offer");
      expect(out.changed).toBe(false);
      expect(out.offer).toBe(offer);
      expect(await offerForDraft({ target: { ...target, offer }, playName: "new-business" })).toBe(
        offer,
      );
    }
    expect(llm.inputs).toHaveLength(0);
  });

  it("never drafts from a stored weak offer nobody approved, of any version: it is written again", async () => {
    const weakFields = { relevance: "weak" as const, relevanceWhy: "would fit any trade business" };
    // A legacy filler, and one of today's version a re-judge rated weak.
    const legacy = { ...old, ...weakFields };
    const current = {
      ...old,
      ...weakFields,
      version: OFFER_PROMPT_VERSION,
      inputHash: offerInputHash(research, cfg),
    };
    for (const offer of [legacy, current]) {
      llm.replies = [JSON.stringify({ offers: [good] }), JSON.stringify({ angles: [] })];
      const draft = await offerSetForDraft({
        target: { ...target, offer, offerCandidates: [offer] },
        playName: "new-business",
      });
      if (!draft || isOfferSkipped(draft)) throw new Error("expected offers");
      expect(draft.derived).toBe(true);
      expect(draft.offer.offer).toBe(good.offer);
      expect(draft.candidates.map((c) => c.relevance)).not.toContain("weak");
      llm.replies = [JSON.stringify({ offers: [good] }), JSON.stringify({ angles: [] })];
      const row = await ensureOfferSet({
        target: { ...target, offer, offerCandidates: [offer] },
        playName: "new-business",
      });
      if (!row || isOfferSkipped(row)) throw new Error("expected offers");
      expect(row.changed).toBe(true);
      expect(row.offer.offer).toBe(good.offer);
    }
    // The founder's edit of a weak one, or their approval, still stands.
    for (const offer of [
      { ...current, editedBy: "founder" as const },
      { ...current, weakApprovedAt: "2026-10-01T00:00:00Z" },
    ]) {
      const calls = llm.inputs.length;
      expect(await offerForDraft({ target: { ...target, offer }, playName: "new-business" })).toBe(
        offer,
      );
      const row = await ensureOfferSet({ target: { ...target, offer }, playName: "new-business" });
      expect(row && !isOfferSkipped(row) && row.offer).toBe(offer);
      expect(llm.inputs.length).toBe(calls);
    }
  });

  it("keeps an edited or approved offer when this version reads its GitHub record", async () => {
    // Written under offer-v5, which never read the record: today's research
    // text (and so its input hash) has a section the offer was not written from.
    const row = { ...target, githubEvidence: "Own repos:\n- depot-planner (Go) — plans depots" };
    const v5 = {
      ...old,
      version: "offer-v5",
      inputHash: offerInputHash(offerResearchText(row, null, "offer-v5"), cfg, "offer-v5"),
    };
    expect(v5.inputHash).not.toBe(offerInputHash(offerResearchText(row), cfg, "offer-v5"));
    const edited = { ...v5, editedBy: "founder" as const };
    const approved = { ...v5, relevance: "weak" as const, weakApprovedAt: "2026-10-01T00:00:00Z" };
    for (const offer of [edited, approved]) {
      const out = await ensureOfferSet({ target: { ...row, offer }, playName: "repo-interest" });
      if (!out || isOfferSkipped(out)) throw new Error("expected the stored offer");
      expect(out.changed).toBe(false);
      expect(out.offer).toBe(offer);
      expect(await offerForDraft({ target: { ...row, offer }, playName: "repo-interest" })).toBe(
        offer,
      );
    }
    expect(llm.inputs).toHaveLength(0);
    // An unedited one is written again, now with the record in RESEARCH.
    llm.replies = [JSON.stringify({ offers: [good] }), JSON.stringify({ angles: [] })];
    const out = await ensureOfferSet({
      target: { ...row, offer: v5 },
      playName: "repo-interest",
    });
    if (!out || isOfferSkipped(out)) throw new Error("expected offers");
    expect(out.changed).toBe(true);
    expect(llm.inputs[0]).toContain("THEIR GITHUB:");
  });

  it("still re-derives an approved offer when its research changed", async () => {
    const approved = {
      ...old,
      relevance: "weak" as const,
      weakApprovedAt: "2026-10-01T00:00:00Z",
      inputHash: "from-other-research",
    };
    llm.replies = [JSON.stringify({ offers: [good] }), JSON.stringify({ angles: [] })];
    const out = await ensureOfferSet({
      target: { ...target, offer: approved },
      playName: "new-business",
    });
    if (!out || isOfferSkipped(out)) throw new Error("expected offers");
    expect(out.changed).toBe(true);
    expect(out.offer.offer).toBe(good.offer);
    // A draft path that skips `ensureOfferSet` does not send it either.
    llm.replies = [JSON.stringify({ offers: [good] }), JSON.stringify({ angles: [] })];
    const draft = await offerForDraft({
      target: { ...target, offer: approved },
      playName: "new-business",
    });
    expect(draft?.offer).toBe(good.offer);
  });

  it("a draft keeps an approved offer whatever research the play's enrichment adds", async () => {
    const approved = { ...old, relevance: "weak" as const, weakApprovedAt: "2026-10-01T00:00:00Z" };
    const draft = await offerForDraft({
      target: { ...target, offer: approved },
      dossier: "enrichment the offer never saw",
      playName: "new-business",
    });
    expect(draft).toBe(approved);
    // One a draft wrote from the row and its dossier is kept for that dossier.
    const dossier = "enrichment the draft wrote it from";
    const fromDraft = {
      ...approved,
      inputHash: offerInputHash(offerResearchText(target, dossier), cfg, "offer-v4"),
    };
    expect(
      await offerForDraft({
        target: { ...target, offer: fromDraft },
        dossier,
        playName: "new-business",
      }),
    ).toBe(fromDraft);
    expect(llm.inputs).toHaveLength(0);
  });
});

// `offerExclusions`: kinds of goal the founder never offers. The writer is
// told them, both judge engines rate such an offer irrelevant, and nothing
// changes for a workspace without them.

describe("offer exclusions", () => {
  const research = offerResearchText(target);
  const hiring = {
    ...good,
    offer: "hire two dispatchers for the leeds depot before the winter peak",
    return: "open dispatcher roles filled, counted per hire",
  };
  const exclusions = [
    "  recruiting:  hiring, sourcing, vetting or interviewing people for the prospect's own open roles ",
    "",
    "   ",
  ];
  const kind =
    "recruiting: hiring, sourcing, vetting or interviewing people for the prospect's own open roles";

  afterEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
  });

  it("the writer is told NEVER OFFER, trimmed and without blanks; without exclusions, nothing", async () => {
    llm.replies = [JSON.stringify({ offers: [good] })];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[0]).not.toContain("NEVER OFFER");
    cfg.offerExclusions = exclusions;
    llm.replies = [JSON.stringify({ offers: [good] })];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[1]).toContain(`NEVER OFFER:\n- ${kind}\n\nPLAY: new-business`);
    expect(llm.inputs[1]).toContain("OFFER TERMS: a free month on one depot\n\nNEVER OFFER:");
  });

  it("an excluded offer is dropped like an irrelevant one, never a filler, and the writer is told why", async () => {
    cfg.offerExclusions = exclusions;
    llm.replies = [
      JSON.stringify({ offers: [good, second, hiring] }),
      JSON.stringify({ offers: [replacement] }),
    ];
    llm.judge = [
      JSON.stringify({
        judgements: [
          { offer: 1, label: "relevant", why: "the second depot" },
          { offer: 2, label: "relevant", why: "cancelled slots" },
          { offer: 3, label: "relevant", why: "recruiting", excluded: true },
        ],
      }),
      judgeReply([["relevant", "cancelled jobs"]]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(llm.judgeInputs[0]).toContain(`NEVER OFFER:\n- ${kind}`);
    expect(llm.inputs[1]).toContain(`"${hiring.offer}": irrelevant, excluded: recruiting`);
    expect(offers.map((o) => o.offer)).toEqual([good.offer, second.offer, replacement.offer]);
  });

  it("llm engine: excluded makes the label irrelevant; without exclusions the flag is ignored", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    const reply = JSON.stringify({
      judgements: [
        { offer: 1, label: "relevant", why: "the second depot" },
        { offer: 2, label: "weak", why: "hiring for their open roles", excluded: true },
      ],
    });
    llm.judge = [reply];
    const plain = await judgeOffers([good, hiring], research, target, cfg as never);
    expect(plain?.map((j) => [j?.label, j?.pass, j?.excluded])).toEqual([
      ["relevant", true, undefined],
      ["weak", false, undefined],
    ]);
    expect(llm.judgeInputs[0]).not.toContain("NEVER OFFER");
    cfg.offerExclusions = exclusions;
    llm.judge = [reply];
    const out = await judgeOffers([good, hiring], research, target, cfg as never);
    expect(out?.[0]).toMatchObject({ label: "relevant", pass: true });
    expect(out?.[0]?.excluded).toBeUndefined();
    expect(out?.[1]).toMatchObject({
      label: "irrelevant",
      pass: false,
      excluded: true,
      why: "excluded: hiring for their open roles",
    });
    expect(llm.judgeInputs[1]).toContain(`NEVER OFFER:\n- ${kind}`);
  });

  it("llm engine: an excluded flag without a valid label still excludes; without exclusions it gives no verdict", async () => {
    const { judgeOffers } = await import("../src/_prospect-offer.ts");
    const reply = JSON.stringify({
      judgements: [
        { offer: 1, label: "relevant", why: "the second depot" },
        { offer: 2, why: "hiring for their open roles", excluded: true },
      ],
    });
    llm.judge = [reply];
    const plain = await judgeOffers([good, hiring], research, target, cfg as never);
    expect(plain?.[1]).toBeNull();
    cfg.offerExclusions = exclusions;
    llm.judge = [reply];
    const out = await judgeOffers([good, hiring], research, target, cfg as never);
    expect(out?.[1]).toMatchObject({ label: "irrelevant", pass: false, excluded: true });
  });

  it("decisions engine: an exclusion question per offer, and irrelevant names the kinds", async () => {
    const { judgeOffers, offerRelevanceCriteria } = await import("../src/_prospect-offer.ts");
    process.env["OPENROUTER_API_KEY"] = "test-key";
    cfg.offerExclusions = exclusions;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "test/decisions-model",
            answers: {
              offer_1: { choice: "relevant", confidence: 0.8, probabilities: { relevant: 0.8 } },
              offer_2: { choice: "relevant", confidence: 0.9, probabilities: { relevant: 0.9 } },
              excluded_1: { choice: "allowed", probabilities: { allowed: 0.95, excluded: 0.05 } },
              excluded_2: { choice: "excluded", probabilities: { excluded: 0.92, allowed: 0.08 } },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const out = await judgeOffers(
      [good, hiring],
      research,
      target,
      { ...cfg, offerJudge: { engine: "decisions", model: "test/decisions-model" } } as never,
      { fetchImpl: fetchImpl as never },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body.questions)).toEqual(["offer_1", "excluded_1", "offer_2", "excluded_2"]);
    expect(body.questions.offer_1.criteria).toEqual(offerRelevanceCriteria([kind]));
    expect(body.questions.offer_1.criteria.irrelevant).toContain(kind);
    expect(body.questions.offer_1.instructions).toContain("NEVER OFFER");
    expect(Object.keys(body.questions.excluded_2.criteria)).toEqual(["excluded", "allowed"]);
    expect(body.questions.excluded_2.criteria.excluded).toContain(kind);
    expect(body.state).toContain(`NEVER OFFER:\n- ${kind}`);
    expect(out?.map((j) => [j?.label, j?.pass, j?.excluded, j?.why])).toEqual([
      ["relevant", true, undefined, "relevant 0.80"],
      ["irrelevant", false, true, "excluded 0.92"],
    ]);
  });

  it("without exclusions the criteria are as before", async () => {
    const { offerRelevanceCriteria } = await import("../src/_prospect-offer.ts");
    expect(offerRelevanceCriteria([])).toEqual(offerRelevanceCriteria());
    expect(offerRelevanceCriteria().irrelevant).not.toContain("NEVER OFFER");
  });

  it("is not part of an offer's input or product hash: stored offers stand until swept", () => {
    const withExclusions = { ...cfg, offerExclusions: [kind] };
    expect(offerInputHash(research, withExclusions)).toBe(offerInputHash(research, cfg));
    expect(offerProductHash(withExclusions)).toBe(offerProductHash(cfg));
  });

  it("the writer and judge prompts carry the rule, naming no kind of goal", () => {
    const prompts = join(import.meta.dirname, "..", "..", "prompts");
    const writer = readFileSync(join(prompts, "prospect-offer.md"), "utf8");
    const judge = readFileSync(join(prompts, "prospect-offer-judge.md"), "utf8");
    expect(writer).toContain("- NEVER OFFER (optional):");
    expect(writer).toContain("No offer, in any wording, is a goal of a kind listed in NEVER OFFER");
    expect(judge).toContain("- NEVER OFFER (optional):");
    expect(judge).toContain('set `"excluded": true`');
    for (const text of [writer, judge]) expect(text.toLowerCase()).not.toContain("recruit");
  });
});

// `offerAnchor`: where the research allows a choice, the founder can prefer a
// goal of the prospect's own product. The writer and the judge are told, the
// passing product-anchored offers lead, and a workspace that has not set it
// sees the message, the criteria and the order it always saw.

describe("offer anchor", () => {
  const research = offerResearchText(target);
  const product = { ...good, anchor: "product" as const };
  const firm = {
    ...second,
    anchor: "firm" as const,
  };
  const ANCHOR_LINE = "ANCHOR: prefer their product.";

  it("the writer is told, after NEVER OFFER; `either` and an unknown value say nothing", async () => {
    llm.replies = [JSON.stringify({ offers: [good] })];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[0]).not.toContain("ANCHOR");

    cfg.offerAnchor = "either";
    llm.replies = [JSON.stringify({ offers: [good] })];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[1]).not.toContain("ANCHOR");

    (cfg as { offerAnchor?: unknown }).offerAnchor = "prefer_product";
    llm.replies = [JSON.stringify({ offers: [good] })];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[2]).not.toContain("ANCHOR");

    cfg.offerAnchor = "prefer-product";
    cfg.offerExclusions = ["legal work: drafting the prospect's own contracts"];
    llm.replies = [JSON.stringify({ offers: [good] })];
    await deriveOffers({ target, playName: "new-business" });
    expect(llm.inputs[3]).toContain(`${ANCHOR_LINE}`);
    expect(llm.inputs[3]).toContain("own contracts\n\nANCHOR: prefer their product.");
    expect(llm.inputs[3]).toContain("not penalised.\n\nPLAY: new-business");
  });

  it("the judge is told, and its weak criterion gains the preference", async () => {
    const { judgeOffers, offerRelevanceCriteria } = await import("../src/_prospect-offer.ts");
    expect(offerRelevanceCriteria([], "either")).toEqual(offerRelevanceCriteria());
    expect(offerRelevanceCriteria().weak).not.toContain("resting on their firm where RESEARCH");
    expect(offerRelevanceCriteria([], "prefer-product").weak).toContain(
      "resting on their firm where RESEARCH plainly says what their own product does",
    );

    llm.judge = [judgeReply([["relevant", "the second depot"]])];
    await judgeOffers([good], research, target, cfg as never);
    expect(llm.judgeInputs[0]).not.toContain("ANCHOR");

    cfg.offerAnchor = "prefer-product";
    llm.judge = [judgeReply([["relevant", "the second depot"]])];
    await judgeOffers([good], research, target, cfg as never);
    expect(llm.judgeInputs[1]).toContain(ANCHOR_LINE);
  });

  it("a passing product-anchored offer leads; a weak one does not overtake", async () => {
    const { preferProductAnchor } = await import("../src/_prospect-offer.ts");
    const relevant = { relevance: "relevant" as const };
    const weak = { relevance: "weak" as const };
    const set = [
      { ...firm, ...relevant },
      { ...product, offer: "a", ...weak },
      { ...product, offer: "b", ...relevant },
      { ...product, offer: "c", ...relevant },
    ];
    expect(preferProductAnchor(set, "prefer-product").map((o) => o.offer)).toEqual([
      "b",
      "c",
      firm.offer,
      "a",
    ]);
    // `either` and a set with no anchors at all keep the model's order.
    expect(preferProductAnchor(set, "either")).toEqual(set);
    const unanchored = [
      { ...good, ...relevant },
      { ...second, ...relevant },
    ];
    expect(preferProductAnchor(unanchored, "prefer-product")).toEqual(unanchored);
  });

  it("an offer the judge gave no verdict on holds its place, never overtaking one that passed", async () => {
    const { preferProductAnchor } = await import("../src/_prospect-offer.ts");
    // judgeAndReplace keeps an offer with no judgement (a missing verdict is
    // not a failure), so it reaches here with `relevance` unset. Unassessed is
    // not passing: it must not lead a firm offer the judge actually passed.
    const set = [
      { ...firm, relevance: "relevant" as const },
      { ...product, offer: "unjudged" },
    ];
    expect(preferProductAnchor(set, "prefer-product").map((o) => o.offer)).toEqual([
      firm.offer,
      "unjudged",
    ]);
    // It keeps its place among other unjudged ones rather than being demoted.
    const none = [{ ...firm }, { ...product, offer: "unjudged" }];
    expect(preferProductAnchor(none, "prefer-product").map((o) => o.offer)).toEqual([
      firm.offer,
      "unjudged",
    ]);
  });

  it("a founder-approved weak product offer leads; an edited one is not held back", async () => {
    const { preferProductAnchor } = await import("../src/_prospect-offer.ts");
    const firmFirst = { ...firm, relevance: "relevant" as const };
    const approved = {
      ...product,
      offer: "approved",
      relevance: "weak" as const,
      weakApprovedAt: "2026-10-27T00:00:00.000Z",
    };
    const edited = {
      ...product,
      offer: "edited",
      relevance: "weak" as const,
      editedBy: "founder" as const,
    };
    expect(
      preferProductAnchor([firmFirst, approved, edited], "prefer-product").map((o) => o.offer),
    ).toEqual(["approved", "edited", firm.offer]);
  });

  it("deriveOffers reorders what it keeps, and the writer's anchor is stored", async () => {
    cfg.offerAnchor = "prefer-product";
    llm.replies = [JSON.stringify({ offers: [firm, product] })];
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot"],
        ["relevant", "same-day slots"],
      ]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => [o.offer, o.anchor])).toEqual([
      [product.offer, "product"],
      [firm.offer, "firm"],
    ]);
  });

  it("an offer with no anchor, or an unknown one, stores none", async () => {
    llm.replies = [JSON.stringify({ offers: [good, { ...second, anchor: "their product" }] })];
    llm.judge = [
      judgeReply([
        ["relevant", "the second depot"],
        ["relevant", "cancelled slots"],
      ]),
    ];
    const { offers } = await deriveOffers({ target, playName: "new-business" });
    expect(offers.map((o) => o.anchor)).toEqual([undefined, undefined]);
  });

  it("is not part of an offer's input or product hash: stored offers stand until swept", () => {
    const preferring = { ...cfg, offerAnchor: "prefer-product" as const };
    expect(offerInputHash(research, preferring)).toBe(offerInputHash(research, cfg));
    expect(offerProductHash(preferring)).toBe(offerProductHash(cfg));
  });

  it("the writer and judge prompts carry the rule and the output field", () => {
    const prompts = join(import.meta.dirname, "..", "..", "prompts");
    const writer = readFileSync(join(prompts, "prospect-offer.md"), "utf8");
    const judge = readFileSync(join(prompts, "prospect-offer-judge.md"), "utf8");
    expect(writer).toContain("- ANCHOR (optional):");
    expect(writer).toContain('"anchor": "product" | "firm"');
    expect(writer).toContain("With `ANCHOR: prefer their product`");
    expect(judge).toContain("- ANCHOR (optional):");
    expect(judge).toContain("With `ANCHOR: prefer their product`, an offer resting on their firm");
  });
});
