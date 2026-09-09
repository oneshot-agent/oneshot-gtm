import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #586. A reasoning-mandatory OpenRouter model answers
// `reasoning: { enabled: false }` with a 400 — and, before this, the retry
// kept the caller's small max_tokens, so the model spent every token
// thinking and every draft came back truncated and empty. The retry must
// now carry the lowest effort AND a raised budget, and the model must be
// remembered so later calls skip the 400.

const cfg = vi.hoisted(() => ({
  provider: "openrouter" as const,
  model: "test-model",
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), llmProvider: cfg.provider, llmModel: cfg.model }),
  };
});

const { complete, MANDATORY_REASONING_ALLOWANCE_TOKENS, MANDATORY_REASONING_EFFORT } =
  await import("../src/client.ts");

const realFetch = global.fetch;

const okBody = {
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 40, completion_tokens: 12 },
};

function reasoningRejection() {
  return {
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: () =>
      Promise.resolve('{"error":{"message":"Reasoning cannot be disabled for this model"}}'),
  };
}
function okResponse() {
  return { ok: true, json: () => Promise.resolve(okBody) };
}

/** Rejects any request that tries to switch reasoning off; accepts the rest. */
function mandatoryModelFetch() {
  const fn = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { reasoning?: { enabled?: boolean } };
    if (body.reasoning?.enabled === false) return Promise.resolve(reasoningRejection());
    return Promise.resolve(okResponse());
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function bodyOf(fn: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const [, init] = fn.mock.calls[call] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  cfg.model = `mandatory-${Math.random().toString(36).slice(2)}`; // fresh: not yet remembered
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  global.fetch = realFetch;
});

describe("reasoning-mandatory models (issue #586)", () => {
  it("retries with the lowest effort AND a raised budget, not just without the switch", async () => {
    const fetchMock = mandatoryModelFetch();
    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 0)["reasoning"]).toEqual({ enabled: false });
    expect(bodyOf(fetchMock, 0)["max_tokens"]).toBe(500);

    const retry = bodyOf(fetchMock, 1);
    expect(retry["reasoning"]).toEqual({ effort: MANDATORY_REASONING_EFFORT });
    expect(retry["max_tokens"]).toBe(500 + MANDATORY_REASONING_ALLOWANCE_TOKENS);
  });

  it("remembers the model: the next call goes straight to the mandatory path", async () => {
    const fetchMock = mandatoryModelFetch();
    await complete({ messages: [{ role: "user", content: "one" }], maxTokens: 300 });
    await complete({ messages: [{ role: "user", content: "two" }], maxTokens: 300 });

    // 2 for the first call (400 + retry), exactly 1 for the second.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const second = bodyOf(fetchMock, 2);
    expect(second["reasoning"]).toEqual({ effort: MANDATORY_REASONING_EFFORT });
    expect(second["max_tokens"]).toBe(300 + MANDATORY_REASONING_ALLOWANCE_TOKENS);
  });

  it("a seeded family never pays for the 400", async () => {
    cfg.model = "google/gemini-3.8-flash";
    const fetchMock = mandatoryModelFetch();
    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const only = bodyOf(fetchMock, 0);
    expect(only["reasoning"]).toEqual({ effort: MANDATORY_REASONING_EFFORT });
    expect(only["max_tokens"]).toBe(500 + MANDATORY_REASONING_ALLOWANCE_TOKENS);
  });

  it("a model that rejects `effort` too still gets the raised budget", async () => {
    const fn = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { reasoning?: unknown };
      if (body.reasoning !== undefined) return Promise.resolve(reasoningRejection());
      return Promise.resolve(okResponse());
    });
    global.fetch = fn as unknown as typeof fetch;

    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });

    // enabled:false → 400, effort:low → 400, bare → 200.
    expect(fn).toHaveBeenCalledTimes(3);
    const bare = bodyOf(fn, 2);
    expect(bare["reasoning"]).toBeUndefined();
    expect(bare["max_tokens"]).toBe(500 + MANDATORY_REASONING_ALLOWANCE_TOKENS);
  });

  it("a truncation on the mandatory path reports the effective budget, never an empty draft", async () => {
    cfg.model = "google/gemini-3.8-flash";
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 2036,
            completion_tokens_details: { reasoning_tokens: 2030 },
          },
        }),
    });
    global.fetch = fn as unknown as typeof fetch;

    await expect(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 }),
    ).rejects.toThrow(
      `truncated at max_tokens=${500 + MANDATORY_REASONING_ALLOWANCE_TOKENS} (2030/2036 tokens were reasoning)`,
    );
  });
});
