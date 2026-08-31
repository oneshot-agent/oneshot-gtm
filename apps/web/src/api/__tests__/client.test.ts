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
