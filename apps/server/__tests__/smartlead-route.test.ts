import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmartleadAccount } from "@oneshot-gtm/core";

// /api/smartlead/accounts: key resolution (pasted > stored), sanitized
// pass-through with alreadyRegistered, and upstream-failure mapping. The core
// client is mocked — its own paging/sanitization is covered in core tests.

const listMock = vi.fn();
const registerSmartleadMock = vi.fn().mockReturnValue({ identityId: "smartlead:x", created: true });
const registerOneShotMock = vi.fn().mockReturnValue({ identityId: "oneshot:x", created: true });
let storedKey: string | null = null;
let identities: Array<{ id: string; provider: string; address?: string | null }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    listSmartleadAccounts: (key?: string) => listMock(key),
    smartleadApiKey: () => storedKey,
    registerSmartleadIdentity: registerSmartleadMock,
    registerOneShotIdentity: registerOneShotMock,
    loadConfig: () => ({ ...actual.loadConfig(), emailIdentities: identities }),
  };
});

const { smartleadAccountsRoute } = await import("../src/api/smartlead.ts");
const { setup } = await import("../src/api/setup.ts");

function req(body?: unknown): Request {
  return new Request("http://localhost/api/smartlead/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ACCOUNT: SmartleadAccount = {
  id: 7,
  fromEmail: "jane@acme.com",
  fromName: "Jane",
  messagePerDay: 30,
  dailySentCount: 2,
  isSmtpSuccess: true,
  type: "SMTP",
  warmupStatus: "ACTIVE",
  warmupReputation: "95%",
};

beforeEach(() => {
  listMock.mockReset();
  registerSmartleadMock.mockClear();
  registerOneShotMock.mockClear();
  storedKey = null;
  identities = [];
});
afterEach(() => vi.clearAllMocks());

describe("smartleadAccountsRoute", () => {
  it("400s when no key is pasted and none is stored", async () => {
    const res = await smartleadAccountsRoute(req({}));
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("uses a pasted key from the body (browse before saving)", async () => {
    listMock.mockResolvedValue([ACCOUNT]);
    const res = await smartleadAccountsRoute(req({ apiKey: " pasted-key " }));
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith("pasted-key");
  });

  it("falls back to the stored key on an empty body", async () => {
    storedKey = "stored-key";
    listMock.mockResolvedValue([]);
    const res = await smartleadAccountsRoute(req());
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith("stored-key");
  });

  it("marks accounts already in the pool and passes sanitized fields through", async () => {
    storedKey = "k";
    identities = [
      { id: "smartlead:jane@acme.com", provider: "smartlead", address: "Jane@Acme.com" },
    ];
    listMock.mockResolvedValue([ACCOUNT, { ...ACCOUNT, id: 8, fromEmail: "new@acme.com" }]);
    const res = await smartleadAccountsRoute(req({}));
    const body = (await res.json()) as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[0]).toMatchObject({ fromEmail: "jane@acme.com", alreadyRegistered: true });
    expect(body.accounts[1]).toMatchObject({ fromEmail: "new@acme.com", alreadyRegistered: false });
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("maps an upstream failure to 502 with the sanitized message", async () => {
    storedKey = "k";
    listMock.mockRejectedValue(new Error("Smartlead API /email-accounts/ failed (401): bad key"));
    const res = await smartleadAccountsRoute(req({}));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("401");
    expect(body.error).not.toContain("api_key=");
  });
});

function setupReq(body: unknown): Request {
  return new Request("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: JSON.stringify(body),
  });
}

describe("setup route addIdentities smartlead branch", () => {
  it("routes smartlead adds to registerSmartleadIdentity, oneshot adds to registerOneShotIdentity", async () => {
    const res = await setup(
      setupReq({
        addIdentities: [
          {
            provider: "smartlead",
            address: "jane@acme.com",
            label: "Jane",
            providerMessagePerDay: 30,
          },
          { provider: "oneshot", sendingDomain: "acme.email" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(registerSmartleadMock).toHaveBeenCalledWith(
      expect.objectContaining({ address: "jane@acme.com", providerMessagePerDay: 30 }),
    );
    expect(registerOneShotMock).toHaveBeenCalledWith(
      expect.objectContaining({ sendingDomain: "acme.email" }),
    );
  });

  it("skips a smartlead add with a blank address", async () => {
    const res = await setup(
      setupReq({ addIdentities: [{ provider: "smartlead", address: "  " }] }),
    );
    expect(res.status).toBe(200);
    expect(registerSmartleadMock).not.toHaveBeenCalled();
  });
});
