import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.ts";
import { LlmSection } from "../src/components/setup/LlmSection.tsx";
import { llmCaption, llmKeyInUse } from "../src/components/setup/CredentialsSection.tsx";
import {
  loadedFor,
  loadProxyModels,
  proxyModelsRequest,
  ProxyModelPicker,
  type ProxyModels,
} from "../src/components/setup/ProxyModelField.tsx";
import type { SetupCfg } from "../src/components/setup/types.ts";
import {
  fallbackAfterPicking,
  llmSectionErrors,
  llmSectionRequest,
  llmSectionValues,
} from "../src/lib/llmSettings.ts";

// The /setup LLM section: the proxy provider, its model list, and the fallback.

const noop = () => {};
const cfg = (over: Partial<SetupCfg>): SetupCfg =>
  ({ llmProvider: "openrouter", llmModel: "anthropic/claude-sonnet-5.5", ...over }) as SetupCfg;
const render = (c: SetupCfg) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <LlmSection cfg={c} sources={{}} onDirtyChange={noop} />
    </QueryClientProvider>,
  );
const picker = (loaded: ProxyModels | null, value = "") =>
  renderToStaticMarkup(
    <ProxyModelPicker
      value={value}
      onChange={noop}
      loaded={loaded}
      loading={false}
      canLoad
      onLoad={noop}
    />,
  );

afterEach(() => vi.restoreAllMocks());

describe("LlmSection", () => {
  it("shows the endpoint, the proxy key and a loadable model field when proxy is picked", () => {
    const html = render(
      cfg({
        llmProvider: "proxy",
        llmModel: "claude-sonnet-5-5",
        llmBaseUrl: "http://127.0.0.1:8317",
      }),
    );
    expect(html).toContain("Your own proxy (CLIProxyAPI or similar)");
    expect(html).toContain("Endpoint URL");
    expect(html).toContain('value="http://127.0.0.1:8317"');
    expect(html).toContain("Proxy key");
    expect(html).toContain("Load models");
    expect(html).toContain('value="claude-sonnet-5-5"');
  });

  it("hides the proxy fields for a hosted provider, and offers every other provider as fallback", () => {
    const html = render(cfg({}));
    expect(html).not.toContain("Endpoint URL");
    expect(html).not.toContain("Load models");
    expect(html).toContain("If this provider is down, use…");
    const fallback = html.slice(html.indexOf("If this provider is down"));
    expect(fallback).toContain('<option value="" selected="">None</option>');
    expect(fallback).not.toContain('value="openrouter"');
    expect(fallback).toContain('value="proxy"');
  });

  it("shows the fallback model and the endpoint when the fallback is the proxy", () => {
    const html = render(
      cfg({
        llmBaseUrl: "http://127.0.0.1:8317",
        llmFallback: { provider: "proxy", model: "gpt-6.1-sol" },
      }),
    );
    expect(html).toContain("Endpoint URL");
    expect(html).toContain("Fallback model");
    expect(html).toContain('value="gpt-6.1-sol"');
  });
});

describe("proxy model list", () => {
  it("fills the dropdown from llmModels, sending the typed URL and key in the body", async () => {
    const spy = vi
      .spyOn(api, "llmModels")
      .mockResolvedValue({ models: ["claude-sonnet-5-5", "gpt-6.1-sol", "gpt-6.1-sol"] });
    const loaded = await loadProxyModels({ baseUrl: " http://127.0.0.1:8317 ", key: "sk-test" });
    expect(spy).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:8317", key: "sk-test" });
    expect(loaded).toEqual({ models: ["claude-sonnet-5-5", "gpt-6.1-sol"] });
    const html = picker(loaded, "gpt-6.1-sol");
    expect(html).toContain("<select");
    expect(html).toContain('<option value="claude-sonnet-5-5">');
    expect(html).toContain('<option value="gpt-6.1-sol" selected="">');
    expect(html).toContain("Custom model…");
    expect(html).toContain("Reload");
  });

  it("shows a list only for the endpoint and key that loaded it", () => {
    const a = proxyModelsRequest(" http://127.0.0.1:8317 ", "sk-a");
    const loaded = { request: a, result: { models: ["m"] } };
    expect(loadedFor(loaded, proxyModelsRequest("http://127.0.0.1:8317", " sk-a"))).toEqual({
      models: ["m"],
    });
    expect(loadedFor(loaded, proxyModelsRequest("https://proxy.example.com", "sk-a"))).toBeNull();
    expect(loadedFor(loaded, proxyModelsRequest("http://127.0.0.1:8317", "sk-b"))).toBeNull();
    expect(loadedFor(loaded, proxyModelsRequest("http://127.0.0.1:8317"))).toBeNull();
    expect(loadedFor(null, a)).toBeNull();
  });

  it("leaves a blank key out so the server uses the saved one", async () => {
    const spy = vi.spyOn(api, "llmModels").mockResolvedValue({ models: ["m"] });
    await loadProxyModels({ baseUrl: "http://127.0.0.1:8317", key: "  " });
    expect(spy).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:8317" });
  });

  it("keeps a saved id the list lacks selectable", () => {
    const html = picker({ models: ["claude-sonnet-5-5"] }, "old-model");
    expect(html).toContain('<option value="old-model" selected="">');
  });

  it("falls back to free text with the error inline when loading fails", async () => {
    vi.spyOn(api, "llmModels").mockRejectedValue(new Error("The proxy refused the key."));
    const loaded = await loadProxyModels({ baseUrl: "http://127.0.0.1:8317" });
    expect(loaded).toEqual({ error: "The proxy refused the key." });
    const html = picker(loaded, "typed-model");
    expect(html).not.toContain("<select");
    expect(html).toContain('value="typed-model"');
    expect(html).toContain("couldn&#x27;t load models · The proxy refused the key.");
  });

  it("treats an empty list as a failure", async () => {
    vi.spyOn(api, "llmModels").mockResolvedValue({ models: [] });
    expect(await loadProxyModels({ baseUrl: "http://127.0.0.1:8317" })).toEqual({
      error: "the proxy lists no models",
    });
  });
});

describe("LLM section request", () => {
  const base = llmSectionValues(cfg({}));

  it("carries llmBaseUrl, the model and the proxy key", () => {
    const values = {
      ...base,
      llmProvider: "proxy" as const,
      llmModel: "claude-sonnet-5-5",
      llmBaseUrl: " http://127.0.0.1:8317 ",
      proxyKey: "sk-test",
    };
    expect(
      llmSectionRequest(values, {
        llmProvider: "proxy",
        llmModel: "claude-sonnet-5-5",
        llmBaseUrl: values.llmBaseUrl,
        proxyKey: "sk-test",
      }),
    ).toEqual({
      llmProvider: "proxy",
      llmModel: "claude-sonnet-5-5",
      llmBaseUrl: "http://127.0.0.1:8317",
      secrets: { LLM_PROXY_API_KEY: "sk-test" },
    });
    expect(llmSectionRequest({ ...values, llmBaseUrl: "" }, { llmBaseUrl: "" })).toEqual({
      llmBaseUrl: null,
    });
  });

  it("leaves out an endpoint edit once neither route uses the proxy", () => {
    const hosted = { ...base, llmProvider: "openai" as const, llmBaseUrl: "localhost:8317" };
    expect(
      llmSectionRequest(hosted, { llmProvider: "openai", llmBaseUrl: "localhost:8317" }),
    ).toEqual({ llmProvider: "openai" });
    expect(llmSectionErrors(hosted).llmBaseUrl).toBeNull();
    const viaFallback = { ...hosted, fallbackProvider: "proxy" as const, fallbackModel: "m" };
    expect(llmSectionRequest(viaFallback, { llmBaseUrl: "http://127.0.0.1:8317" })).toEqual({
      llmBaseUrl: "http://127.0.0.1:8317",
    });
  });

  it("onboarding clears a saved fallback on the provider it picks, and keeps another", () => {
    const fallback = { provider: "proxy" as const, model: "m" };
    expect(fallbackAfterPicking("proxy", fallback)).toEqual({ llmFallback: null });
    expect(fallbackAfterPicking("openai", fallback)).toEqual({});
    expect(fallbackAfterPicking("proxy", undefined)).toEqual({});
  });

  it("sends llmFallback whole when either of its fields changed", () => {
    const values = { ...base, fallbackProvider: "openai" as const, fallbackModel: "gpt-4o-mini" };
    expect(llmSectionRequest(values, { fallbackModel: "gpt-4o-mini" })).toEqual({
      llmFallback: { provider: "openai", model: "gpt-4o-mini" },
    });
    expect(llmSectionRequest(values, {})).toEqual({});
  });

  it("sends null when the fallback is cleared", () => {
    const saved = llmSectionValues(
      cfg({ llmFallback: { provider: "openai", model: "gpt-4o-mini" } }),
    );
    expect(saved.fallbackProvider).toBe("openai");
    const cleared = { ...saved, fallbackProvider: "" as const, fallbackModel: "" };
    expect(llmSectionRequest(cleared, { fallbackProvider: "", fallbackModel: "" })).toEqual({
      llmFallback: null,
    });
  });

  it("blocks Save on the provider picker while the proxy has no URL", () => {
    const proxy = { ...base, llmProvider: "proxy" as const, llmModel: "m" };
    expect(llmSectionErrors(proxy).llmProvider).toBe("enter the proxy's URL");
    expect(llmSectionErrors({ ...proxy, llmBaseUrl: "127.0.0.1:8317" }).llmBaseUrl).toMatch(
      /like http:\/\/127\.0\.0\.1:8317/,
    );
    expect(
      llmSectionErrors({ ...proxy, llmBaseUrl: "http://127.0.0.1:8317" }).llmProvider,
    ).toBeNull();
  });

  it("flags a fallback with no model, or the same provider as the primary", () => {
    const errors = llmSectionErrors({ ...base, fallbackProvider: "openai", fallbackModel: "" });
    expect(errors.fallbackProvider).toBe("enter the fallback's model id");
    expect(errors.fallbackModel).toBe("enter a model id");
    expect(
      llmSectionErrors({ ...base, fallbackProvider: "openrouter", fallbackModel: "x" })
        .fallbackProvider,
    ).toBe("pick a provider other than the one above");
    expect(llmSectionErrors(base).fallbackProvider).toBeNull();
  });
});

describe("LLM credentials", () => {
  it("counts OPENROUTER_API_KEY as in use while a decisions engine runs", () => {
    const proxy = cfg({ llmProvider: "proxy", llmFallback: { provider: "openai", model: "m" } });
    expect(llmKeyInUse(proxy, "OPENROUTER_API_KEY")).toBe(false);
    expect(llmCaption(proxy)).toBe(
      "Only the saved provider's key (proxy) and the fallback's (openai) are read.",
    );
    for (const decisions of [
      { replyClassifier: { engine: "decisions" as const, model: "d" } },
      { offerJudge: { engine: "decisions" as const, model: "d" } },
    ]) {
      const c = { ...proxy, ...decisions } as SetupCfg;
      expect(llmKeyInUse(c, "OPENROUTER_API_KEY")).toBe(true);
      expect(llmKeyInUse(c, "ANTHROPIC_API_KEY")).toBe(false);
      expect(llmCaption(c)).toBe(
        "Only the saved provider's key (proxy), the fallback's (openai) and OpenRouter's (decisions engine) are read.",
      );
    }
    expect(llmCaption(cfg({ offerJudge: { engine: "decisions", model: "d" } }))).toBe(
      "Only the saved provider's key (openrouter) is read.",
    );
  });
});
