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
