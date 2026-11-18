import { afterEach, beforeEach, expect, it, vi } from "vitest";

const exchange = vi.fn();
const register = vi.fn(() => ({ identityId: "gmail:member@example.com" }));
const save = vi.fn();
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    exchangeGmailAuthCode: exchange,
    getGmailProfile: vi.fn(async () => ({ emailAddress: "member@example.com" })),
    registerGmailIdentity: register,
    saveGmailToken: save,
  };
});

const { getSharedDb } = await import("@oneshot-gtm/core");
const { buildFetchHandler } = await import("../src/server.ts");
const handler = buildFetchHandler();
const host = "gtm.tail1234.ts.net:3030";
const remoteOrigin = `https://${host}`;

function request(origin: string, path: string, proxied = false): Request {
  return new Request(`${origin}${path}`, {
    headers: {
      host: new URL(origin).host,
      ...(proxied
        ? {
            "tailscale-user-login": "member@example.com",
            "x-forwarded-host": host,
            "x-forwarded-for": "100.64.0.7",
            "x-forwarded-proto": "https",
          }
        : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GMAIL_CLIENT_ID", "test-client");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "test-secret");
  exchange.mockResolvedValue({ refreshToken: "test-refresh", scope: "test-scope" });
  getSharedDb().addMember({ email: "member@example.com", role: "member" });
  getSharedDb().allowHost(new URL(remoteOrigin).hostname);
});
afterEach(() => vi.unstubAllEnvs());

it("preserves the public HTTPS origin through Tailscale's HTTP backend and token exchange", async () => {
  const backendOrigin = `http://${host}`;
  const start = await handler(request(backendOrigin, "/api/gmail/auth/start", true));
  expect(start.status).toBe(302);
  const consent = new URL(start.headers.get("location")!);
  const redirectUri = `${remoteOrigin}/api/gmail/auth/callback`;
  expect(consent.searchParams.get("redirect_uri")).toBe(redirectUri);
  const callback = await handler(
    request(
      backendOrigin,
      `/api/gmail/auth/callback?code=test-code&state=${consent.searchParams.get("state")}`,
      true,
    ),
  );
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ redirectUri }));
  expect(new URL(callback.headers.get("location")!).origin).toBe(remoteOrigin);
});

it.each([remoteOrigin, "http://localhost:3030", "http://127.0.0.1:3030", "http://[::1]:3030"])(
  "connects using the exact request origin at %s and refuses state replay",
  async (origin) => {
    const remote = origin === remoteOrigin;
    const start = await handler(request(origin, "/api/gmail/auth/start", remote));
    expect(start.status).toBe(302);
    const consent = new URL(start.headers.get("location")!);
    const redirectUri = `${origin}/api/gmail/auth/callback`;
    expect(consent.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(consent.searchParams.get("client_id")).toBe("test-client");
    const path = `/api/gmail/auth/callback?code=test-code&state=${consent.searchParams.get("state")}`;
    const callback = await handler(request(origin, path, remote));
    expect(new URL(callback.headers.get("location")!).searchParams.get("gmailAuth")).toBe(
      "ok:member@example.com",
    );
    expect(exchange).toHaveBeenCalledWith({
      code: "test-code",
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri,
    });
    expect(register).toHaveBeenCalledWith({
      address: "member@example.com",
      refreshToken: "test-refresh",
      calendarOnly: false,
    });
    expect(save).toHaveBeenCalledWith("gmail:member@example.com", {
      refreshToken: "test-refresh",
      address: "member@example.com",
      scope: "test-scope",
    });
    const replay = await handler(request(origin, path, remote));
    expect(new URL(replay.headers.get("location")!).searchParams.get("gmailAuth")).toBe(
      "error:state mismatch or expired — retry",
    );
    expect(exchange).toHaveBeenCalledTimes(1);
  },
);

it.each([
  "error=redirect_uri_mismatch",
  `error=invalid_request&error_description=${encodeURIComponent("The redirect_uri can only be used with loopback addresses")}`,
])("explains a rejected remote consent redirect: %s", async (query) => {
  const res = await handler(request(remoteOrigin, `/api/gmail/auth/callback?${query}`, true));
  const outcome = new URL(res.headers.get("location")!).searchParams.get("gmailAuth");
  expect(outcome).toContain("Google rejected the Gmail redirect");
  expect(outcome).toContain(`${remoteOrigin}/api/gmail/auth/callback`);
  expect(outcome).toContain("Web application OAuth client's Authorized redirect URIs");
  expect(outcome).toContain("save that Web client's ID and secret");
  expect(exchange).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

it("explains a redirect rejection during token exchange without registering an identity", async () => {
  const start = await handler(request(remoteOrigin, "/api/gmail/auth/start", true));
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  exchange.mockRejectedValueOnce(new Error("Gmail token exchange failed: redirect_uri_mismatch"));
  const res = await handler(
    request(remoteOrigin, `/api/gmail/auth/callback?code=test-code&state=${state}`, true),
  );
  const outcome = new URL(res.headers.get("location")!).searchParams.get("gmailAuth");
  expect(outcome).toContain("Google rejected the Gmail redirect");
  expect(outcome).toContain(`${remoteOrigin}/api/gmail/auth/callback`);
  expect(outcome).toContain("save that Web client's ID and secret");
  expect(register).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("keeps loopback errors and unrelated remote consent errors unchanged", async () => {
  for (const [origin, error] of [
    ["http://localhost:3030", "redirect_uri_mismatch"],
    [remoteOrigin, "access_denied"],
  ] as const) {
    const res = await handler(
      request(origin, `/api/gmail/auth/callback?error=${error}`, origin === remoteOrigin),
    );
    expect(new URL(res.headers.get("location")!).searchParams.get("gmailAuth")).toBe(
      `error:${error}`,
    );
  }
});

it("retains the calendar-only purpose on a remote callback", async () => {
  const start = await handler(
    request(remoteOrigin, "/api/gmail/auth/start?purpose=calendar", true),
  );
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  await handler(
    request(remoteOrigin, `/api/gmail/auth/callback?code=test-code&state=${state}`, true),
  );
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ calendarOnly: true }));
});

it("still refuses unlisted hosts and nonmembers before starting consent", async () => {
  expect(
    (await handler(request("https://other.example.com", "/api/gmail/auth/start", true))).status,
  ).toBe(403);
  expect((await handler(request(remoteOrigin, "/api/gmail/auth/start"))).status).toBe(403);
  expect(exchange).not.toHaveBeenCalled();
});
