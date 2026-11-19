import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `llmReasoningEffort`: a workspace's reasoning effort on OpenRouter. Unset
// must send exactly what was sent before the setting existed.

const state = vi.hoisted(() => ({ cfg: {} as Record<string, unknown> }));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...state.cfg }),
    logEvent: () => {},
  };
});

const {
  complete,
  LlmTruncatedError,
  MANDATORY_REASONING_ALLOWANCE_TOKENS,
  REASONING_ALLOWANCE_TOKENS,
  REASONING_RETRY_MAX_TOKENS,
  _resetLlmBreakerForTests,
} = await import("../src/client.ts");

const realFetch = global.fetch;
const msgs = [{ role: "user" as const, content: "hi" }];
const OR = "https://openrouter.ai/api/v1/chat/completions";
const SEEDED = "google/gemini-3.8-flash";

type Body = Record<string, unknown> & { reasoning?: { enabled?: boolean; effort?: string } };

function ok(text = '{"ok":true}') {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
  };
}
function okCost(cost: number) {
  return () =>
    Promise.resolve({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost },
    });
}
function claudeOk() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () =>
      Promise.resolve({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
  };
}
function rejection(status: number, message: string) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify({ error: { message } })),
  };
}

/** A reply cut off at the request's max_tokens, `reasoning` of it spent reasoning. */
function cutOff(body: Body, reasoning: number, cost?: number) {
  const max = body["max_tokens"] as number;
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: {
          completion_tokens: max,
          completion_tokens_details: { reasoning_tokens: reasoning },
          ...(cost === undefined ? {} : { cost }),
        },
      }),
  };
}

/** `answer` decides each request from its URL and body; every request is recorded. */
function stubFetch(answer: (url: string, body: Body) => unknown) {
  const fn = vi.fn().mockImplementation((url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Body;
    return Promise.resolve(answer(url, body));
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}
function sent(fn: ReturnType<typeof vi.fn>, i: number): { url: string; body: Body } {
  const [url, init] = fn.mock.calls[i] as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string) as Body };
}
/** Refuses switching reasoning off, the way a reasoning-mandatory model does. */
const mandatory = (_url: string, body: Body) =>
  body.reasoning?.enabled === false
    ? rejection(400, "Reasoning is mandatory for this endpoint and cannot be disabled")
    : ok();

let fresh = "";
beforeEach(() => {
  fresh = `vendor/model-${Math.random().toString(36).slice(2)}`;
  state.cfg = { llmProvider: "openrouter", llmModel: fresh, llmFallback: null };
  _resetLlmBreakerForTests();
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
});
afterEach(() => {
  global.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("llmReasoningEffort unset", () => {
  it("a model that allows it has reasoning switched off, on the caller's budget", async () => {
    const fn = stubFetch(() => ok());
    await complete({ messages: msgs, maxTokens: 500, temperature: 0.2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn, 0).body).toEqual({
      model: fresh,
      messages: expect.any(Array),
      temperature: 0.2,
      max_tokens: 500,
      reasoning: { enabled: false },
    });
  });

  it("a mandatory model gets low effort and the low allowance", async () => {
    state.cfg["llmModel"] = SEEDED;
    const fn = stubFetch(mandatory);
    await complete({ messages: msgs, maxTokens: 500, temperature: 0.2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn, 0).body).toEqual({
      model: SEEDED,
      messages: expect.any(Array),
      temperature: 0.2,
      max_tokens: 500 + MANDATORY_REASONING_ALLOWANCE_TOKENS,
      reasoning: { effort: "low" },
    });
  });

  it("an unknown value in config reads as unset", async () => {
    state.cfg["llmReasoningEffort"] = "maximum";
    const fn = stubFetch(() => ok());
    await complete({ messages: msgs, maxTokens: 500 });
    expect(sent(fn, 0).body.reasoning).toEqual({ enabled: false });
    expect(sent(fn, 0).body["max_tokens"]).toBe(500);
  });
});

describe("llmReasoningEffort set", () => {
  it("scales the allowance with the effort; a mandatory model with none gets low's", () => {
    expect(REASONING_ALLOWANCE_TOKENS).toEqual({
      low: 8192,
      medium: 16384,
      high: 32768,
      xhigh: 49152,
    });
    expect(MANDATORY_REASONING_ALLOWANCE_TOKENS).toBe(REASONING_ALLOWANCE_TOKENS.low);
    expect(REASONING_RETRY_MAX_TOKENS).toBe(65536);
  });

  it("medium on a mandatory model: effort medium, the medium allowance on top of maxTokens", async () => {
    state.cfg = { ...state.cfg, llmModel: SEEDED, llmReasoningEffort: "medium" };
    const fn = stubFetch(mandatory);
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn, 0).body.reasoning).toEqual({ effort: "medium" });
    expect(sent(fn, 0).body["max_tokens"]).toBe(500 + REASONING_ALLOWANCE_TOKENS.medium);
  });

  it("a model that could have reasoning off reasons at the effort instead", async () => {
    state.cfg["llmReasoningEffort"] = "high";
    const fn = stubFetch(() => ok());
    await complete({ messages: msgs, maxTokens: 300 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn, 0).body.reasoning).toEqual({ effort: "high" });
    expect(sent(fn, 0).body["max_tokens"]).toBe(300 + REASONING_ALLOWANCE_TOKENS.high);
  });

  it("an effort the model refuses is asked again at low, then with no effort", async () => {
    state.cfg["llmReasoningEffort"] = "xhigh";
    const fn = stubFetch((_url, body) =>
      body.reasoning?.effort === "xhigh"
        ? rejection(400, "reasoning.effort 'xhigh' is not supported by this model")
        : ok(),
    );
    const out = await complete({ messages: msgs, maxTokens: 500 });
    expect(out.content).toBe('{"ok":true}');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 1).body.reasoning).toEqual({ effort: "low" });
    expect(sent(fn, 1).body["max_tokens"]).toBe(500 + REASONING_ALLOWANCE_TOKENS.xhigh);

    // Remembered: the next call goes straight to low.
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sent(fn, 2).body.reasoning).toEqual({ effort: "low" });

    state.cfg["llmModel"] = `${fresh}-no-effort`;
    const none = stubFetch((_url, body) =>
      body.reasoning ? rejection(400, "Unsupported parameter: effort") : ok(),
    );
    await complete({ messages: msgs, maxTokens: 500 });
    expect(none).toHaveBeenCalledTimes(3);
    expect(sent(none, 2).body.reasoning).toBeUndefined();
    expect(sent(none, 2).body["max_tokens"]).toBe(500 + REASONING_ALLOWANCE_TOKENS.xhigh);
    await complete({ messages: msgs, maxTokens: 500 });
    expect(none).toHaveBeenCalledTimes(4);
    expect(sent(none, 3).body.reasoning).toBeUndefined();
  });

  it("low asks once at low before dropping the effort", async () => {
    state.cfg["llmReasoningEffort"] = "low";
    const fn = stubFetch((_url, body) =>
      body.reasoning ? rejection(400, "reasoning is not supported") : ok(),
    );
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 0).body.reasoning).toEqual({ effort: "low" });
    expect(sent(fn, 1).body.reasoning).toBeUndefined();
  });

  it("a 400 about something else is not retried", async () => {
    state.cfg["llmReasoningEffort"] = "medium";
    const fn = stubFetch(() => rejection(400, "messages must not be empty"));
    await expect(complete({ messages: msgs, maxTokens: 500 })).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reasoning that eats the budget: one retry with the allowance doubled", async () => {
    state.cfg["llmReasoningEffort"] = "medium";
    const first = 500 + REASONING_ALLOWANCE_TOKENS.medium;
    const fn = stubFetch((_url, body) =>
      body["max_tokens"] === first
        ? cutOff(body, first - 3, 0.01)
        : { ...ok(), json: okCost(0.02) },
    );
    const out = await complete({ messages: msgs, maxTokens: 500 });
    expect(out.content).toBe('{"ok":true}');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 1).body.reasoning).toEqual({ effort: "medium" });
    expect(sent(fn, 1).body["max_tokens"]).toBe(500 + 2 * REASONING_ALLOWANCE_TOKENS.medium);
    // Both tries were billed.
    expect(out.costUsd).toBeCloseTo(0.03);
  });

  it("the resend is outside maxAttempts but still reaches the accounting hook", async () => {
    state.cfg["llmReasoningEffort"] = "medium";
    const first = 500 + REASONING_ALLOWANCE_TOKENS.medium;
    const fn = stubFetch((_url, body) =>
      body["max_tokens"] === first ? cutOff(body, first - 3) : ok(),
    );
    const onAttempt = vi.fn();
    await complete({ messages: msgs, maxTokens: 500, maxAttempts: 1, onAttempt });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it("a cut-off try's cost survives a resend that fails and is retried", async () => {
    vi.useFakeTimers();
    try {
      state.cfg["llmReasoningEffort"] = "medium";
      const first = 500 + REASONING_ALLOWANCE_TOKENS.medium;
      let calls = 0;
      stubFetch((_url, body) => {
        calls++;
        if (calls === 2) return rejection(503, "upstream down");
        return body["max_tokens"] === first && calls === 1
          ? cutOff(body, first - 3, 0.01)
          : { ...ok(), json: okCost(0.02) };
      });
      const pending = complete({ messages: msgs, maxTokens: 500, maxAttempts: 2 });
      await vi.runAllTimersAsync();
      const out = await pending;
      expect(calls).toBe(3);
      expect(out.costUsd).toBeCloseTo(0.03);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second cut-off is the clear truncation error, after exactly one retry", async () => {
    state.cfg["llmReasoningEffort"] = "medium";
    const fn = stubFetch((_url, body) => cutOff(body, (body["max_tokens"] as number) - 3));
    const err = await complete({ messages: msgs, maxTokens: 500 }).catch((e: unknown) => e);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(LlmTruncatedError);
    const retried = 500 + 2 * REASONING_ALLOWANCE_TOKENS.medium;
    expect((err as Error).message).toContain(
      `truncated at max_tokens=${retried} (${retried - 3}/${retried} tokens were reasoning)`,
    );
  });

  it("an answer that overflows on its own is not retried", async () => {
    state.cfg["llmReasoningEffort"] = "medium";
    const fn = stubFetch((_url, body) => cutOff(body, 4590));
    const err = await complete({ messages: msgs, maxTokens: 500 }).catch((e: unknown) => e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(LlmTruncatedError);
    const max = 500 + REASONING_ALLOWANCE_TOKENS.medium;
    expect((err as Error).message).toContain(
      `truncated at max_tokens=${max} (4590/${max} tokens were reasoning)`,
    );
  });

  it("the retry's whole max_tokens is capped, and no room under the cap means no retry", async () => {
    state.cfg["llmReasoningEffort"] = "xhigh";
    const fn = stubFetch((_url, body) => cutOff(body, (body["max_tokens"] as number) - 1));
    await expect(complete({ messages: msgs, maxTokens: 500 })).rejects.toThrow(LlmTruncatedError);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 1).body["max_tokens"]).toBe(REASONING_RETRY_MAX_TOKENS);

    await expect(complete({ messages: msgs, maxTokens: 20000 })).rejects.toThrow(LlmTruncatedError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("unset, mandatory model: the low allowance doubles once", async () => {
    state.cfg["llmModel"] = SEEDED;
    const first = 500 + MANDATORY_REASONING_ALLOWANCE_TOKENS;
    const fn = stubFetch((_url, body) =>
      body["max_tokens"] === first ? cutOff(body, first - 31) : ok(),
    );
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 1).body.reasoning).toEqual({ effort: "low" });
    expect(sent(fn, 1).body["max_tokens"]).toBe(500 + 2 * MANDATORY_REASONING_ALLOWANCE_TOKENS);
  });

  it("unset, reasoning switched off: a cut-off is not retried", async () => {
    const fn = stubFetch((_url, body) => cutOff(body, (body["max_tokens"] as number) - 1));
    await expect(complete({ messages: msgs, maxTokens: 500 })).rejects.toThrow(LlmTruncatedError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn, 0).body.reasoning).toEqual({ enabled: false });
  });

  it("the OpenRouter fallback of another primary keeps today's request", async () => {
    vi.stubEnv("OPENAI_API_KEY", "oa-key");
    state.cfg = {
      llmProvider: "openai",
      llmModel: "gpt-test",
      llmReasoningEffort: "high",
      llmFallback: { provider: "openrouter", model: fresh },
    };
    const fn = stubFetch((url) => (url.startsWith(OR) ? ok() : rejection(503, "down")));
    await complete({ messages: msgs, maxTokens: 500, maxAttempts: 1 });
    expect(sent(fn, 0).body.reasoning).toBeUndefined();
    expect(sent(fn, 1).url).toBe(OR);
    expect(sent(fn, 1).body.reasoning).toEqual({ enabled: false });
    expect(sent(fn, 1).body["max_tokens"]).toBe(500);
  });

  it("an OpenRouter primary's fallback gets no effort", async () => {
    vi.stubEnv("OPENAI_API_KEY", "oa-key");
    state.cfg = {
      ...state.cfg,
      llmReasoningEffort: "medium",
      llmFallback: { provider: "openai", model: "gpt-test" },
    };
    const fn = stubFetch((url) => (url.startsWith(OR) ? rejection(503, "down") : ok()));
    await complete({ messages: msgs, maxTokens: 500, maxAttempts: 1 });
    expect(sent(fn, 0).body.reasoning).toEqual({ effort: "medium" });
    expect(sent(fn, 1).body.reasoning).toBeUndefined();
    expect(sent(fn, 1).body["max_tokens"]).toBe(500);
  });

  it("the anthropic provider ignores it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "an-key");
    state.cfg = {
      llmProvider: "anthropic",
      llmModel: "claude-sonnet-5-5",
      llmReasoningEffort: "high",
    };
    const anthropic = stubFetch(() => claudeOk());
    await complete({ messages: msgs, maxTokens: 500 });
    expect(sent(anthropic, 0).body["output_config"]).toEqual({ effort: "low" });
    expect(sent(anthropic, 0).body["max_tokens"]).toBe(500 + MANDATORY_REASONING_ALLOWANCE_TOKENS);
  });
});

describe("llmReasoningEffort on the proxy", () => {
  const PROXY = "http://127.0.0.1:8317";
  beforeEach(() => {
    vi.stubEnv("LLM_PROXY_API_KEY", "px-key");
    state.cfg = { llmProvider: "proxy", llmModel: fresh, llmBaseUrl: PROXY, llmFallback: null };
  });

  it("unset: the chat request is unchanged", async () => {
    const fn = stubFetch(() => ok());
    await complete({ messages: msgs, maxTokens: 500, temperature: 0.2 });
    expect(sent(fn, 0).url).toBe(`${PROXY}/v1/chat/completions`);
    expect(sent(fn, 0).body).toEqual({
      model: fresh,
      messages: expect.any(Array),
      temperature: 0.2,
      max_tokens: 500,
    });
  });

  it("set: reasoning_effort on the chat request, the allowance on top of maxTokens", async () => {
    state.cfg["llmReasoningEffort"] = "high";
    const fn = stubFetch(() => ok());
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn, 0).body["reasoning_effort"]).toBe("high");
    expect(sent(fn, 0).body.reasoning).toBeUndefined();
    expect(sent(fn, 0).body["max_tokens"]).toBe(500 + REASONING_ALLOWANCE_TOKENS.high);
  });

  it("reasoning that eats the budget: one retry at the same effort, allowance doubled", async () => {
    state.cfg["llmReasoningEffort"] = "low";
    const first = 500 + REASONING_ALLOWANCE_TOKENS.low;
    const fn = stubFetch((_url, body) =>
      body["max_tokens"] === first ? cutOff(body, first - 3) : ok(),
    );
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 1).url).toBe(`${PROXY}/v1/chat/completions`);
    expect(sent(fn, 1).body["reasoning_effort"]).toBe("low");
    expect(sent(fn, 1).body["max_tokens"]).toBe(500 + 2 * REASONING_ALLOWANCE_TOKENS.low);

    const twice = stubFetch((_url, body) => cutOff(body, (body["max_tokens"] as number) - 3));
    await expect(complete({ messages: msgs, maxTokens: 500 })).rejects.toThrow(LlmTruncatedError);
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it("unset: no allowance, so a cut-off is not retried", async () => {
    const fn = stubFetch((_url, body) => cutOff(body, (body["max_tokens"] as number) - 1));
    await expect(complete({ messages: msgs, maxTokens: 500 })).rejects.toThrow(LlmTruncatedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a 400 about the effort sends today's request, and the route remembers it", async () => {
    state.cfg["llmReasoningEffort"] = "xhigh";
    const fn = stubFetch((_url, body) =>
      body["reasoning_effort"] ? rejection(400, "invalid reasoning_effort: xhigh") : ok(),
    );
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sent(fn, 1).body["reasoning_effort"]).toBeUndefined();
    expect(sent(fn, 1).body["max_tokens"]).toBe(500);
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sent(fn, 2).body["reasoning_effort"]).toBeUndefined();
  });

  it("a refusal on one endpoint does not drop the effort on another", async () => {
    const OTHER = "http://127.0.0.1:8318";
    state.cfg["llmReasoningEffort"] = "high";
    const fn = stubFetch((url, body) =>
      url.startsWith(PROXY) && body["reasoning_effort"]
        ? rejection(400, "invalid reasoning_effort: high")
        : ok(),
    );
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
    state.cfg["llmBaseUrl"] = OTHER;
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sent(fn, 2).url).toBe(`${OTHER}/v1/chat/completions`);
    expect(sent(fn, 2).body["reasoning_effort"]).toBe("high");
    expect(sent(fn, 2).body["max_tokens"]).toBe(500 + REASONING_ALLOWANCE_TOKENS.high);
  });

  it("a 400 about something else is not retried", async () => {
    state.cfg["llmReasoningEffort"] = "medium";
    const fn = stubFetch(() => rejection(400, "messages must not be empty"));
    await expect(complete({ messages: msgs, maxTokens: 500 })).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("Claude Sonnet 5.5 gets the effort in place of low; 400 goes back to low", async () => {
    state.cfg = { ...state.cfg, llmModel: "claude-sonnet-5-5", llmReasoningEffort: "medium" };
    const fn = stubFetch((_url, body) =>
      (body["output_config"] as { effort?: string } | undefined)?.effort === "medium"
        ? rejection(400, "output_config.effort: unsupported value")
        : claudeOk(),
    );
    await complete({ messages: msgs, maxTokens: 500 });
    expect(sent(fn, 0).url).toBe(`${PROXY}/v1/messages`);
    expect(sent(fn, 0).body["output_config"]).toEqual({ effort: "medium" });
    expect(sent(fn, 0).body["max_tokens"]).toBe(500 + REASONING_ALLOWANCE_TOKENS.medium);
    expect(sent(fn, 1).body["output_config"]).toEqual({ effort: "low" });
    expect(sent(fn, 1).body["max_tokens"]).toBe(500 + MANDATORY_REASONING_ALLOWANCE_TOKENS);
  });

  it("other Claude models are unchanged, set or not", async () => {
    state.cfg = { ...state.cfg, llmModel: "claude-opus-5-5", llmReasoningEffort: "high" };
    const fn = stubFetch(() => claudeOk());
    await complete({ messages: msgs, maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent(fn, 0).body["output_config"]).toBeUndefined();
    expect(sent(fn, 0).body["max_tokens"]).toBe(500);
  });

  it("a proxy fallback gets no effort", async () => {
    state.cfg = {
      llmProvider: "openrouter",
      llmModel: `${fresh}-primary`,
      llmBaseUrl: PROXY,
      llmReasoningEffort: "high",
      llmFallback: { provider: "proxy", model: fresh },
    };
    const fn = stubFetch((url) => (url.startsWith(PROXY) ? ok() : rejection(503, "down")));
    await complete({ messages: msgs, maxTokens: 500, maxAttempts: 1 });
    expect(sent(fn, 1).url).toBe(`${PROXY}/v1/chat/completions`);
    expect(sent(fn, 1).body["reasoning_effort"]).toBeUndefined();
    expect(sent(fn, 1).body["max_tokens"]).toBe(500);
  });
});
