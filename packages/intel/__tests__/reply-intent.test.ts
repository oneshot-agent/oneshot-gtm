import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { REPLY_INTENTS } from "@oneshot-gtm/shared-types";

// The LLM fallback is the seam on one side, fetch on the other: no network.
const triageMock = vi.fn();
vi.mock("../src/triage.ts", () => ({ triageEmails: triageMock }));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: vi.fn() };
});

const { classifyReplyIntent, replyIntentCriteria } = await import("../src/reply-intent.ts");

const email = {
  id: "e1",
  from: "p@example.com",
  subject: "Re: hi",
  received_at: "2026-09-30T10:00:00.000Z",
  body: "Can we talk next week?",
};

function cfg(rc?: OneShotConfig["replyClassifier"]): OneShotConfig {
  return { llmModel: "test/llm", ...(rc ? { replyClassifier: rc } : {}) } as OneShotConfig;
}
const DECISIONS = cfg({ engine: "decisions", model: "test/decisions-model" });

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function decisionsBody(choice: string, confidence = 0.84, probs?: Record<string, number>) {
  return {
    id: "gen-dec-1",
    model: "test/decisions-model-20260917",
    provider: "Test",
    answers: {
      intent: {
        type: "choice",
        choice,
        confidence,
        probabilities: probs ?? { [choice]: confidence, other: 1 - confidence },
      },
    },
    usage: { input_tokens: 400, output_tokens: 10, cost: 0.000019992 },
  };
}

beforeEach(() => {
  process.env["OPENROUTER_API_KEY"] = "test-key";
  triageMock.mockReset();
  triageMock.mockResolvedValue([
    {
      id: "e1",
      from: "",
      subject: "",
      category: "question",
      nextStep: "answer_question",
      draftedReply: "",
      reasoning: "asked a question",
    },
  ]);
});

afterEach(() => {
  delete process.env["OPENROUTER_API_KEY"];
});

describe("classifyReplyIntent: decisions engine", () => {
  it("sends one choice question whose criteria are exactly the shared table's descriptions", async () => {
    const fetchImpl = vi.fn(async () => okResponse(decisionsBody("meeting")));
    await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/alpha/decisions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("test/decisions-model");
    expect(body.questions.intent.type).toBe("choice");
    expect(body.questions.intent.criteria).toEqual(
      Object.fromEntries(REPLY_INTENTS.map((i) => [i.label, i.description])),
    );
    expect(body.questions.intent.criteria).toEqual(replyIntentCriteria());
    expect(body.state).toContain("Can we talk next week?");
  });

  it("maps the answer: label, confidence, probabilities, model id, cost in micros", async () => {
    const fetchImpl = vi.fn(async () => okResponse(decisionsBody("meeting", 0.84)));
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(r).toMatchObject({
      intent: "meeting",
      confidence: 0.84,
      classifier: "decisions:test/decisions-model-20260917",
      costMicros: 20,
      review: false,
      fellBack: false,
    });
    expect(r.probabilities).toMatchObject({ meeting: 0.84 });
    expect(triageMock).not.toHaveBeenCalled();
  });

  it("flags a label under minConfidence for review, but still stores it", async () => {
    const fetchImpl = vi.fn(async () => okResponse(decisionsBody("interested", 0.38)));
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(r.intent).toBe("interested");
    expect(r.review).toBe(true);

    const strict = cfg({ engine: "decisions", model: "m", minConfidence: 0.9 });
    const r2 = await classifyReplyIntent(email, {
      cfg: strict,
      fetchImpl: vi.fn(async () => okResponse(decisionsBody("interested", 0.84))) as never,
    });
    expect(r2.review).toBe(true);
  });

  it("falls back to the llm engine on an out-of-set label", async () => {
    const fetchImpl = vi.fn(async () => okResponse(decisionsBody("definitely_positive_vibes")));
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(r).toMatchObject({ intent: "question", fellBack: true, classifier: "llm:test/llm" });
  });

  it("falls back to the llm engine on a non-2xx (after retrying a 5xx once)", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.fellBack).toBe(true);
    expect(r.intent).toBe("question");
  });

  it("does not retry a 4xx, and falls back", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.fellBack).toBe(true);
  });

  it("falls back on a timeout / transport error", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(r.fellBack).toBe(true);
  });

  it("falls back on a malformed body", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ nothing: true }));
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(r.fellBack).toBe(true);
  });

  it("falls back without calling out when there is no OpenRouter key", async () => {
    delete process.env["OPENROUTER_API_KEY"];
    const fetchImpl = vi.fn();
    const r = await classifyReplyIntent(email, { cfg: DECISIONS, fetchImpl: fetchImpl as never });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toMatchObject({ intent: "question", fellBack: true });
  });

  it("falls back without calling out when no model is configured", async () => {
    const fetchImpl = vi.fn();
    const r = await classifyReplyIntent(email, {
      cfg: cfg({ engine: "decisions" }),
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.fellBack).toBe(true);
  });
});

describe("classifyReplyIntent: llm engine", () => {
  it("is the default and never calls the decisions API", async () => {
    const fetchImpl = vi.fn();
    const r = await classifyReplyIntent(email, { cfg: cfg(), fetchImpl: fetchImpl as never });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      intent: "question",
      reason: "asked a question",
      confidence: null,
      review: false,
      fellBack: false,
      classifier: "llm:test/llm",
    });
  });

  it("throws when the triage returns no label, so the caller releases its claim", async () => {
    triageMock.mockResolvedValue([]);
    await expect(classifyReplyIntent(email, { cfg: cfg() })).rejects.toThrow(/no label/);
  });
});
