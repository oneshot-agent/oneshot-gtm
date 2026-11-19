import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/setup/llm-models: the /setup model picker for a proxy. It lists
// `/v1/models`, falls back to the saved address and key, maps failures to a
// status, and never puts the key in a response.

let cfgOverride: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }) };
});

const { llmModelsRoute } = await import("../src/api/llm-models.ts");

const fetchMock = vi.fn();

function req(body: unknown): Request {
  return new Request("http://localhost/api/setup/llm-models", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: JSON.stringify(body),
  });
}

async function call(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await llmModelsRoute(req(body));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  cfgOverride = {};
  delete process.env.LLM_PROXY_API_KEY;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LLM_PROXY_API_KEY;
});

describe("POST /api/setup/llm-models", () => {
  it("lists the model ids, sorted and deduped, with the key in both auth headers", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ data: [{ id: "gpt-5" }, { id: "claude-sonnet-5-5" }, { id: "gpt-5" }, {}] }),
    );
    const out = await call({ baseUrl: "http://127.0.0.1:8317/v1/", key: "sk-typed" });
    expect(out).toEqual({ status: 200, json: { models: ["claude-sonnet-5-5", "gpt-5"] } });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8317/v1/models");
    expect(init.headers).toEqual({ authorization: "Bearer sk-typed", "x-api-key": "sk-typed" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the saved address and key when the body leaves them out", async () => {
    cfgOverride = { llmBaseUrl: "http://127.0.0.1:8317" };
    process.env.LLM_PROXY_API_KEY = "sk-saved";
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: "m" }] }));
    expect((await call({})).json).toEqual({ models: ["m"] });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8317/v1/models");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-saved" });
  });

  it("does not send the saved key to an address other than the saved one", async () => {
    cfgOverride = { llmBaseUrl: "http://127.0.0.1:8317" };
    process.env.LLM_PROXY_API_KEY = "sk-saved";
    fetchMock.mockResolvedValue(Response.json({ data: [] }));
    await call({ baseUrl: "https://proxy.example.com" });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.stringify(init.headers)).not.toContain("sk-saved");
  });

  it("passes a 401 through, without the key in the error", async () => {
    fetchMock.mockResolvedValue(new Response("bad key sk-typed", { status: 401 }));
    const out = await call({ baseUrl: "http://127.0.0.1:8317", key: "sk-typed" });
    expect(out.status).toBe(401);
    expect(out.json.error).toMatch(/refused the key/);
    expect(JSON.stringify(out.json)).not.toContain("sk-typed");
  });

  it("answers 502 when the proxy is unreachable or sends no list", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const down = await call({ baseUrl: "http://127.0.0.1:8317", key: "sk-typed" });
    expect(down.status).toBe(502);
    expect(down.json.error).toMatch(/http:\/\/127\.0\.0\.1:8317 is unreachable/);
    fetchMock.mockResolvedValue(Response.json({ models: [] }));
    expect((await call({ baseUrl: "http://127.0.0.1:8317" })).status).toBe(502);
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    expect((await call({ baseUrl: "http://127.0.0.1:8317" })).status).toBe(502);
  });

  it("answers 400 with no address, or one that is not an http(s) URL", async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ baseUrl: "ftp://127.0.0.1" })).status).toBe(400);
    const plain = await call({ baseUrl: "http://proxy.example.com:8317", key: "k" });
    expect(plain.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
