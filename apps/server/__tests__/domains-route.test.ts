import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resumeMock = vi.fn();
const pauseMock = vi.fn();

// Mock the core wrappers — the route's job is request validation + status
// mapping, not the live SDK call (covered by the wrappers themselves).
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    resumeSendingDomain: (domain: string) => resumeMock(domain),
    pauseSendingDomain: (domain: string) => pauseMock(domain),
  };
});

const { resumeDomainRoute, pauseDomainRoute } = await import("../src/api/domains.ts");

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/domains/resume", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resumeMock.mockReset();
  pauseMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("resumeDomainRoute", () => {
  it("400s on invalid JSON", async () => {
    const res = await resumeDomainRoute(jsonReq("{not-json"));
    expect(res.status).toBe(400);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("400s when domain is missing / blank", async () => {
    expect((await resumeDomainRoute(jsonReq({}))).status).toBe(400);
    expect((await resumeDomainRoute(jsonReq({ domain: "   " }))).status).toBe(400);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("normalizes (trim+lowercase) and returns the new pool status on success", async () => {
    resumeMock.mockResolvedValue({ domain: "acme.com", pool_status: "active" });
    const res = await resumeDomainRoute(jsonReq({ domain: "  ACME.com " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: "acme.com", poolStatus: "active" });
    expect(resumeMock).toHaveBeenCalledWith("acme.com");
  });

  it("maps a platform 5xx to 502 with the OneShot status folded into the message", async () => {
    resumeMock.mockRejectedValue(
      Object.assign(new Error("Failed to resume domain"), { statusCode: 500 }),
    );
    const res = await resumeDomainRoute(jsonReq({ domain: "acme.com" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: /Failed to resume domain \(OneShot HTTP 500\)/ });
  });

  it("passes a client 4xx (bad/unowned domain) through as 4xx, not 502", async () => {
    resumeMock.mockRejectedValue(
      Object.assign(new Error("domain not owned"), { statusCode: 404 }),
    );
    const res = await resumeDomainRoute(jsonReq({ domain: "notmine.com" }));
    expect(res.status).toBe(404);
  });

  it("defaults to 502 when the error carries no statusCode (e.g. network)", async () => {
    resumeMock.mockRejectedValue(new Error("fetch failed"));
    const res = await resumeDomainRoute(jsonReq({ domain: "acme.com" }));
    expect(res.status).toBe(502);
  });
});

describe("pauseDomainRoute", () => {
  it("returns the paused status on success", async () => {
    pauseMock.mockResolvedValue({ domain: "acme.com", pool_status: "paused" });
    const res = await pauseDomainRoute(jsonReq({ domain: "acme.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: "acme.com", poolStatus: "paused" });
    expect(pauseMock).toHaveBeenCalledWith("acme.com");
  });
});
