import { beforeEach, describe, expect, it, vi } from "vitest";

// The LinkedIn connect routes: the cookie import refuses without a stored
// cookie and never echoes it; the hosted login returns its live URL on start
// and the verified outcome on finish; a platform failure maps to 502.

let cookieSource: "env" | "file" | null = "file";
const cookieMock = vi.fn();
const startMock = vi.fn();
const finishMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    secretSource: (key: string) => (key === "LINKEDIN_SESSION_COOKIE" ? cookieSource : null),
  };
});
vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  return {
    ...actual,
    connectLinkedInWithCookie: cookieMock,
    startLinkedInLogin: startMock,
    finishLinkedInLogin: finishMock,
  };
});

const { linkedinSessionRoute, linkedinLoginStartRoute, linkedinLoginFinishRoute } =
  await import("../src/api/setup.ts");

function post(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: "{}",
  });
}

const outcome = {
  loggedIn: true,
  name: "Founder",
  profileId: "prof_1",
  costUsd: 0.012,
};

beforeEach(() => {
  cookieSource = "file";
  cookieMock.mockReset();
  startMock.mockReset();
  finishMock.mockReset();
  process.env["LINKEDIN_SESSION_COOKIE"] = "secret-cookie-value";
});

describe("linkedinSessionRoute (cookie import)", () => {
  it("400s when no cookie is stored, without calling the platform", async () => {
    cookieSource = null;
    const res = await linkedinSessionRoute(post("/api/setup/linkedin-session"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /paste the LinkedIn session cookie/,
    );
    expect(cookieMock).not.toHaveBeenCalled();
  });

  it("returns the verified outcome and never the cookie", async () => {
    cookieMock.mockResolvedValue(outcome);
    const res = await linkedinSessionRoute(post("/api/setup/linkedin-session"));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, ...outcome, reason: null });
    expect(typeof body["checkedAt"]).toBe("string");
    expect(text).not.toContain("secret-cookie-value");
    expect(cookieMock).toHaveBeenCalledWith(expect.objectContaining({ playName: "setup" }));
  });

  it("maps a platform failure to 502 with a bounded message", async () => {
    cookieMock.mockRejectedValue(new Error("x".repeat(500)));
    const res = await linkedinSessionRoute(post("/api/setup/linkedin-session"));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toHaveLength(300);
  });
});

describe("linkedinLoginStartRoute / linkedinLoginFinishRoute (hosted login)", () => {
  it("start returns the live URL to log in through", async () => {
    startMock.mockResolvedValue({
      profileId: "prof_1",
      liveUrl: "https://live.example/s",
      status: "idle",
      expiresAt: "2026-09-14T10:15:00.000Z",
    });
    const res = await linkedinLoginStartRoute(post("/api/setup/linkedin-login/start"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      profileId: "prof_1",
      liveUrl: "https://live.example/s",
      status: "idle",
      expiresAt: "2026-09-14T10:15:00.000Z",
    });
  });

  it("finish returns the outcome, with the reason when the login did not take", async () => {
    finishMock.mockResolvedValue({
      ...outcome,
      loggedIn: false,
      name: null,
      reason: "the login did not complete — LinkedIn stored no session cookie",
    });
    const res = await linkedinLoginFinishRoute(post("/api/setup/linkedin-login/finish"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      loggedIn: false,
      reason: expect.stringMatching(/did not complete/),
    });
  });

  it("a platform failure on either step is a 502", async () => {
    startMock.mockRejectedValue(new Error("Browser profile setup failed"));
    expect((await linkedinLoginStartRoute(post("/api/setup/linkedin-login/start"))).status).toBe(
      502,
    );
    finishMock.mockRejectedValue(new Error("no LinkedIn login in progress"));
    expect((await linkedinLoginFinishRoute(post("/api/setup/linkedin-login/finish"))).status).toBe(
      502,
    );
  });
});
