import { describe, expect, it } from "vitest";
import { buildFetchHandler } from "../src/server.ts";

// Every mutating /api call must come from a loopback page or from no page at
// all. CORS only hides a response from a cross-site page; a simple POST still
// runs. The handler refuses on the Origin the browser stamps, before dispatch.

const handler = buildFetchHandler();
const post = (headers: Record<string, string>) =>
  handler(
    new Request("http://127.0.0.1:3030/api/cadences/1/skip-mail?play=post-funding", {
      method: "POST",
      headers: { host: "127.0.0.1:3030", ...headers },
    }),
  );

describe("cross-site request guard", () => {
  it("refuses a mutating call from a non-loopback page", async () => {
    const res = await post({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("cross-site");
  });

  it("refuses when the browser says the request is cross-site", async () => {
    const res = await post({ origin: "http://localhost:5173", "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("lets a loopback page and a page-less client through to the route", async () => {
    // The route itself answers 404 (no ledger row in this test) — the point is
    // that the guard did not answer 403.
    const cases: Array<Record<string, string>> = [{ origin: "http://localhost:5173" }, {}];
    for (const headers of cases) {
      const res = await post(headers);
      expect(res.status).not.toBe(403);
    }
  });

  it("never touches reads", async () => {
    const res = await handler(
      new Request("http://127.0.0.1:3030/api/health", {
        headers: { host: "127.0.0.1:3030", origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(200);
  });
});
