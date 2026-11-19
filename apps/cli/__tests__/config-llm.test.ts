import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prompts from "prompts";
import { loadConfig, saveConfig } from "@oneshot-gtm/core";
import { configLlm } from "../src/commands/config.ts";
import { isHttpUrl } from "../src/commands/init.ts";

// `config llm`: flags answer their question, the proxy asks for its address
// and key, its models come from /v1/models, and the fallback is optional.

const fetchMock = vi.fn();
const base = loadConfig();

beforeEach(() => {
  const { llmBaseUrl: _b, llmFallback: _f, ...rest } = base;
  saveConfig({ ...rest, llmProvider: "openrouter", llmModel: "vendor/model" });
  process.env["LLM_PROXY_API_KEY"] = "proxy-key";
  delete process.env["OPENAI_API_KEY"];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["LLM_PROXY_API_KEY"];
});

describe("config llm", () => {
  it("sets a proxy and a fallback from flags without asking", async () => {
    await configLlm({
      provider: "proxy",
      model: "claude-sonnet-5-5",
      baseUrl: " http://127.0.0.1:8317 ",
      fallbackProvider: "openrouter",
      fallbackModel: "vendor/model",
    });
    expect(loadConfig()).toMatchObject({
      llmProvider: "proxy",
      llmModel: "claude-sonnet-5-5",
      llmBaseUrl: "http://127.0.0.1:8317",
      llmFallback: { provider: "openrouter", model: "vendor/model" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--no-fallback removes the fallback and keeps the rest", async () => {
    saveConfig({ ...loadConfig(), llmFallback: { provider: "openai", model: "gpt-5" } });
    await configLlm({ provider: "openrouter", model: "vendor/model", fallback: false });
    expect("llmFallback" in loadConfig()).toBe(false);
  });

  it("refuses a bad flag value and a fallback on the main provider", async () => {
    await expect(configLlm({ provider: "bogus", model: "m" })).rejects.toThrow(/--provider/);
    await expect(
      configLlm({ provider: "proxy", model: "m", baseUrl: "127.0.0.1:8317" }),
    ).rejects.toThrow(/--base-url/);
    await expect(
      configLlm({ provider: "openai", model: "m", fallbackProvider: "openai", fallbackModel: "m" }),
    ).rejects.toThrow(/must differ/);
    await expect(configLlm({ provider: "openai", model: "m", fallbackModel: "m" })).rejects.toThrow(
      /--fallback-provider/,
    );
    expect(loadConfig().llmProvider).toBe("openrouter");
  });

  it("asks for the proxy's address and key, then picks a model the proxy lists", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: "gpt-5" }, { id: "claude-a" }] }));
    // provider, address, key, model, fallback: none
    prompts.inject(["proxy", "http://127.0.0.1:8317", "new-key", "gpt-5", ""]);
    await configLlm();
    expect(loadConfig()).toMatchObject({
      llmProvider: "proxy",
      llmModel: "gpt-5",
      llmBaseUrl: "http://127.0.0.1:8317",
    });
    expect("llmFallback" in loadConfig()).toBe(false);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8317/v1/models");
    // The key typed now is the one the list is asked with.
    expect(init.headers).toMatchObject({ authorization: "Bearer new-key" });
    expect(process.env["LLM_PROXY_API_KEY"]).toBe("new-key");
  });

  it("falls back to a typed model when the proxy cannot list, and takes a fallback", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    prompts.inject(["proxy", "http://127.0.0.1:8317", "", "my-model", "openai", "gpt-5"]);
    await configLlm();
    expect(loadConfig()).toMatchObject({
      llmProvider: "proxy",
      llmModel: "my-model",
      llmFallback: { provider: "openai", model: "gpt-5" },
    });
  });
});

describe("isHttpUrl", () => {
  it("takes plain http(s) URLs only", () => {
    expect(isHttpUrl("http://127.0.0.1:8317")).toBe(true);
    expect(isHttpUrl(" https://proxy.example.com/v1 ")).toBe(true);
    for (const bad of ["", "127.0.0.1:8317", "ftp://example.com", "http://x/?a=1", "http://x/#f"])
      expect(isHttpUrl(bad)).toBe(false);
  });
});
