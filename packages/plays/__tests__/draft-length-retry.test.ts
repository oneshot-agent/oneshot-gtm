import { beforeEach, describe, expect, it, vi } from "vitest";

// A draft that comes back over the play's body cap earns exactly one redraft
// with a tighter budget stated in the message; the shorter draft wins; a
// failed redraft returns the original. Motivated by kimi-k3/k2.6 writing
// ~135-160 words against a 150 cap where gemini wrote ~106 (2026-09-11).

const responses: string[] = [];
const calls: Array<Array<{ role: string; content: string }>> = [];
const events: Array<{ kind: string; ctx: Record<string, unknown> }> = [];

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
    logEvent: (kind: string, ctx: Record<string, unknown>) => {
      events.push({ kind, ctx });
    },
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "write an email",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      calls.push(input.messages.map((m) => ({ ...m })));
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      if (next === "THROW") throw new Error("provider down");
      return { content: next, provider: "t", model: "t" };
    },
  };
});

const { draftEmailFromPrompt, repairWritingLints, lintEmail, LENGTH_RETRY_RATIO } =
  await import("../src/_lib.ts");

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const json = (body: string): string => JSON.stringify({ subject: "subject", body });

beforeEach(() => {
  responses.length = 0;
  calls.length = 0;
  events.length = 0;
});

describe("draftEmailFromPrompt length retry", () => {
  it("makes no second call when the body is within the cap", async () => {
    responses.push(json(words(120)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(120);
    expect(calls).toHaveLength(1);
    expect(events.map((e) => e.kind)).not.toContain("email.draft.too_long_retry");
  });

  it("makes no second call at all when no cap is given (legacy callers)", async () => {
    responses.push(json(words(400)));
    await draftEmailFromPrompt({ promptName: "p", inputBlock: "x" });
    expect(calls).toHaveLength(1);
  });

  it("over the cap: one redraft asking for three quarters of it, in the same conversation", async () => {
    responses.push(json(words(163)), json(words(118)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(calls).toHaveLength(2);
    expect(d.body.split(" ")).toHaveLength(118);
    const second = calls[1]!;
    // The first draft is on the record as the assistant turn, then the ask.
    expect(second.at(-2)?.role).toBe("assistant");
    expect(second.at(-2)?.content).toContain("w162");
    const ask = second.at(-1)!;
    expect(ask.role).toBe("user");
    expect(ask.content).toContain("163 words");
    expect(ask.content).toContain(`at most ${Math.floor(150 * LENGTH_RETRY_RATIO)} words`);
    expect(ask.content).toMatch(/Cut whole sentences/);
    const ev = events.find((e) => e.kind === "email.draft.too_long_retry")!;
    expect(ev.ctx).toMatchObject({ words: 163, cap: 150, retry_words: 118, kept: "retry" });
  });

  it("keeps the shorter draft even when the redraft is still over the cap — lint decides", async () => {
    responses.push(json(words(170)), json(words(155)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(155);
    expect(calls).toHaveLength(2);
  });

  it("keeps the original when the redraft is not shorter", async () => {
    responses.push(json(words(160)), json(words(165)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(160);
    const ev = events.find((e) => e.kind === "email.draft.too_long_retry")!;
    expect(ev.ctx.kept).toBe("original");
  });

  it("a failed redraft returns the original draft, never throws", async () => {
    responses.push(json(words(160)), "THROW");
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(d.body.split(" ")).toHaveLength(160);
    expect(events.map((e) => e.kind)).toContain("email.draft.too_long_retry_failed");
  });

  it("never runs more than one redraft", async () => {
    responses.push(json(words(160)), json(words(158)), json(words(50)));
    const d = await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 150 });
    expect(calls).toHaveLength(2);
    expect(d.body.split(" ")).toHaveLength(158);
  });
});

describe("draftEmailFromPrompt sentence retry (brief first touch)", () => {
  const fourSentences = "One point here. A second point. A third one. And a fourth.";
  const threeSentences = "One point here. A second point. Worth a reply?";

  it("redrafts once when a sentence cap is set and exceeded, and keeps the shorter", async () => {
    responses.push(json(fourSentences), json(threeSentences));
    const out = await draftEmailFromPrompt({
      promptName: "p",
      inputBlock: "x",
      maxBodyWords: 70,
      maxBodySentences: 3,
    });
    expect(out.body).toBe(threeSentences);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at(-1)!.content).toContain("at most 3 sentences");
  });

  it("runs the sentence redraft even without a word cap", async () => {
    responses.push(json(fourSentences), json(threeSentences));
    const out = await draftEmailFromPrompt({
      promptName: "p",
      inputBlock: "x",
      maxBodySentences: 3,
    });
    expect(out.body).toBe(threeSentences);
    expect(calls[1]!.at(-1)!.content).toContain("at most 3 sentences.");
    expect(calls[1]!.at(-1)!.content).not.toContain("Infinity");
  });

  it("does not redraft on sentences when no sentence cap is set", async () => {
    responses.push(json(fourSentences));
    await draftEmailFromPrompt({ promptName: "p", inputBlock: "x", maxBodyWords: 70 });
    expect(calls).toHaveLength(1);
  });
});

describe("rule-of-three repair", () => {
  const held = "Ninjahire runs sourcing, outreach, and screening across multiple channels.";
  const repaired = "Ninjahire's recruiting workflows span multiple channels.";

  it("feeds the exact held wording back to the model and accepts a clean rewrite", async () => {
    responses.push(json(held), json(repaired));
    expect(
      await draftEmailFromPrompt({ promptName: "p", inputBlock: "facts", maxBodyWords: 110 }),
    ).toEqual({ subject: "subject", body: repaired });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.at(-2)?.content).toContain(held);
    expect(calls[1]?.at(-1)?.content).toContain("sourcing, outreach, and screening");
    expect(calls[1]?.at(-1)?.content).toContain("110 body words");
  });

  it("keeps the held draft when the model repeats the list, without looping", async () => {
    responses.push(json(held), json(held), json(repaired));
    expect((await draftEmailFromPrompt({ promptName: "p", inputBlock: "facts" })).body).toBe(held);
    expect(calls).toHaveLength(2);
  });

  it("keeps the original on a provider failure", async () => {
    responses.push(json(held), "THROW");
    expect((await draftEmailFromPrompt({ promptName: "p", inputBlock: "facts" })).body).toBe(held);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["word budget", words(111)],
    ["sentence budget", "One sentence. Another sentence. A third sentence."],
    ["new lint flag", "This is a groundbreaking workflow."],
  ])("rejects a repair that introduces a %s violation", async (_label, body) => {
    responses.push(json(held), json(body));
    expect(
      (
        await draftEmailFromPrompt({
          promptName: "p",
          inputBlock: "facts",
          maxBodyWords: 110,
          maxBodySentences: 2,
        })
      ).body,
    ).toBe(held);
  });

  it("rejects a changed subject", async () => {
    responses.push(json(held), JSON.stringify({ subject: "different subject", body: repaired }));
    expect((await draftEmailFromPrompt({ promptName: "p", inputBlock: "facts" })).body).toBe(held);
  });

  it("repairs a list introduced by the length retry", async () => {
    responses.push(json(words(160)), json(held), json(repaired));
    expect(
      (await draftEmailFromPrompt({ promptName: "p", inputBlock: "facts", maxBodyWords: 110 }))
        .body,
    ).toBe(repaired);
    expect(calls).toHaveLength(3);
  });
});

const messages = () => [
  { role: "user" as const, content: "Verified context. Keep the founder signature." },
];

describe("shared writing lint repair", () => {
  const clean = {
    subject: "workflow question",
    body: "Does your workflow send messages directly?",
  };

  it.each([
    ["banned-opener:I-noticed", "I noticed your product."],
    ["ai-vocab", "Your groundbreaking product is ready."],
    ["negative-parallelism", "It is not just speed, it's quality."],
    ["excess-exclamations", "Good news! It works!"],
    ["calendar-link", "Book at https://cal.com/example."],
    ["public-record-leverage", "Your license expired."],
  ])("repairs %s with its actual lint feedback", async (flag, body) => {
    responses.push(JSON.stringify(clean));
    const fixed = await repairWritingLints(messages(), { ...clean, body }, { promptName: "p" });
    expect(fixed).toEqual(clean);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.at(-1)?.content).toContain(flag);
    expect(calls[0]?.[0]?.content).toContain("Verified context");
  });

  it("repairs all writing failures in one request", async () => {
    responses.push(JSON.stringify(clean));
    const fixed = await repairWritingLints(
      messages(),
      { ...clean, body: "I noticed your groundbreaking sourcing, outreach, and screening." },
      { promptName: "p" },
    );
    expect(fixed).toEqual(clean);
    for (const flag of ["banned-opener:I-noticed", "ai-vocab", "rule-of-three"])
      expect(calls[0]?.at(-1)?.content).toContain(flag);
    expect(calls).toHaveLength(1);
  });

  it.each(["subject-too-long", "subject-shouty"])(
    "allows changing the subject when %s requires it",
    async (flag) => {
      responses.push(JSON.stringify(clean));
      const subject = flag === "subject-too-long" ? "a".repeat(61) : "WORKFLOW QUESTION";
      expect(
        await repairWritingLints(messages(), { ...clean, subject }, { promptName: "p" }),
      ).toEqual(clean);
    },
  );

  it("enforces play-specific hard bans only when opted in", async () => {
    const draft = { ...clean, body: "Try https://example.test for a $10 discount." };
    expect(await repairWritingLints(messages(), draft, { promptName: "p" })).toEqual(draft);
    expect(calls).toHaveLength(0);
    responses.push(JSON.stringify(clean));
    expect(
      await repairWritingLints(messages(), draft, { promptName: "p", hardBans: true }),
    ).toEqual(clean);
    for (const flag of ["hard-ban:link", "hard-ban:price", "hard-ban:discount-offer"])
      expect(calls[0]?.at(-1)?.content).toContain(flag);
  });

  it("does not use rewriting to clear operational or research holds", async () => {
    const holds = [
      "already-contacted",
      "off-icp",
      "enrichment-failed",
      "missing-identity",
      "send-limit",
      "unknown-future-flag",
    ];
    expect(
      await repairWritingLints(messages(), clean, { promptName: "p", extraLint: () => holds }),
    ).toEqual(clean);
    expect(calls).toHaveLength(0);
  });

  it("rechecks custom guards and rejects a newly introduced hold", async () => {
    const draft = { ...clean, body: "I noticed your workflow." };
    responses.push(JSON.stringify(clean));
    expect(
      await repairWritingLints(messages(), draft, {
        promptName: "p",
        extraLint: (d) => (d.body === clean.body ? ["unsupported-claim"] : []),
      }),
    ).toEqual(draft);
    expect(calls).toHaveLength(1);
  });

  it("preserves operational holds alongside a successful wording repair", async () => {
    responses.push(JSON.stringify(clean));
    const check = vi.fn(() => ["already-contacted"]);
    const fixed = await repairWritingLints(
      messages(),
      { ...clean, body: "I noticed your workflow." },
      { promptName: "p", extraLint: check },
    );
    expect(fixed).toEqual(clean);
    expect(check).toHaveBeenCalledTimes(2);
    expect(calls[0]?.at(-1)?.content).not.toContain("already-contacted");
  });

  it("repairs follow-up question and length constraints together", async () => {
    responses.push(JSON.stringify(clean));
    const fixed = await repairWritingLints(
      messages(),
      { ...clean, body: `${words(40)}. Would you prefer a call or an email?` },
      { promptName: "p", followUp: true, maxBodyWords: 30 },
    );
    expect(fixed).toEqual(clean);
    expect(calls[0]?.at(-1)?.content).toContain("either-or-question");
    expect(calls[0]?.at(-1)?.content).toContain("body-too-long");
    expect(lintEmail(fixed.subject, fixed.body, 30, undefined, { followUp: true })).toEqual([]);
  });

  it("rejects repairs that reintroduce a passed demo day", async () => {
    const draft = { ...clean, body: "I noticed your workflow." };
    responses.push(JSON.stringify({ ...clean, body: "Ready for demo day?" }));
    expect(
      await repairWritingLints(messages(), draft, {
        promptName: "p",
        demoDay: { month: "March 2026", isoMonth: "2026-03", status: "passed", monthsAway: 6 },
      }),
    ).toEqual(draft);
  });

  it("leaves an invalid repair held after the bounded JSON retry", async () => {
    const draft = { ...clean, body: "I noticed your workflow." };
    responses.push("invalid", "invalid");
    expect(await repairWritingLints(messages(), draft, { promptName: "p" })).toEqual(draft);
    expect(calls).toHaveLength(2);
  });
});
