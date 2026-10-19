import { describe, expect, it, vi } from "vitest";
import { callDecisions, topDecisionLabels } from "../src/decisions.ts";

// The shared decisions client: several named questions over one state in
// one request, answers keyed by question. Any answer outside its labels is
// a failure the caller falls back on. No network: fetch is injected.

const criteria = { yes: "it is", no: "it is not" };
const questions = {
  first: { type: "choice" as const, instructions: "Is the first one?", criteria },
  second: { type: "choice" as const, instructions: "Is the second one?", criteria },
};

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("callDecisions", () => {
  it("asks every question in one request and maps each answer", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        model: "test/model-20261001",
        answers: {
          first: { choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } },
          second: { choice: "no", confidence: "high", probabilities: { no: 0.7, yes: "x" } },
        },
        usage: { cost: 0.002 },
      }),
    );
    const out = await callDecisions({
      model: "test/model",
      key: "k",
      questions,
      state: "the state",
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "test/model",
      questions,
      state: "the state",
    });
    expect(out).toEqual({
      answers: {
        first: { choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } },
        second: { choice: "no", confidence: null, probabilities: { no: 0.7 } },
      },
      costUsd: 0.002,
      model: "test/model-20261001",
    });
  });

  it("fails when any answer is missing or outside its labels, naming the question", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ answers: { first: { choice: "yes" }, second: { choice: "maybe" } } }),
    );
    await expect(
      callDecisions({ model: "m", key: "k", questions, state: "s", fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/no known label for second \(got "maybe"\)/);
  });

  it("does not retry a 4xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(
      callDecisions({ model: "m", key: "k", questions, state: "s", fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("topDecisionLabels", () => {
  it("lists the top labels by probability", () => {
    expect(topDecisionLabels({ a: 0.1, b: 0.7, c: 0.2 }, 2)).toBe("b 0.70, c 0.20");
    expect(topDecisionLabels(null)).toBe("");
  });
});
