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

/** A mocked 400 whose body rejects the given reasoning effort tier. */
function rejectedReasoning(effort: string) {
  return {
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: () =>
      Promise.resolve(
        `{"error":{"message":"reasoning.effort must be 'high' for this model, got '${effort}'"}}`,
      ),
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

describe("complete() reasoning switch — openrouter vs openai", () => {
  it("turns reasoning off on OpenRouter requests, where it would eat the small max_tokens budgets", async () => {
    const fetchMock = respondWith({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { completion_tokens: 2 },
    });
    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
    expect(requestOf(fetchMock).body["reasoning"]).toEqual({ enabled: false });
  });

  it("falls back to a raised-budget, lowest-supported-effort request when OpenRouter says the model's reasoning is mandatory, and remembers the effort that worked", async () => {
    // Card #586: the retry used to keep the caller's small max_tokens budget
    // and send NO effort dial, so a reasoning-mandatory model reliably burned
    // the whole budget on reasoning and truncated every draft. The retry now
    // climbs the effort ladder from "minimal" up, stopping at the first tier
    // this model actually accepts, and raises max_tokens by the reasoning
    // allowance on top of the caller's own budget.
    cfg.model = "mandatory-reasoning-model";
    const ok = {
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }),
    };
    const rejected = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () =>
        Promise.resolve(
          '{"error":{"message":"Reasoning is mandatory for this model and cannot be disabled"}}',
        ),
    };
    const fn = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(ok);
    global.fetch = fn as unknown as typeof fetch;

    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
    const bodies = fn.mock.calls.map(([, init]) =>
      JSON.parse((init as RequestInit).body as string),
    );
    expect(bodies[0]).toHaveProperty("reasoning", { enabled: false });
    expect(bodies[0]).toHaveProperty("max_tokens", 500);
    // The retry carries BOTH the lowest supported effort ("minimal" — the
    // first rung on the ladder this model accepted) and a raised budget
    // (caller's 500 + the reasoning allowance), never neither.
    expect(bodies[1]).toHaveProperty("reasoning", { effort: "minimal" });
    expect(bodies[1]).toHaveProperty("max_tokens", 500 + 1500);

    // Remembered: the next call to the same model skips the probe round trip
    // and goes straight to the effort dial + raised budget.
    await complete({ messages: [{ role: "user", content: "again" }], maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
    const thirdBody = JSON.parse((fn.mock.calls[2]![1] as RequestInit).body as string);
    expect(thirdBody).toHaveProperty("reasoning", { effort: "minimal" });
    expect(thirdBody).toHaveProperty("max_tokens", 500 + 1500);
  });

  it('climbs past efforts the model rejects with a 400, landing on the lowest one it actually accepts — the o4-mini-high / o3-mini-high shape (supported_efforts: ["high"] only)', async () => {
    // Finding from #586 round-1 review: some real mandatory-reasoning
    // OpenRouter models (openai/o4-mini-high, openai/o3-mini-high) reject
    // EVERY effort below "high" with a 400, not just "minimal". A hardcoded
    // single tier ("low") 400s forever on these and, worse, used to get
    // persisted as the remembered choice before the retry's outcome was
    // known — permanently wedging every future call. The ladder must climb
    // past every rejected rung and only remember the one that actually
    // returned 200.
    cfg.model = "high-only-model";
    const ok = {
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }),
    };
    const fn = vi
      .fn()
      // probe: disableReasoning -> rejected as mandatory
      .mockResolvedValueOnce(rejectedReasoning("disabled"))
      // ladder: minimal -> 400, low -> 400, medium -> 400, high -> 200
      .mockResolvedValueOnce(rejectedReasoning("minimal"))
      .mockResolvedValueOnce(rejectedReasoning("low"))
      .mockResolvedValueOnce(rejectedReasoning("medium"))
      // Every later call (including the second complete() below, which is
      // remembered and skips straight to "high") gets a 200.
      .mockResolvedValue(ok);
    global.fetch = fn as unknown as typeof fetch;

    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(5);
    const bodies = fn.mock.calls.map(([, init]) =>
      JSON.parse((init as RequestInit).body as string),
    );
    expect(bodies[1]).toHaveProperty("reasoning", { effort: "minimal" });
    expect(bodies[2]).toHaveProperty("reasoning", { effort: "low" });
    expect(bodies[3]).toHaveProperty("reasoning", { effort: "medium" });
    expect(bodies[4]).toHaveProperty("reasoning", { effort: "high" });

    // Only "high" — the one that actually returned 200 — gets remembered.
    // A NEXT call to the same model must go straight to "high", not restart
    // the climb at "minimal" and not get stuck on an effort that never
    // worked.
    await complete({ messages: [{ role: "user", content: "again" }], maxTokens: 500 });
    expect(fn).toHaveBeenCalledTimes(6);
    const rememberedBody = JSON.parse((fn.mock.calls[5]![1] as RequestInit).body as string);
    expect(rememberedBody).toHaveProperty("reasoning", { effort: "high" });
  });

  it("never remembers an effort when every rung on the ladder 400s, so the next call re-probes instead of replaying a value nothing verified", async () => {
    // The core of the round-1 finding: rememberMandatoryReasoningModel() must
    // only fire on a VERIFIED success. If it fired before the retry's
    // outcome were known (the pre-correction behaviour), a model that
    // rejects every effort would get permanently wedged on a doomed retry —
    // this process and every future process, since the mapping persists to
    // disk.
    cfg.model = "rejects-everything-model";
    const rejected = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () => Promise.resolve('{"error":{"message":"reasoning cannot be disabled"}}'),
    };
    const fn = vi.fn().mockResolvedValue(rejected);
    global.fetch = fn as unknown as typeof fetch;

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500, maxAttempts: 1 }),
    );
    expect(err.message).toContain("400");
    // probe + 4 ladder rungs (minimal, low, medium, high), all rejected.
    expect(fn).toHaveBeenCalledTimes(5);

    // Nothing was remembered — the very next call re-probes from scratch
    // rather than skipping straight to a persisted-but-never-verified value.
    fn.mockClear();
    await errorFrom(
      complete({ messages: [{ role: "user", content: "again" }], maxTokens: 500, maxAttempts: 1 }),
    );
    expect(fn).toHaveBeenCalledTimes(5);
    const firstRetryBody = JSON.parse((fn.mock.calls[0]![1] as RequestInit).body as string);
    expect(firstRetryBody).toHaveProperty("reasoning", { enabled: false });
  });

  it("still raises the truncation diagnostic on a mandatory-reasoning model, never a silent empty draft, even when the raised budget still isn't enough", async () => {
    cfg.model = "mandatory-reasoning-model-2";
    const rejected = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () => Promise.resolve('{"error":{"message":"reasoning cannot be disabled"}}'),
    };
    const stillTruncated = {
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1999 } },
        }),
    };
    const fn = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(stillTruncated);
    global.fetch = fn as unknown as typeof fetch;

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 }),
    );
    expect(err.message).toContain("truncated at max_tokens=2000");
    expect(err.message).toContain("1999/2000 tokens were reasoning");
    // A 200 that truncates is not a 400 "this effort is unsupported" signal —
    // the ladder climb stops on the first rung tried (a genuine truncation
    // error carries no status, so it is not retried as unsupported-effort).
    expect(fn).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fn.mock.calls[1]![1] as RequestInit).body as string);
    expect(retryBody).toHaveProperty("reasoning", { effort: "minimal" });
    expect(retryBody).toHaveProperty("max_tokens", 2000);
  });

  it("stops climbing and surfaces the real error when a ladder rung 400s for a reason unrelated to reasoning effort", async () => {
    // Round-2 finding: completeWithLowestSupportedEffort's catch used to
    // advance the ladder on ANY 400, without checking the body was actually
    // about reasoning/effort (unlike the outer isMandatoryReasoningRejection
    // gate used to enter the ladder). If the ladder's own raised max_tokens
    // allowance pushed a request over the model's hard token ceiling, that
    // unrelated 400 got misread as "this effort is unsupported" and burned
    // every remaining rung on requests that could never succeed, then
    // reported the wrong (last, unrelated) error instead of the real one.
    cfg.model = "hard-ceiling-model";
    const notReasoningRelated = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () =>
        Promise.resolve(
          '{"error":{"message":"This model\'s maximum context length is 4096 tokens"}}',
        ),
    };
    const fn = vi
      .fn()
      // probe: disableReasoning -> rejected as mandatory
      .mockResolvedValueOnce(rejectedReasoning("disabled"))
      // first ladder rung's raised max_tokens trips an unrelated 400.
      .mockResolvedValueOnce(notReasoningRelated);
    global.fetch = fn as unknown as typeof fetch;

    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500, maxAttempts: 1 }),
    );

    expect(err.message).toContain("maximum context length is 4096 tokens");
    // Exactly the probe + the one doomed rung — never climbs the remaining
    // three rungs on a request that could never succeed.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("persists a learned mandatory-reasoning model AND its verified working effort to disk, so the next process skips the probe round trip", async () => {
    cfg.model = "mandatory-reasoning-model-3";
    const ok = {
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }),
    };
    const rejected = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () => Promise.resolve('{"error":{"message":"reasoning cannot be disabled"}}'),
    };
    const firstProcessFetch = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(ok);
    global.fetch = firstProcessFetch as unknown as typeof fetch;
    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
    expect(firstProcessFetch).toHaveBeenCalledTimes(2);

    // Simulate a fresh process: reset the module registry and re-import
    // client.ts so its module-level Map is rebuilt from scratch, reading
    // only what was persisted to disk by the call above.
    vi.resetModules();
    const { complete: completeInFreshProcess } = await import("../src/client.ts");
    const secondProcessFetch = vi.fn().mockResolvedValue(ok);
    global.fetch = secondProcessFetch as unknown as typeof fetch;
    await completeInFreshProcess({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
    // No probe 400 this time — the fresh process already knew from disk,
    // including which effort actually worked ("minimal" — the first rung).
    expect(secondProcessFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((secondProcessFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toHaveProperty("reasoning", { effort: "minimal" });
  });

  it("discards a pre-correction persisted file (bare array of model names, no verified effort) instead of trusting an unverified default", async () => {
    // #586 round-1's rejected shape wrote `["model-a", "model-b"]` — a set
    // with no effort recorded, implicitly paired with the single hardcoded
    // "low" that 400s on real mandatory models. Loading that shape today
    // must not silently coerce it into "assume low works"; it must be
    // treated the same as never having seen the model, i.e. re-probed.
    const { configDir } = await import("@oneshot-gtm/core");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mandatory-reasoning-models.json"),
      JSON.stringify(["legacy-array-model"]),
    );

    vi.resetModules();
    const { complete: completeAfterLegacyFile } = await import("../src/client.ts");
    cfg.model = "legacy-array-model";
    const ok = {
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }),
    };
    const rejected = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () => Promise.resolve('{"error":{"message":"reasoning cannot be disabled"}}'),
    };
    const fn = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(ok);
    global.fetch = fn as unknown as typeof fetch;

    await completeAfterLegacyFile({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
    // Re-probed from scratch (disableReasoning first, then the ladder) —
    // NOT skipped straight to a remembered-but-never-verified "low".
    expect(fn).toHaveBeenCalledTimes(2);
    const bodies = fn.mock.calls.map(([, init]) =>
      JSON.parse((init as RequestInit).body as string),
    );
    expect(bodies[0]).toHaveProperty("reasoning", { enabled: false });
    expect(bodies[1]).toHaveProperty("reasoning", { effort: "minimal" });
  });

  it("does not swallow an unrelated 400 as a reasoning rejection", async () => {
    cfg.model = "other-model";
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: () => Promise.resolve('{"error":{"message":"invalid messages"}}'),
    });
    global.fetch = fn as unknown as typeof fetch;
    const err = await errorFrom(
      complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500, maxAttempts: 1 }),
    );
    expect(err.message).toContain("openrouter 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("sends no reasoning parameter to the OpenAI API, which rejects unknown fields", async () => {
    cfg.provider = "openai";
    const fetchMock = respondWith({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { completion_tokens: 2 },
    });
    await complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 500 });
    expect(requestOf(fetchMock).body).not.toHaveProperty("reasoning");
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

describe("outbound prompt assembly", () => {
  it.each(["openrouter", "anthropic"] as const)(
    "does not duplicate the selected humanizer for %s",
    async (provider) => {
      cfg.provider = provider;
      const { loadPrompt } = await import("../src/prompts.ts");
      const system = loadPrompt("repo-interest-followup", { humanizer: "followup" });
      const fetchMock = respondWith(
        provider === "anthropic"
          ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
          : { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
      );
      await complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Prior email context" },
        ],
      });
      const body = requestOf(fetchMock).body;
      const sent =
        provider === "anthropic"
          ? body.system
          : (body.messages as Array<{ role: string; content: string }>)[0]!.content;
      expect(sent).toBe(system);
      expect(String(sent).match(/# Anti-AI-slop rules/g)).toHaveLength(1);
      expect(sent).not.toContain("## The 4-step shape");
    },
  );
});
