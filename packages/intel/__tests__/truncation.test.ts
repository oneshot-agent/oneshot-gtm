import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider path is picked from config, so the config is the knob these
// cases turn. Everything else about loadConfig stays real (the suite already
// points ONESHOT_GTM_HOME at a temp dir).
const cfg = vi.hoisted(() => ({
  provider: "openrouter" as "openrouter" | "openai" | "anthropic",
  model: "test-model",
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), llmProvider: cfg.provider, llmModel: cfg.model }),
  };
});

const { complete } = await import("../src/client.ts");

const realFetch = global.fetch;

/** One mocked 2xx JSON response. No timers needed: truncation is terminal. */
function respondWith(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function requestOf(fn: ReturnType<typeof respondWith>): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const [url, init] = fn.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
}

async function errorFrom(p: Promise<unknown>): Promise<Error> {
  return await p.then(
    () => {
      throw new Error("expected complete() to reject");
    },
    (err: Error) => err,
  );
}

beforeEach(() => {
  cfg.provider = "openrouter";
  cfg.model = "test-model";
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  global.fetch = realFetch;
});

describe("complete() truncation — openrouter", () => {
  it("names the provider, model and ceiling on a plain overrun", async () => {
    const fetchMock = respondWith({
      choices: [{ message: { content: "half a js" }, finish_reason: "length" }],
      usage: { prompt_tokens: 40, completion_tokens: 512 },
    });

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 512 }),
    );

    expect(err.message).toBe(
      "truncated at max_tokens=512 (raise maxTokens) — openrouter test-model.",
    );
    // Truncation is terminal — a resend reproduces it exactly.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestOf(fetchMock).url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requestOf(fetchMock).headers["X-Title"]).toBe("oneshot-gtm");
  });

  it("distinguishes a reasoning-tokens overrun, which needs the opposite fix", async () => {
    const fetchMock = respondWith({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: {
        completion_tokens: 500,
        completion_tokens_details: { reasoning_tokens: 480 },
      },
    });

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 }),
    );

    expect(err.message).toContain("truncated at max_tokens=500 (480/500 tokens were reasoning)");
    expect(err.message).toContain("— openrouter test-model.");
    expect(err.message).toContain(
      "Use a model that does not reason by default, or raise maxTokens above the reasoning budget.",
    );
    // The plain-overrun advice ("just raise it") must NOT appear — it is the
    // wrong instruction when the budget went to reasoning.
    expect(err.message).not.toContain("(raise maxTokens)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the 1024 default when the caller set no maxTokens", async () => {
    respondWith({
      choices: [{ message: { content: "x" }, finish_reason: "length" }],
    });

    const err = await errorFrom(complete({ messages: [{ role: "user", content: "hi" }] }));

    expect(err.message).toBe(
      "truncated at max_tokens=1024 (raise maxTokens) — openrouter test-model.",
    );
  });

  it("hands the partial text back when allowTruncation is set", async () => {
    respondWith({
      choices: [{ message: { content: "a report cut off mid-" }, finish_reason: "length" }],
      usage: { prompt_tokens: 12, completion_tokens: 512 },
    });

    const res = await complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 512,
      allowTruncation: true,
    });

    expect(res.content).toBe("a report cut off mid-");
    expect(res.provider).toBe("openrouter");
    expect(res.outputTokens).toBe(512);
  });
});

describe("complete() truncation — openai", () => {
  beforeEach(() => {
    cfg.provider = "openai";
  });

  it("names the openai path on a plain overrun", async () => {
    const fetchMock = respondWith({
      choices: [{ message: { content: "half" }, finish_reason: "length" }],
      usage: { completion_tokens: 256 },
    });

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 256 }),
    );

    expect(err.message).toBe("truncated at max_tokens=256 (raise maxTokens) — openai test-model.");
    const req = requestOf(fetchMock);
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers["Authorization"]).toBe("Bearer test-key");
    expect(req.headers["X-Title"]).toBeUndefined();
  });

  it("omits the /total when the provider reported reasoning tokens but no completion count", async () => {
    respondWith({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { completion_tokens_details: { reasoning_tokens: 480 } },
    });

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 }),
    );

    expect(err.message).toContain("(480 tokens were reasoning)");
    expect(err.message).not.toContain("/");
    expect(err.message).toContain("— openai test-model.");
  });

  it("hands the partial text back when allowTruncation is set", async () => {
    respondWith({
      choices: [{ message: { content: "partial prose" }, finish_reason: "length" }],
    });

    const res = await complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
      allowTruncation: true,
    });

    expect(res.content).toBe("partial prose");
    expect(res.provider).toBe("openai");
  });
});

describe("complete() truncation — anthropic", () => {
  beforeEach(() => {
    cfg.provider = "anthropic";
  });

  it("names the anthropic path on a max_tokens stop, without reasoning wording", async () => {
    const fetchMock = respondWith({
      content: [{ type: "text", text: "half a we" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 30, output_tokens: 700 },
    });

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 700 }),
    );

    // The Messages API reports no reasoning-token split, so this path always
    // produces the plain-overrun wording.
    expect(err.message).toBe(
      "truncated at max_tokens=700 (raise maxTokens) — anthropic test-model.",
    );
    expect(err.message).not.toContain("reasoning");
    const req = requestOf(fetchMock);
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("test-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands the partial text back when allowTruncation is set", async () => {
    respondWith({
      content: [
        { type: "text", text: "## Week of\n" },
        { type: "text", text: "cut off mid-" },
      ],
      stop_reason: "max_tokens",
      usage: { input_tokens: 30, output_tokens: 700 },
    });

    const res = await complete({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      maxTokens: 700,
      allowTruncation: true,
    });

    expect(res.content).toBe("## Week of\ncut off mid-");
    expect(res.provider).toBe("anthropic");
    expect(res.inputTokens).toBe(30);
  });
});
