import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `proxy` provider (a user-run server such as CLIProxyAPI) and the
// fallback provider that serves calls the primary can't.

const state = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  events: [] as Array<{ event: string; data: Record<string, unknown> }>,
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...state.cfg }),
    logEvent: (event: string, data: Record<string, unknown>) => {
      state.events.push({ event, data });
    },
  };
});

const {
  complete,
  proxyBaseUrl,
  proxyShape,
  isAvailabilityFailure,
  LlmError,
  _resetLlmBreakerForTests,
} = await import("../src/client.ts");

const realFetch = global.fetch;
const msgs = [{ role: "user" as const, content: "hi" }];

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "refused";

function chat(text: string) {
  return {
    status: 200,
    body: { choices: [{ message: { content: text }, finish_reason: "stop" }] },
  };
}
function messages(text: string) {
  return { status: 200, body: { content: [{ type: "text", text }], stop_reason: "end_turn" } };
}

/** Answers by URL prefix, in order per prefix. */
function stubFetch(routes: Record<string, Reply[]>) {
  const fn = vi.fn().mockImplementation((url: string) => {
    const prefix = Object.keys(routes).find((p) => url.startsWith(p));
    const reply = prefix ? routes[prefix]!.shift() : undefined;
    if (!reply) return Promise.reject(new Error(`unexpected fetch ${url}`));
    if (reply === "refused") return Promise.reject(new TypeError("fetch failed: ECONNREFUSED"));
    return Promise.resolve({
      ok: reply.status < 400,
      status: reply.status,
      headers: new Headers(reply.headers ?? {}),
      json: () => Promise.resolve(reply.body),
      text: () => Promise.resolve(JSON.stringify(reply.body ?? {})),
    });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function call(fn: ReturnType<typeof vi.fn>, i = 0) {
  const [url, init] = fn.mock.calls[i] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

const PROXY = "http://127.0.0.1:8317";
const OR = "https://openrouter.ai/api/v1";

beforeEach(() => {
  state.events.length = 0;
  state.cfg = { llmProvider: "proxy", llmModel: "claude-sonnet-5-5", llmBaseUrl: PROXY };
  _resetLlmBreakerForTests();
  vi.stubEnv("LLM_PROXY_API_KEY", "proxy-key");
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
});
afterEach(() => {
  global.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("proxy provider", () => {
  it("sends Claude models to the Anthropic messages API with the proxy key and Claude rules", async () => {
    const fn = stubFetch({ [`${PROXY}/v1/messages`]: [messages("ok")] });
    const out = await complete({ messages: msgs, maxTokens: 100 });
    const sent = call(fn);
    expect(sent.url).toBe(`${PROXY}/v1/messages`);
    expect(sent.headers["x-api-key"]).toBe("proxy-key");
    expect(sent.body["temperature"]).toBeUndefined();
    expect(sent.body["output_config"]).toEqual({ effort: "low" });
    expect(sent.body["max_tokens"]).toBe(100 + 8192);
    expect(out).toMatchObject({ content: "ok", provider: "proxy", model: "claude-sonnet-5-5" });
  });

  it("sends other models to the OpenAI chat API with no OpenRouter parameters", async () => {
    state.cfg["llmModel"] = "gpt-6.1-sol";
    const fn = stubFetch({ [`${PROXY}/v1/chat/completions`]: [chat("ok")] });
    const out = await complete({ messages: msgs });
    const sent = call(fn);
    expect(sent.headers["Authorization"]).toBe("Bearer proxy-key");
    expect(sent.body["reasoning"]).toBeUndefined();
    expect(sent.headers["HTTP-Referer"]).toBeUndefined();
    expect(out.provider).toBe("proxy");
  });

  it("accepts a base URL with a trailing slash or /v1", () => {
    expect(proxyBaseUrl("http://127.0.0.1:8317/")).toBe(PROXY);
    expect(proxyBaseUrl(" http://127.0.0.1:8317/v1/ ")).toBe(PROXY);
    expect(() => proxyBaseUrl("  ")).toThrow(/llmBaseUrl/);
    expect(() => proxyBaseUrl("http://proxy.example.com:8317")).toThrow(/https/);
    expect(proxyBaseUrl("https://proxy.example.com")).toBe("https://proxy.example.com");
    expect(() => proxyBaseUrl("http://192.168.1.20:8317")).toThrow(/https/);
    expect(proxyShape("claude-opus-5-5")).toBe("anthropic");
    expect(proxyShape("gemini-3.8-flash")).toBe("openai");
  });

  it("never follows a redirect with the key", async () => {
    const fn = stubFetch({ [`${PROXY}/v1/messages`]: [messages("ok")] });
    await complete({ messages: msgs });
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  it("names the missing proxy key", async () => {
    vi.stubEnv("LLM_PROXY_API_KEY", "");
    await expect(complete({ messages: msgs })).rejects.toThrow(/LLM_PROXY_API_KEY/);
  });
});

describe("fallback", () => {
  beforeEach(() => {
    state.cfg["llmFallback"] = { provider: "openrouter", model: "vendor/fallback-model" };
  });

  it.each<[string, Reply]>([
    ["connection refused", "refused"],
    ["401", { status: 401, body: { error: "bad key" } }],
    ["429", { status: 429, body: {} }],
    ["503", { status: 503, body: {} }],
    ["429 with a long Retry-After", { status: 429, body: {}, headers: { "retry-after": "600" } }],
  ])("serves a %s from the fallback, on the fallback's model", async (_name, reply) => {
    const fn = stubFetch({ [`${PROXY}/v1/messages`]: [reply], [OR]: [chat("from fallback")] });
    const out = await complete({ messages: msgs, maxAttempts: 1, model: "claude-opus-5-5" });
    expect(out).toMatchObject({ content: "from fallback", provider: "openrouter" });
    const sent = call(fn, 1);
    expect(sent.headers["Authorization"]).toBe("Bearer or-key");
    expect(sent.body["model"]).toBe("vendor/fallback-model");
    expect(state.events.find((e) => e.event === "llm.fallback")?.data).toMatchObject({
      from: "proxy",
      to: "openrouter",
    });
  });

  it.each<[string, Reply]>([
    ["400", { status: 400, body: { error: "bad request" } }],
    ["404", { status: 404, body: { error: "unknown model" } }],
  ])("does not fall back on a %s", async (_name, reply) => {
    const fn = stubFetch({ [`${PROXY}/v1/messages`]: [reply] });
    await expect(complete({ messages: msgs, maxAttempts: 1 })).rejects.toBeInstanceOf(LlmError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on a truncated answer", async () => {
    stubFetch({
      [`${PROXY}/v1/messages`]: [
        {
          status: 200,
          body: { content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" },
        },
      ],
    });
    await expect(complete({ messages: msgs, maxAttempts: 1 })).rejects.toThrow(/truncated/);
  });

  it("skips the primary while the breaker is open, then tries it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fn = stubFetch({
      [`${PROXY}/v1/messages`]: ["refused", messages("primary back")],
      [OR]: [chat("one"), chat("two")],
    });
    await complete({ messages: msgs, maxAttempts: 1 });
    expect((await complete({ messages: msgs, maxAttempts: 1 })).content).toBe("two");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(state.events.findLast((e) => e.event === "llm.fallback")?.data["reason"]).toBe(
      "breaker",
    );

    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect((await complete({ messages: msgs, maxAttempts: 1 })).content).toBe("primary back");
  });

  it("a call that started before a failure does not close the breaker the failure opened", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let n = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith(OR)) return { ok: true, status: 200, json: async () => chat("fb").body };
      n++;
      if (n === 1) {
        await slow;
        return { ok: true, status: 200, json: async () => messages("slow").body };
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const first = complete({ messages: msgs, maxAttempts: 1 });
    await complete({ messages: msgs, maxAttempts: 1 });
    release();
    expect((await first).content).toBe("slow");
    expect((await complete({ messages: msgs, maxAttempts: 1 })).content).toBe("fb");
    expect(n).toBe(2);
  });

  it("a later short failure does not shorten a Retry-After breaker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let n = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith(OR)) return { ok: true, status: 200, json: async () => chat("fb").body };
      n++;
      if (n === 1) {
        await slow;
        throw new TypeError("fetch failed");
      }
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "1800" }),
        text: async () => "{}",
      };
    }) as unknown as typeof fetch;
    const first = complete({ messages: msgs, maxAttempts: 1 });
    await complete({ messages: msgs, maxAttempts: 1 });
    release();
    await first;
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect((await complete({ messages: msgs, maxAttempts: 1 })).content).toBe("fb");
    expect(n).toBe(2);
  });

  it("holds the breaker for a Retry-After longer than its window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    stubFetch({
      [`${PROXY}/v1/messages`]: [{ status: 429, body: {}, headers: { "retry-after": "1800" } }],
      [OR]: [chat("one"), chat("two")],
    });
    await complete({ messages: msgs, maxAttempts: 1 });
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect((await complete({ messages: msgs, maxAttempts: 1 })).content).toBe("two");
  });

  it("keeps the primary's error when the fallback has no key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const fn = stubFetch({ [`${PROXY}/v1/messages`]: [{ status: 503, body: {} }] });
    await expect(complete({ messages: msgs, maxAttempts: 1 })).rejects.toThrow(/proxy 503/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("noFallback checks the primary alone and leaves the breaker shut", async () => {
    const fn = stubFetch({
      [`${PROXY}/v1/messages`]: [{ status: 503, body: {} }, messages("primary")],
    });
    await expect(complete({ messages: msgs, maxAttempts: 1, noFallback: true })).rejects.toThrow(
      /proxy 503/,
    );
    expect((await complete({ messages: msgs, maxAttempts: 1 })).content).toBe("primary");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("without a fallback, an unavailable primary fails as before", async () => {
    state.cfg["llmFallback"] = null;
    stubFetch({ [`${PROXY}/v1/messages`]: ["refused"] });
    await expect(complete({ messages: msgs, maxAttempts: 1 })).rejects.toThrow(
      /proxy request failed/,
    );
  });
});

describe("isAvailabilityFailure", () => {
  it("covers key, credit, rate and server faults only", () => {
    for (const status of [401, 402, 403, 429, 500, 529]) {
      expect(isAvailabilityFailure(new LlmError("x", status))).toBe(true);
    }
    for (const status of [400, 404, 422]) {
      expect(isAvailabilityFailure(new LlmError("x", status))).toBe(false);
    }
    expect(isAvailabilityFailure(new LlmError("no status"))).toBe(false);
    expect(isAvailabilityFailure(new Error("plain"))).toBe(false);
  });
});
