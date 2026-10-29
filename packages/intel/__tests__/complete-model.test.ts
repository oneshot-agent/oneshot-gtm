import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A caller may name the model for one call (the offer writer's fallback);
// every other call stays on `cfg.llmModel`.

const events = vi.hoisted(() => [] as Array<{ event: string; data: Record<string, unknown> }>);

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      llmProvider: "openrouter" as const,
      llmModel: "main/writer-model",
    }),
    logEvent: (event: string, data: Record<string, unknown>) => {
      events.push({ event, data });
    },
  };
});

const { complete } = await import("../src/client.ts");

const realFetch = global.fetch;

function okFetch() {
  const fn = vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
    }),
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function sentModel(fn: ReturnType<typeof vi.fn>): unknown {
  const [, init] = fn.mock.calls[0] as [string, RequestInit];
  return (JSON.parse(init.body as string) as { model?: unknown }).model;
}

function loggedModel(event: string): unknown {
  return events.find((e) => e.event === event)?.data["model"];
}

describe("complete() model per call", () => {
  beforeEach(() => {
    events.length = 0;
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("dispatches and logs the model the call names, on the configured provider", async () => {
    const fn = okFetch();
    const res = await complete({
      messages: [{ role: "user", content: "write" }],
      model: "fallback/strong-model",
    });
    expect(sentModel(fn)).toBe("fallback/strong-model");
    expect(fn.mock.calls[0]![0]).toContain("openrouter.ai");
    expect(res.model).toBe("fallback/strong-model");
    expect(loggedModel("llm.start")).toBe("fallback/strong-model");
    expect(loggedModel("llm.done")).toBe("fallback/strong-model");
  });

  it("stays on cfg.llmModel when the call names no model, or a blank one", async () => {
    for (const model of [undefined, "  "]) {
      events.length = 0;
      const fn = okFetch();
      const res = await complete({
        messages: [{ role: "user", content: "write" }],
        ...(model !== undefined ? { model } : {}),
      });
      expect(sentModel(fn)).toBe("main/writer-model");
      expect(res.model).toBe("main/writer-model");
      expect(loggedModel("llm.start")).toBe("main/writer-model");
      expect(loggedModel("llm.done")).toBe("main/writer-model");
    }
  });
});
