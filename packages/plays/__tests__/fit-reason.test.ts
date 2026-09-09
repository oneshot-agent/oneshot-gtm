import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #592: the generator is a single small isolated call that never
// throws, never runs without an ICP, and never feeds identifiers to the model.

let icpOneLiner: string | null = "technical founders selling B2B software";
const completeMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), icpOneLiner }),
    logEvent: vi.fn(),
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, loadPrompt: () => "system", complete: completeMock };
});

const { generateFitReason, normalizeFitReason } = await import("../src/_fit-reason.ts");

beforeEach(() => {
  icpOneLiner = "technical founders selling B2B software";
  completeMock.mockReset();
  completeMock.mockResolvedValue({
    content: JSON.stringify({ fitReason: " Sells document AI to legal teams. " }),
    provider: "t",
    model: "t",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("normalizeFitReason", () => {
  it("trims, collapses whitespace, strips wrapping quotes, caps length", () => {
    expect(normalizeFitReason('  "Sells   AI to clinics."  ')).toBe("Sells AI to clinics.");
    expect(normalizeFitReason("")).toBeNull();
    expect(normalizeFitReason(null)).toBeNull();
    expect(normalizeFitReason(12)).toBeNull();
    const long = normalizeFitReason("word ".repeat(100))!;
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith("…")).toBe(true);
  });

  it("drops the gates' canned non-reasons and unwraps the stage-C prefix", () => {
    expect(normalizeFitReason("fill-the-gap enrichment returned no title")).toBeNull();
    expect(normalizeFitReason("fill-the-gap enrichment failed")).toBeNull();
    expect(
      normalizeFitReason("product research unavailable: no product research signal found"),
    ).toBeNull();
    expect(normalizeFitReason("no ICP set; pass-through")).toBeNull();
    expect(normalizeFitReason("No role text available")).toBeNull();
    expect(normalizeFitReason("classifier unavailable pre-spend; deferred")).toBeNull();
    expect(normalizeFitReason("unclear-after-enrich: Runs a dental practice in Austin.")).toBe(
      "Runs a dental practice in Austin.",
    );
  });
});

describe("generateFitReason", () => {
  it("returns the model's sentence, normalized", async () => {
    const out = await generateFitReason({
      icp: null,
      playName: "gov-solicitation",
      payload: { company: "Acme", title: "Contracting officer" },
    });
    expect(out).toBe("Sells document AI to legal teams.");
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("makes no call when no ICP is configured", async () => {
    icpOneLiner = null;
    expect(await generateFitReason({ icp: null, playName: "x", payload: {} })).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("feeds the prospect's evidence but never identifiers or its own summary", async () => {
    await generateFitReason({
      icp: "founders",
      playName: "luma-events",
      payload: {
        name: "Nico",
        email: "n@carvuk.com",
        linkedinUrl: "https://linkedin.com/in/n",
        company: "Carvuk",
        title: "CTO",
        fitReason: "old sentence",
        fitReasonSource: "notes",
        address: "12 Main St",
      },
      dossier: "Carvuk sells car care to consumers.",
    });
    const user = (completeMock.mock.calls[0]![0] as { messages: Array<{ content: string }> })
      .messages[1]!.content;
    expect(user).toContain("company: Carvuk");
    expect(user).toContain("title: CTO");
    expect(user).toContain("research: Carvuk sells");
    expect(user).not.toContain("n@carvuk.com");
    expect(user).not.toContain("linkedin");
    expect(user).not.toContain("old sentence");
    expect(user).not.toContain("12 Main St");
  });

  it("swallows an unusable answer or a provider failure into null", async () => {
    completeMock.mockResolvedValueOnce({ content: "not json", provider: "t", model: "t" });
    expect(await generateFitReason({ icp: "founders", playName: "x", payload: {} })).toBeNull();
    completeMock.mockRejectedValueOnce(new Error("boom"));
    expect(await generateFitReason({ icp: "founders", playName: "x", payload: {} })).toBeNull();
  });
});
