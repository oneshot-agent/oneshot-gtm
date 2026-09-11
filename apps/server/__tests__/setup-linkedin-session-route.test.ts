import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/setup/linkedin-session: refuses without a stored cookie, reports
// the seeding outcome, maps a platform failure to 502, and never echoes the
// cookie.

let cookieSource: "env" | "file" | null = "file";
const seedMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    secretSource: (key: string) => (key === "LINKEDIN_SESSION_COOKIE" ? cookieSource : null),
  };
});
vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  return { ...actual, seedLinkedInSession: seedMock };
});

const { linkedinSessionRoute } = await import("../src/api/setup.ts");

function post(): Request {
  return new Request("http://localhost/api/setup/linkedin-session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: "{}",
  });
}

beforeEach(() => {
  cookieSource = "file";
  seedMock.mockReset();
  process.env["LINKEDIN_SESSION_COOKIE"] = "secret-cookie-value";
});

describe("linkedinSessionRoute", () => {
  it("400s when no cookie is stored, without calling the platform", async () => {
    cookieSource = null;
    const res = await linkedinSessionRoute(post());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /paste the LinkedIn session cookie/,
    );
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("returns the seeding outcome and never the cookie", async () => {
    seedMock.mockResolvedValue({
      loggedIn: true,
      name: "Founder",
      profileId: "prof_1",
      costUsd: 0.012,
    });
    const res = await linkedinSessionRoute(post());
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      loggedIn: true,
      name: "Founder",
      profileId: "prof_1",
      costUsd: 0.012,
    });
    expect(typeof body["checkedAt"]).toBe("string");
    expect(text).not.toContain("secret-cookie-value");
    expect(seedMock).toHaveBeenCalledWith(expect.objectContaining({ playName: "setup" }));
  });

  it("maps a platform failure to 502 with a bounded message", async () => {
    seedMock.mockRejectedValue(new Error("x".repeat(500)));
    const res = await linkedinSessionRoute(post());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toHaveLength(300);
  });
});
