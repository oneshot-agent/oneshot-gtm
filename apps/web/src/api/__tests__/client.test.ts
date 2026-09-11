import { describe, expect, it, vi, afterEach } from "vitest";
import { api } from "../client";

const originalFetch = global.fetch;

// vi.fn() is a Mock, not the full `typeof fetch` (which carries `preconnect`),
// so assigning it to global.fetch fails typecheck. Cast in one place.
function mockFetch(response: Partial<Response>): void {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("api client getJson handling", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetAllMocks();
  });

  it("surfaces JSON { error } body on 409", async () => {
    mockFetch({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve(JSON.stringify({ error: "Missing config field" })),
    });

    await expect(api.home()).rejects.toThrow("Missing config field");
  });

  it("falls back to status string on non-JSON body", async () => {
    mockFetch({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("Plain text error from server"),
    });

    await expect(api.home()).rejects.toThrow("400 Bad Request: /home");
  });

  it("falls back to status string on empty body", async () => {
    mockFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve(""),
    });

    await expect(api.home()).rejects.toThrow("401 Unauthorized: /home");
  });

  it("falls back to status string on network-like failure without valid JSON", async () => {
    mockFetch({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: () => Promise.reject(new Error("Network connection closed")),
    });

    await expect(api.home()).rejects.toThrow("502 Bad Gateway: /home");
  });
});

describe("reject body shapes", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function okJson(body: unknown): void {
    mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    });
  }
  const sentBody = (): unknown => {
    const call = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    return JSON.parse((call[1] as RequestInit).body as string);
  };

  it("omits `reason` when undefined, sends it verbatim otherwise — including empty", async () => {
    okJson({ ok: true });
    await api.rejectQueue(7);
    expect(sentBody()).toEqual({});
    okJson({ ok: true });
    await api.rejectQueue(7, "");
    expect(sentBody()).toEqual({ reason: "" });
    okJson({ ok: true });
    await api.rejectQueue(7, "wrong stage");
    expect(sentBody()).toEqual({ reason: "wrong stage" });
  });

  it("asks the reject-reason endpoint with an empty body", async () => {
    okJson({ reason: null, source: null });
    expect(await api.suggestRejectReason(7)).toEqual({ reason: null, source: null });
    const call = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(String(call[0])).toMatch(/\/queue\/7\/reject-reason$/);
  });
});
