import { beforeEach, describe, expect, it, vi } from "vitest";

const webReadMock = vi.fn();
const completeMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, webRead: webReadMock, logEvent: () => {}, startRun: () => {} };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, complete: completeMock, loadPrompt: () => "system prompt" };
});

const { deriveBriefRoute } = await import("../src/api/derive-brief.ts");

function post(body: unknown): Request {
  return new Request("http://localhost/api/setup/derive-brief", {
    method: "POST",
    headers: { host: "127.0.0.1:3030", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  webReadMock.mockResolvedValue({
    result: { markdown: "x".repeat(200), cost: 0.01 },
  });
  completeMock.mockResolvedValue({ content: "the derived brief" });
});

describe("deriveBriefRoute", () => {
  it("reads each source, sums cost, returns the proposal", async () => {
    const res = await deriveBriefRoute(post({ urls: ["acme.com", "github.com/acme/acme"] }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      proposedBrief: string;
      sourceUrls: string[];
      skipped: unknown[];
      costUsd: number;
    };
    expect(out.proposedBrief).toBe("the derived brief");
    expect(out.sourceUrls).toEqual(["https://acme.com/", "https://github.com/acme/acme"]);
    expect(out.skipped).toEqual([]);
    expect(out.costUsd).toBeCloseTo(0.02);
    expect(webReadMock).toHaveBeenCalledTimes(2);
  });

  it("reports unreadable sources in `skipped` instead of failing the derive", async () => {
    webReadMock
      .mockResolvedValueOnce({ result: { markdown: "y".repeat(200), cost: 0.01 } })
      .mockRejectedValueOnce(new Error("timeout"));
    const res = await deriveBriefRoute(post({ urls: ["acme.com", "dead.example"] }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { sourceUrls: string[]; skipped: Array<{ url: string }> };
    expect(out.sourceUrls).toEqual(["https://acme.com/"]);
    expect(out.skipped).toHaveLength(1);
  });

  it("422s when no source could be read", async () => {
    webReadMock.mockRejectedValue(new Error("down"));
    const res = await deriveBriefRoute(post({ urls: ["acme.com"] }));
    expect(res.status).toBe(422);
  });

  it("400s on no urls and on too many", async () => {
    expect((await deriveBriefRoute(post({ urls: [] }))).status).toBe(400);
    expect(
      (
        await deriveBriefRoute(
          post({ urls: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"] }),
        )
      ).status,
    ).toBe(400);
  });

  it("skips invalid URLs (localhost, bare words) without reading them", async () => {
    const res = await deriveBriefRoute(post({ urls: ["localhost", "acme.com"] }));
    const out = (await res.json()) as { sourceUrls: string[]; skipped: Array<{ url: string }> };
    expect(out.sourceUrls).toEqual(["https://acme.com/"]);
    expect(out.skipped[0]?.url).toBe("localhost");
    expect(webReadMock).toHaveBeenCalledTimes(1);
  });
});
