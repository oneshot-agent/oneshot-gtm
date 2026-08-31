import { describe, expect, it, vi, afterEach } from "vitest";
import { api } from "../client";

const originalFetch = global.fetch;

describe("api client getJson handling", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetAllMocks();
  });

  it("surfaces JSON { error } body on 409", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve(JSON.stringify({ error: "Missing config field" })),
    });

    await expect(api.home()).rejects.toThrow("Missing config field");
  });

  it("falls back to status string on non-JSON body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () => Promise.resolve("Plain text error from server"),
    });

    await expect(api.home()).rejects.toThrow("400 Bad Request: /home");
  });

  it("falls back to status string on empty body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve(""),
    });

    await expect(api.home()).rejects.toThrow("401 Unauthorized: /home");
  });

  it("falls back to status string on network-like failure without valid JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: () => Promise.reject(new Error("Network connection closed")),
    });

    await expect(api.home()).rejects.toThrow("502 Bad Gateway: /home");
  });
});
