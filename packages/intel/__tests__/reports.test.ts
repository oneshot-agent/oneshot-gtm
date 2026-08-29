import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The report modules read the founder config and the ledger, then hand the
// model's answer to a parser. Config + ledger are stubbed so the aggregates are
// fixed; the model's answer is a mocked fetch, so nothing here touches the
// network or needs an API key.
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      llmProvider: "openrouter" as const,
      llmModel: "test-model",
      founderName: "Nic",
      productOneLiner: "GTM agent for founders",
    }),
    getLedger: () => ({
      listReceipts: () => [
        { play_name: "github-stars" },
        { play_name: "github-stars" },
        { play_name: "luma" },
      ],
      totalSpendUsd: () => 12.5,
      countSends: () => 42,
      spendByPlay: () => [{ play_name: "github-stars", calls: 3, total_usd: 6.25 }],
      eventsByPlay: () => [
        { play_name: "github-stars", sent: 10, delivered: 9, replied: 2, bounced: 0 },
      ],
    }),
  };
});

const { triageEmails } = await import("../src/triage.ts");
const { synthesizeInterviews } = await import("../src/synthesize.ts");
const { adviseOnce } = await import("../src/advise.ts");
const { weeklyReview } = await import("../src/weekly-review.ts");

const realFetch = global.fetch;

/** One mocked OpenRouter-shaped 2xx. Every failure below is terminal, so a
 * single response is enough — no retries, no timers, no flake. */
function respondWith(content: string | null, finishReason = "stop") {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 100, completion_tokens: 200 },
      }),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function respondWithBody(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function sentMessages(fn: ReturnType<typeof respondWith>): Array<{
  role: string;
  content: string;
}> {
  const [, init] = fn.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string).messages;
}

const EMAILS = [
  {
    id: "m1",
    from: "dana@acme.test",
    subject: "Re: your note",
    received_at: "2026-08-28T09:00:00Z",
    body: "Sounds interesting, can you send pricing?",
  },
  {
    id: "m2",
    from: "postmaster@acme.test",
    subject: "Out of office",
    received_at: "2026-08-28T10:00:00Z",
    body: "I am away until Monday.",
  },
];

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  global.fetch = realFetch;
});

describe("triageEmails", () => {
  it("maps a well-formed fenced array onto the source emails", async () => {
    respondWith(
      [
        "```json",
        JSON.stringify([
          {
            id: "m1",
            category: "question",
            next_step: "send_pricing",
            drafted_reply: "  Happy to — here's the pricing.  ",
            reasoning: " asked for pricing ",
          },
          { id: "m2", category: "auto_reply", next_step: "ignore" },
        ]),
        "```",
      ].join("\n"),
    );

    const out = await triageEmails(EMAILS);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "m1",
      // from/subject come from the local email, never from the model.
      from: "dana@acme.test",
      subject: "Re: your note",
      category: "question",
      nextStep: "send_pricing",
      draftedReply: "Happy to — here's the pricing.",
      reasoning: "asked for pricing",
    });
    // Absent optional fields fall back rather than landing as "undefined".
    expect(out[1]).toMatchObject({
      id: "m2",
      category: "auto_reply",
      draftedReply: "",
      reasoning: "",
    });
  });

  it("returns no triage at all when the model answers with prose", async () => {
    respondWith("I wasn't able to categorise these — could you resend them?");

    // Fallback, not a throw: an unparseable batch yields zero triaged replies,
    // so nothing downstream acts on a hallucinated category.
    await expect(triageEmails(EMAILS)).resolves.toEqual([]);
  });

  it("drops hallucinated ids and defaults missing fields on a partly-malformed array", async () => {
    respondWith(
      JSON.stringify([
        { id: "not-an-email-we-sent", category: "interested" },
        "a bare string where an object belongs",
        { id: "m1" },
      ]),
    );

    const out = await triageEmails(EMAILS);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "m1",
      category: "other",
      nextStep: "manual_review",
    });
  });

  it("returns [] when the model answers with a JSON object instead of an array", async () => {
    respondWith(JSON.stringify({ triaged: [{ id: "m1", category: "interested" }] }));

    await expect(triageEmails(EMAILS)).resolves.toEqual([]);
  });

  it("never calls the model for an empty inbox", async () => {
    const fetchMock = respondWith("[]");

    await expect(triageEmails([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("synthesizeInterviews", () => {
  it("maps a well-formed fenced object and keeps the raw text", async () => {
    const raw = [
      "```json",
      JSON.stringify({
        jtbd: ["ship outbound without a BDR"],
        pain_quotes: ["I spend Sundays writing emails"],
        switch_moment: "when the founder-led list ran dry",
        icp_language: ["technical founder", "seed stage"],
      }),
      "```",
    ].join("\n");
    respondWith(raw);

    const out = await synthesizeInterviews("transcript text");

    expect(out.jtbd).toEqual(["ship outbound without a BDR"]);
    expect(out.painQuotes).toEqual(["I spend Sundays writing emails"]);
    expect(out.switchMoment).toBe("when the founder-led list ran dry");
    expect(out.icpLanguage).toEqual(["technical founder", "seed stage"]);
    // raw is the model text verbatim, fences included — it is the audit trail.
    expect(out.raw).toBe(raw);
  });

  it("falls back to an empty synthesis when the model answers with prose", async () => {
    respondWith("Here are my thoughts: the interviews were quite varied.");

    const out = await synthesizeInterviews("transcript text");

    expect(out).toEqual({
      jtbd: [],
      painQuotes: [],
      switchMoment: null,
      icpLanguage: [],
      raw: "Here are my thoughts: the interviews were quite varied.",
    });
  });

  it("drops wrongly-typed fields instead of leaking them to callers", async () => {
    respondWith(
      JSON.stringify({
        jtbd: "one string, not a list",
        pain_quotes: ["kept", 42, null, { q: "dropped" }],
        switch_moment: 1234,
        icp_language: null,
      }),
    );

    const out = await synthesizeInterviews("transcript text");

    expect(out.jtbd).toEqual([]);
    expect(out.painQuotes).toEqual(["kept"]);
    expect(out.switchMoment).toBeNull();
    expect(out.icpLanguage).toEqual([]);
  });

  it("caps the transcript it sends at 60k chars", async () => {
    const fetchMock = respondWith("{}");

    await synthesizeInterviews("x".repeat(70_000));

    const user = sentMessages(fetchMock).find((m) => m.role === "user");
    expect(user?.content).toHaveLength(60_000);
  });
});

describe("adviseOnce", () => {
  it("answers a first turn with ledger context and the cited principles", async () => {
    const fetchMock = respondWith(
      "Given your spend, tighten the ICP first. [PICK ONE CHANNEL] then [PICK ONE CHANNEL] again, and [SHIP DAILY].",
    );

    const out = await adviseOnce({ question: "What should I do next?" });

    expect(out.answer).toContain("tighten the ICP first");
    // Deduped, in first-seen order.
    expect(out.citedPrinciples).toEqual(["PICK ONE CHANNEL", "SHIP DAILY"]);
    expect(out.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out.history[1]?.content).toBe(out.answer);

    // The first turn carries a fresh ledger block built from the stub above.
    const user = sentMessages(fetchMock).find((m) => m.role === "user");
    expect(user?.content).toContain("FOUNDER: Nic");
    expect(user?.content).toContain("Total spend (signed receipts): $12.50");
    expect(user?.content).toContain("Agent calls: 3");
    expect(user?.content).toContain("github-stars=2, luma=1");
    expect(user?.content).toContain("QUESTION: What should I do next?");
  });

  it("keeps a truncated answer instead of throwing — advise opts into truncation", async () => {
    respondWith("Start with the top 20 accounts and", "length");

    const out = await adviseOnce({ question: "Where do I start?" });

    // allowTruncation is set on this call site, so a cut-off reply reaches the
    // founder rather than blowing up mid-session.
    expect(out.answer).toBe("Start with the top 20 accounts and");
    expect(out.citedPrinciples).toEqual([]);
    expect(out.history).toHaveLength(2);
  });

  it("propagates a content-less provider answer as an error", async () => {
    const fetchMock = respondWith(null, "content_filter");

    // No text at all is a provider signal, not a parseable answer: adviseOnce
    // must surface it rather than return an empty string as advice.
    await expect(adviseOnce({ question: "?" })).rejects.toThrow(/no text content/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("weeklyReview", () => {
  it("returns the trimmed markdown alongside ledger-derived aggregates", async () => {
    const fetchMock = respondWith("\n## Week of 2026-08-29\n\nReply rate held at 20%.\n\n");

    const out = await weeklyReview("we paused the luma play");

    expect(out.markdown).toBe("## Week of 2026-08-29\n\nReply rate held at 20%.");
    expect(out.totalSpend).toBe(6.25);
    expect(out.totalCalls).toBe(3);
    expect(out.totalSent).toBe(10);
    expect(out.totalReplied).toBe(2);

    const user = sentMessages(fetchMock).find((m) => m.role === "user");
    expect(user?.content).toContain("- Total spend: $6.25");
    expect(user?.content).toContain("- Reply rate: 20.0%");
    expect(user?.content).toContain("- github-stars: 3 calls, $6.25 spent, 10 sent, 2 replied");
    expect(user?.content).toContain("FOUNDER CONTEXT:\nwe paused the luma play");
  });

  it("still reports the real numbers when the model returns nothing usable", async () => {
    respondWith("   \n  \n");

    const out = await weeklyReview();

    // The aggregates come from the ledger, not the model — a blank narrative
    // must not zero them out or throw.
    expect(out.markdown).toBe("");
    expect(out.totalSpend).toBe(6.25);
    expect(out.totalSent).toBe(10);
    expect(out.totalReplied).toBe(2);
  });

  it("propagates a choice-less provider answer as an error", async () => {
    const fetchMock = respondWithBody({ choices: [] });

    await expect(weeklyReview()).rejects.toThrow(/no choices/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
