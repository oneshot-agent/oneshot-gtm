import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The proxy provider and the fallback: a proxy without its address or key
// fails, then `/v1/models` is probed. A proxy that does not answer is a
// fail, or a warn when a fallback with a key would take the calls.

let cfgOverride: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }),
    linkedInProfileReadBlocker: () => "none",
    oneshotEnvReady: () => false,
    getBalance: async () => ({ balance: "1 USDC", raw: "1 USDC" }),
    getLedger: () => ({
      bounceStatsByIdentity: () => new Map(),
      countEmailSendsSince: () => 0,
      latestCanaryResult: () => null,
      listTriggers: () => [],
      listReceipts: () => [],
    }),
  };
});

const { runDoctor, resetLlmProbeCacheForTests } = await import("../src/check.ts");
const { createWorkspace } = await import("@oneshot-gtm/core");

const KEYS = ["LLM_PROXY_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"] as const;
const fetchMock = vi.fn();
let wsDir: string;
beforeEach(() => {
  wsDir = mkdtempSync(join(tmpdir(), "oneshot-doctor-llm-"));
  process.env["ONESHOT_GTM_WORKSPACES"] = wsDir;
  process.env["ONESHOT_GTM_WORKSPACE"] = "alpha";
  createWorkspace("alpha");
  cfgOverride = {
    llmProvider: "proxy",
    llmModel: "claude-sonnet-5-5",
    llmBaseUrl: "http://127.0.0.1:8317",
  };
  for (const k of KEYS) delete process.env[k];
  process.env["LLM_PROXY_API_KEY"] = "proxy-key";
  resetLlmProbeCacheForTests();
  fetchMock.mockReset();
  // Only the proxy probe is answered here; any other doctor fetch fails fast.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("http://127.0.0.1:8317")
      ? fetchMock(url, init)
      : Promise.reject(new Error("offline")),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["ONESHOT_GTM_WORKSPACES"];
  delete process.env["ONESHOT_GTM_WORKSPACE"];
  for (const k of KEYS) delete process.env[k];
  rmSync(wsDir, { recursive: true, force: true });
});

async function check(name: string) {
  return (await runDoctor()).find((r) => r.name === name);
}

describe("doctor: llm proxy", () => {
  it("ok when the proxy lists its models", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: "a" }, { id: "b" }] }));
    const proxy = await check("llm proxy");
    expect(proxy).toMatchObject({ severity: "ok", message: "http://127.0.0.1:8317 · 2 models" });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8317/v1/models");
    expect(init.headers).toMatchObject({ authorization: "Bearer proxy-key" });
    expect((await check("llm key (proxy)"))?.severity).toBe("ok");
  });

  it("fails without the address or the key, and does not probe", async () => {
    cfgOverride.llmBaseUrl = undefined;
    expect(await check("llm proxy")).toMatchObject({
      severity: "fail",
      message: expect.stringMatching(/llmBaseUrl/),
    });
    cfgOverride.llmBaseUrl = "http://127.0.0.1:8317";
    delete process.env["LLM_PROXY_API_KEY"];
    expect(await check("llm proxy")).toMatchObject({
      severity: "fail",
      message: "LLM_PROXY_API_KEY not set",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the proxy is down and there is no usable fallback", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await check("llm proxy")).toMatchObject({
      severity: "fail",
      message: expect.stringMatching(/is unreachable/),
    });
  });

  it("warns when the proxy is down but a fallback with a key takes the calls", async () => {
    cfgOverride.llmFallback = { provider: "openrouter", model: "vendor/model" };
    process.env["OPENROUTER_API_KEY"] = "or-key";
    fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
    const results = await runDoctor();
    expect(results.find((r) => r.name === "llm proxy")).toMatchObject({
      severity: "warn",
      message: expect.stringMatching(/refused the key .*fallback \(openrouter\)/),
    });
    expect(results.find((r) => r.name === "llm fallback")).toMatchObject({
      severity: "ok",
      message: "openrouter / vendor/model",
    });
  });

  it("a fallback whose key is missing warns and does not soften a proxy failure", async () => {
    cfgOverride.llmFallback = { provider: "openai", model: "gpt-5" };
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const results = await runDoctor();
    expect(results.find((r) => r.name === "llm fallback")).toMatchObject({
      severity: "warn",
      message: expect.stringMatching(/OPENAI_API_KEY not set/),
    });
    expect(results.find((r) => r.name === "llm proxy")?.severity).toBe("fail");
  });

  it("has no proxy or fallback line for a plain provider", async () => {
    cfgOverride = { llmProvider: "openrouter", llmModel: "m" };
    const results = await runDoctor();
    expect(results.some((r) => r.name === "llm proxy" || r.name === "llm fallback")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a proxy used only as the fallback warns, never fails, when it is down", async () => {
    cfgOverride = {
      llmProvider: "openrouter",
      llmModel: "m",
      llmBaseUrl: "http://127.0.0.1:8317",
      llmFallback: { provider: "proxy", model: "claude-sonnet-5-5" },
    };
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect((await check("llm proxy"))?.severity).toBe("warn");
  });
});
