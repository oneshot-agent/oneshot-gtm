import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reply gate: a reply must never re-introduce the founder, and must mirror
// the sender's length. Regression suite for the draft that answered a 20-word
// "most of it is vibe-coded" with a 110-word re-pitch that repeated the intro
// email's credentials line verbatim.

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "x",
      telemetryEnabled: false,
      founderName: "Mira",
      founderEmail: null,
      productOneLiner: "drop-in tracing",
      productDomain: null,
      sendingDomain: null,
      emailProvider: "oneshot",
      emailIdentities: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      // Both social-proof fields set: the reply must still not carry them.
      founderCredentials: "Built Cloudflare's experimentation platform.",
      productPortfolio: "Previously shipped a Zoom competitor to 500k MAU.",
      partners: "Google Cloud, LangChain",
      productBrief: null,
      mobileSignature: false,
      clientId: null,
    }),
  };
});

const completeMock = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, complete: completeMock };
});

// No prospect match => getPriorStepsForProspect is never reached, so the
// ledger stays out of this suite. Prior-email context arrives via threadSent.
const { draftInboxReply, replyWordBudget, repeatsPriorText } = await import("../src/reply.ts");

function draftReply(body: string) {
  return { content: JSON.stringify({ body }) };
}

function userBlocks(): string[] {
  const call = completeMock.mock.calls.at(-1)?.[0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return call.messages.filter((m) => m.role === "user").map((m) => m.content);
}

const BASE = { fromEmail: "rishi@gmail.com", subject: "Re: x", body: "tell me about payments" };

beforeEach(() => {
  completeMock.mockResolvedValue(draftReply("Short answer: yes, it settles per call."));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("replyWordBudget", () => {
  it("mirrors a one-line answer with a tight budget", () => {
    // The actual inbound that broke: 20 words.
    expect(
      replyWordBudget(
        "I did indeed reach but, to be honest most of it is vibe-coded. The project idea was given by AI itself.",
      ),
    ).toBe(45);
  });

  it("allows more room as the sender writes more", () => {
    expect(replyWordBudget(Array.from({ length: 60 }, () => "word").join(" "))).toBe(95);
    expect(replyWordBudget(Array.from({ length: 200 }, () => "word").join(" "))).toBe(135);
  });

  it("measures the new text only, not the quoted chain below it", () => {
    const body = [
      "ok.",
      "",
      "On Sat, Aug 29, 2026, J. Nicolas wrote:",
      ...Array.from({ length: 200 }, () => "> padding"),
    ].join("\n");
    expect(replyWordBudget(body)).toBe(45);
  });
});

describe("repeatsPriorText", () => {
  it("catches the credentials line lifted out of the intro email", () => {
    const intro =
      "I'm J. Nicolas, and i previously shipped a zoom competitor to 500k mau before starting oneshot.";
    const reply =
      "Fair point. I'm J. Nicolas, and i previously shipped a zoom competitor to 500k mau before building oneshot.";
    expect(repeatsPriorText(reply, [intro])).toBe(true);
  });

  it("ignores punctuation and case differences", () => {
    expect(
      repeatsPriorText("the agent just needs one set of credentials to access everything", [
        "The agent, just needs ONE set of credentials — to access everything!",
      ]),
    ).toBe(true);
  });

  it("passes a genuinely fresh reply", () => {
    const intro =
      "I'm J. Nicolas, and i previously shipped a zoom competitor to 500k mau before starting oneshot.";
    expect(repeatsPriorText("Makes sense. What broke first, auth or egress?", [intro])).toBe(false);
  });

  it("does not fire on a short draft or with no prior text", () => {
    expect(repeatsPriorText("Thanks.", ["Thanks."])).toBe(false);
    expect(repeatsPriorText("a much longer body than the ngram window needs here", [])).toBe(false);
  });
});

describe("draftInboxReply gate", () => {
  it("never puts a SOCIAL PROOF block in the reply prompt", async () => {
    await draftInboxReply(BASE);
    const block = userBlocks()[0]!;
    expect(block).not.toContain("SOCIAL PROOF");
    expect(block).not.toContain("CREDENTIALS:");
    expect(block).not.toContain("PORTFOLIO:");
    expect(block).not.toContain("PARTNERS:");
  });

  it("accepts a mirrored reply without a second LLM call", async () => {
    await draftInboxReply({ ...BASE, body: "did you hit that wall too?" });
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("repairs an over-long reply and keeps the rewrite", async () => {
    const bloated = Array.from({ length: 120 }, () => "pitch").join(" ");
    completeMock
      .mockResolvedValueOnce(draftReply(bloated))
      .mockResolvedValueOnce(draftReply("Yes, that's the wall. What broke first for you?"));

    const out = await draftInboxReply({ ...BASE, body: "did you hit that wall too?" });

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(out.body).toBe("Yes, that's the wall. What broke first for you?");
    // The corrective turn names the flag and the budget it has to hit.
    const repair = userBlocks().at(-1)!;
    expect(repair).toContain("body-too-long");
    expect(repair).toContain("under 45");
  });

  it("repairs a reply that repeats an email already in the thread", async () => {
    const intro = "I'm Mira, and i previously shipped a zoom competitor to 500k mau before this.";
    completeMock
      .mockResolvedValueOnce(draftReply(`Fair point. ${intro}`))
      .mockResolvedValueOnce(draftReply("Fair point. What broke first?"));

    const out = await draftInboxReply({
      ...BASE,
      body: "most of it is vibe-coded",
      threadSent: [{ body: intro, sentAt: "2026-08-28" }],
    });

    expect(out.body).toBe("Fair point. What broke first?");
    expect(userBlocks().at(-1)!).toContain("repeats-prior-email");
  });

  it("keeps the first draft when the repair is no cleaner", async () => {
    const bloated = Array.from({ length: 120 }, () => "pitch").join(" ");
    completeMock
      .mockResolvedValueOnce(draftReply(bloated))
      .mockResolvedValueOnce(draftReply(Array.from({ length: 200 }, () => "worse").join(" ")));

    const out = await draftInboxReply({ ...BASE, body: "did you hit that wall too?" });
    expect(out.body).toBe(bloated);
  });

  it("keeps the first draft when the repair call fails", async () => {
    const bloated = Array.from({ length: 120 }, () => "pitch").join(" ");
    completeMock
      .mockResolvedValueOnce(draftReply(bloated))
      .mockRejectedValueOnce(new Error("provider 503"));

    const out = await draftInboxReply({ ...BASE, body: "did you hit that wall too?" });
    expect(out.body).toBe(bloated);
  });

  it("still throws on an empty first draft", async () => {
    completeMock.mockResolvedValueOnce(draftReply("   "));
    await expect(draftInboxReply(BASE)).rejects.toThrow("empty reply draft");
  });
});
