import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #584: the angle is chosen in code, by an isolated classifier call,
// cached per (prospect, edge) — never by the writing prompt. A one-angle edge
// makes no call and reaches the prompt byte-identical to before.

const calls = {
  classifier: [] as string[],
  writer: [] as string[],
};
/** What the mocked classifier answers; tests override. */
let classifierAnswer: unknown = { index: 2 };
/** In-memory stand-in for product_research_cache. */
const cache = new Map<string, string>();

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
      founderCohort: null,
      mobileSignature: false,
      clientId: "test",
    }),
    enrichProfile: async () => ({ result: { profile: {} }, receiptId: 1 }),
    sendEmail: async () => ({ receiptId: 3 }),
    getLedger: () => ({
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
      hasSentSequenceEvent: () => false,
      findProspectByEmail: () => null,
      getProspectById: () => null,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
      getProductResearchCache: (key: string) => cache.get(key) ?? null,
      setProductResearchCache: (key: string, json: string) => {
        cache.set(key, json);
      },
    }),
    receiptUrlForId: (id: number) => `oneshot://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: (name: string) => (name === "angle-select" ? "choose" : "system"),
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      const user = input.messages.find((m) => m.role === "user")?.content ?? "";
      if (user.startsWith("ANGLES:")) {
        calls.classifier.push(user);
        return { content: JSON.stringify(classifierAnswer), provider: "t", model: "t" };
      }
      calls.writer.push(user);
      return { content: JSON.stringify({ subject: "s", body: "b" }), provider: "t", model: "t" };
    },
  };
});

const {
  splitEdgeAngles,
  selectAngle,
  hashPick,
  describeTargetForAngle,
  followUpEdgeBlock,
  edgeKey,
} = await import("../src/_angles.ts");
const { runAcceleratorBatch } = await import("../src/accelerator-batch.ts");

const A1 = "For a founder whose buyers are engineers — the second touch is where it dies.";
const A2 = "For a founder selling to clinics and contractors — the data breaks first.";
const A3 = "For a founder still testing the pitch — volume buys ambiguity.";
const EDGE = `${A1} // ${A2} // ${A3}`;

beforeEach(() => {
  calls.classifier = [];
  calls.writer = [];
  classifierAnswer = { index: 2 };
  cache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("splitEdgeAngles", () => {
  it("splits on // and trims, dropping empties", () => {
    expect(splitEdgeAngles(` ${A1} //  ${A2}// // ${A3} `)).toEqual([A1, A2, A3]);
  });
  it("a plain edge is one angle; blank is none", () => {
    expect(splitEdgeAngles(A1)).toEqual([A1]);
    expect(splitEdgeAngles("")).toEqual([]);
    expect(splitEdgeAngles(null)).toEqual([]);
  });
});

describe("selectAngle", () => {
  it("a one-angle edge makes no classifier call", async () => {
    const sel = await selectAngle({ edge: A1, prospectKey: "a@b.co", description: "x" });
    expect(sel).toMatchObject({ index: 0, angle: A1, count: 1, method: "single" });
    expect(calls.classifier).toHaveLength(0);
  });

  it("a multi-angle edge asks the classifier once and returns its pick", async () => {
    classifierAnswer = { index: 2, why: "clinics" };
    const sel = await selectAngle({
      edge: EDGE,
      prospectKey: "a@b.co",
      description: "company: Dentix\nproductOneLiner: scheduling for dental clinics",
    });
    expect(sel).toMatchObject({ index: 1, angle: A2, count: 3, method: "classifier" });
    expect(calls.classifier).toHaveLength(1);
    expect(calls.classifier[0]).toContain("1. " + A1);
    expect(calls.classifier[0]).toContain("PROSPECT:\ncompany: Dentix");
  });

  it("the verdict is cached per (prospect, edge): a regenerate makes the same choice for free", async () => {
    classifierAnswer = { index: 3 };
    const first = await selectAngle({ edge: EDGE, prospectKey: "A@B.co", description: "x" });
    classifierAnswer = { index: 1 }; // would differ if asked again
    const second = await selectAngle({ edge: EDGE, prospectKey: "a@b.co", description: "x" });
    expect(first.index).toBe(2);
    expect(second).toMatchObject({ index: 2, method: "cached" });
    expect(calls.classifier).toHaveLength(1);
  });

  it("a rewritten edge is a different cache entry", async () => {
    await selectAngle({ edge: EDGE, prospectKey: "a@b.co", description: "x" });
    await selectAngle({ edge: `${A1} // ${A3}`, prospectKey: "a@b.co", description: "x" });
    expect(calls.classifier).toHaveLength(2);
    expect(edgeKey(EDGE)).not.toBe(edgeKey(`${A1} // ${A3}`));
  });

  it("an out-of-range or unparseable answer falls back to the stable hash, never blocks", async () => {
    classifierAnswer = { index: 9 };
    const sel = await selectAngle({ edge: EDGE, prospectKey: "a@b.co", description: "x" });
    expect(sel.method).toBe("hash");
    expect(sel.index).toBe(hashPick("a@b.co", 3, null));
    classifierAnswer = "not json at all";
    cache.clear();
    const sel2 = await selectAngle({ edge: EDGE, prospectKey: "c@d.co", description: "x" });
    expect(sel2.method).toBe("hash");
  });

  it("excludeIndex is never returned — by the classifier, the cache, or the hash", async () => {
    classifierAnswer = { index: 1 }; // the excluded one
    const sel = await selectAngle({
      edge: EDGE,
      prospectKey: "a@b.co",
      description: "x",
      excludeIndex: 0,
    });
    expect(sel.index).not.toBe(0);
    expect(calls.classifier[0]).toContain("EXCLUDE: 1");
    for (const who of ["a@b.co", "z@y.io", "q@w.dev"]) {
      expect(hashPick(who, 3, 0)).not.toBe(0);
    }
  });
});

describe("hashPick", () => {
  it("is stable for a prospect and spread across prospects", () => {
    expect(hashPick("a@b.co", 4, null)).toBe(hashPick("A@B.CO ", 4, null));
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) seen.add(hashPick(`p${i}@x.co`, 4, null));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("describeTargetForAngle", () => {
  it("carries the person and setting, not identifiers, URLs, or the edge itself", () => {
    const d = describeTargetForAngle(
      {
        name: "Nico",
        email: "n@carvuk.com",
        company: "Carvuk",
        title: "Co-Founder & CTO",
        attendeeBio: "cofounder and CTO @carvuk",
        eventTitle: "Llama Lounge 26",
        eventUrl: "https://luma.com/x",
        linkedinUrl: "https://linkedin.com/in/n",
        yourEdge: EDGE,
        icpVerdictReason: "long reason",
      },
      "Carvuk sells car-care subscriptions to consumers in Chile.",
    );
    expect(d).toContain("company: Carvuk");
    expect(d).toContain("title: Co-Founder & CTO");
    expect(d).toContain("eventTitle: Llama Lounge 26");
    expect(d).toContain("research: Carvuk sells");
    expect(d).not.toContain("n@carvuk.com");
    expect(d).not.toContain("luma.com");
    expect(d).not.toContain("linkedin");
    expect(d).not.toContain(A1);
  });
});

describe("followUpEdgeBlock", () => {
  it("is null with no angle and a labelled block with one", () => {
    expect(followUpEdgeBlock(null)).toBeNull();
    expect(followUpEdgeBlock("  ")).toBeNull();
    expect(followUpEdgeBlock(A2)).toContain("YOUR EDGE (a different angle from the first email");
    expect(followUpEdgeBlock(A2)).toContain(A2);
  });
});

describe("a play's input block (accelerator-batch through runEmailPlay)", () => {
  const base = {
    name: "Merlin",
    email: "m@rex.inc",
    company: "Rex",
    cohort: "yc-s26",
    productOneLiner: "scheduling for dental clinics",
  };

  it("an explicit rotation bypasses the selector and excludes other edges", async () => {
    await runAcceleratorBatch({
      dryRun: true,
      targets: [{ ...base, yourEdge: EDGE }],
      draftAngle: "the product is the playbook",
    });
    expect(calls.classifier).toHaveLength(0);
    expect(calls.writer[0]).toContain("YOUR EDGE: the product is the playbook");
    expect(calls.writer[0]).toContain("SELECTED ANGLE: the product is the playbook");
    expect(calls.writer[0]).not.toContain(A1);
    expect(calls.writer[0]).not.toContain(A2);
  });

  it("a one-angle edge reaches the prompt whole, with no classifier call", async () => {
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base, yourEdge: A1 }] });
    expect(calls.classifier).toHaveLength(0);
    expect(calls.writer[0]).toContain(`YOUR EDGE: ${A1}`);
  });

  it("a multi-angle edge reaches the prompt as exactly the chosen angle", async () => {
    classifierAnswer = { index: 2 };
    await runAcceleratorBatch({ dryRun: true, targets: [{ ...base, yourEdge: EDGE }] });
    expect(calls.classifier).toHaveLength(1);
    expect(calls.classifier[0]).toContain("productOneLiner: scheduling for dental clinics");
    const block = calls.writer[0] ?? "";
    expect(block).toContain(`YOUR EDGE: ${A2}`);
    expect(block).not.toContain(A1);
    expect(block).not.toContain(A3);
    expect(block).not.toContain("//");
  });
});

it("a play without an edge field still receives the selected argument", async () => {
  const { runEmailPlay } = await import("../src/_run-play.ts");
  await runEmailPlay(
    {
      playName: "show-hn",
      promptName: "show-hn-email",
      maxBodyWords: 100,
      toEmail: (t: { email: string }) => t.email,
      prospectMeta: () => ({ name: "Merlin", email: "m@rex.inc" }),
      prepare: async () => ({ receiptIds: [], dossier: "facts" }),
      buildInputBlock: () => "PROSPECT: a founder",
    },
    { dryRun: true, targets: [{ email: "m@rex.inc" }], draftAngle: "Grounded alternative" },
  );
  expect(calls.writer[0]).toContain("SELECTED ANGLE: Grounded alternative");
  expect(calls.classifier).toHaveLength(0);
});
it("the custom breakup runner receives the selected argument", async () => {
  const { runBreakupRevive } = await import("../src/breakup-revive.ts");
  await runBreakupRevive({
    dryRun: true,
    targets: [
      { name: "Merlin", email: "m@rex.inc", company: "Rex", daysCold: 75, lastEventAt: null },
    ],
    draftAngle: "Grounded alternative",
  });
  expect(calls.writer[0]).toContain("SELECTED ANGLE: Grounded alternative");
});
