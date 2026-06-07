import { describe, expect, it, vi } from "vitest";

const getRunMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({ getRun: getRunMock }),
  };
});

const { getRunRoute } = await import("../src/api/runs.ts");

function req(): Request {
  return new Request("http://localhost/api/runs/42", {
    headers: { host: "127.0.0.1:3030" },
  });
}

describe("getRunRoute", () => {
  it("400s on a non-numeric id", async () => {
    const res = getRunRoute(req(), { id: "abc" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /bad id/i });
  });

  it("404s when the run is unknown", async () => {
    getRunMock.mockReturnValue(null);
    const res = getRunRoute(req(), { id: "42" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: /not found/i });
  });

  it("returns the parsed RunRecord on success", async () => {
    getRunMock.mockReturnValue({
      id: 42,
      playName: "show-hn",
      dryRun: false,
      status: "done",
      startedAt: "2026-06-06T20:00:00Z",
      completedAt: "2026-06-06T20:02:00Z",
      targetCount: 2,
      draftedCount: 2,
      sentCount: 1,
      errorCount: 0,
      targets: [{ email: "a@x.dev" }, { email: "b@x.dev" }],
      events: [{ kind: "draft", index: 0, subject: "s", body: "b", flags: [] }],
      prospectEmails: ["a@x.dev"],
    });
    const res = getRunRoute(req(), { id: "42" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; status: string; events: unknown[] };
    expect(body.id).toBe(42);
    expect(body.status).toBe("done");
    expect(body.events).toHaveLength(1);
  });
});
