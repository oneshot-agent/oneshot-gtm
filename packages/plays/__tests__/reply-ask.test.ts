import { beforeEach, describe, expect, it, vi } from "vitest";
const complete = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
const { generateReplyOptions } = await import("../src/reply-options.ts");
const { buildDraftSystemPrompt, parseAsk, parseDraftResponse, repairInstruction, emptyFlags } =
  await import("../src/reply-options-rules.ts");

// The reply writer's read, as data: the composer captures a how-it-works
// question the brief does not answer, so the ask must parse strictly and a
// missing or garbled one must never break the drafts.

const options = {
  read: "They ask how retries behave; the brief names retries but not how they work.",
  direct: "Retries are built in. The exact backoff is one I'd confirm rather than guess.",
  technical: "Each call is retried on failure; I'd check the timing detail before saying more.",
  warm: "Good question. What do you need retries to do in your setup?",
  moves: { direct: "answer", technical: "check", warm: "ask" },
};

describe("parseAsk", () => {
  it("reads a mechanism question the brief does not answer", () => {
    expect(
      parseAsk({
        level: "Mechanism",
        question: "  How are   failed calls retried? ",
        briefAnswers: false,
      }),
    ).toEqual({ level: "mechanism", question: "How are failed calls retried?", briefAnswers: false });
  });

  it("keeps a null level and drops the question with it", () => {
    expect(parseAsk({ level: null, question: "thanks!", briefAnswers: false })).toEqual({
      level: null,
      question: null,
      briefAnswers: false,
    });
  });

  it("is undefined when the shape does not hold together", () => {
    expect(parseAsk(undefined)).toBeUndefined();
    expect(parseAsk("mechanism")).toBeUndefined();
    expect(parseAsk([])).toBeUndefined();
    expect(parseAsk({ level: "architecture", question: "x", briefAnswers: false })).toBeUndefined();
    expect(parseAsk({ level: "mechanism", question: "x" })).toBeUndefined();
    expect(parseAsk({ level: "mechanism", question: "x", briefAnswers: "no" })).toBeUndefined();
    expect(parseAsk({ level: "mechanism", question: 7, briefAnswers: false })).toBeUndefined();
  });

  it("caps a runaway question", () => {
    const ask = parseAsk({ level: "mechanism", question: "a".repeat(2000), briefAnswers: false });
    expect(ask?.question).toHaveLength(500);
  });
});

describe("parseDraftResponse", () => {
  it("carries the ask beside read, moves and the three options", () => {
    const parsed = parseDraftResponse(
      JSON.stringify({
        ...options,
        ask: { level: "mechanism", question: "How are failed calls retried?", briefAnswers: false },
      }),
    );
    expect(parsed.read).toBe(options.read);
    expect(parsed.drafts.direct).toContain("Retries are built in");
    expect(parsed.ask).toEqual({
      level: "mechanism",
      question: "How are failed calls retried?",
      briefAnswers: false,
    });
  });

  it("leaves ask out when the model did not write one, and keeps the drafts", () => {
    const parsed = parseDraftResponse(JSON.stringify(options));
    expect(parsed.ask).toBeUndefined();
    expect("ask" in parsed).toBe(false);
    expect(parsed.drafts.warm).toContain("What do you need");
    const garbled = parseDraftResponse(JSON.stringify({ ...options, ask: "mechanism, not covered" }));
    expect(garbled.ask).toBeUndefined();
    expect(garbled.moves).toEqual(options.moves);
  });
});

describe("prompt", () => {
  it("asks for the structured read in the JSON and keeps it through a repair turn", () => {
    for (const channel of ["email", "linkedin"] as const) {
      const prompt = buildDraftSystemPrompt(channel);
      expect(prompt).toContain('"ask":{"level":"capability"|"mechanism"|null');
      expect(prompt).toContain("briefAnswers: true only when PRODUCT BRIEF answers it");
    }
    expect(repairInstruction(emptyFlags())).toContain("including read, ask and moves");
  });
});

describe("generateReplyOptions", () => {
  beforeEach(() => complete.mockReset());
  const input = {
    channel: "email" as const,
    founder: "Founder",
    founderCalendarUrl: "",
    primaryWorkspace: "test",
    primaryProduct: "Tools",
    primaryBrief: "Tools with retries.",
    secondaryProducts: [],
    prospect: { name: "Ada", company: "", title: "", profileUrl: "" },
    dossier: "",
    priorOutreach: [],
    thread: [
      {
        direction: "inbound" as const,
        body: "How are failed calls retried?",
        at: "2026-09-17T12:00:00Z",
      },
    ],
    casualTexture: false,
  };
  const ask = { level: "mechanism", question: "How are failed calls retried?", briefAnswers: false };

  it("returns the ask with the options", async () => {
    complete.mockResolvedValue({ content: JSON.stringify({ ...options, ask }) });
    const result = await generateReplyOptions(input);
    expect(result.ask).toEqual(ask);
  });

  it("keeps the first ask when the repaired set drops it", async () => {
    complete
      .mockResolvedValueOnce({
        content: JSON.stringify({
          ...options,
          ask,
          moves: { direct: "answer", technical: "answer", warm: "answer" },
        }),
      })
      .mockResolvedValueOnce({ content: JSON.stringify(options) });
    const result = await generateReplyOptions(input);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.moves).toEqual(options.moves);
    expect(result.ask).toEqual(ask);
  });
});
