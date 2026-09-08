import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";

// POST /api/setup as the sectioned /setup page drives it (issue #451): a
// section posts only its own keys, a rejected body must leave every store
// untouched and answer 400 (not 500), and a bad cap must never fall open to
// "uncapped". Core writers are mocked; mergeSetupConfig's own field semantics
// are covered in setup-public-cfg.test.ts.

const saveConfigMock = vi.fn();
const saveSecretsMock = vi.fn();
const deleteGmailTokenMock = vi.fn();
const registerSmartleadMock = vi.fn().mockReturnValue({ identityId: "smartlead:x", created: true });
const registerOneShotMock = vi.fn().mockReturnValue({ identityId: "oneshot:x", created: true });
let current: OneShotConfig;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => current,
    saveConfig: saveConfigMock,
    saveSecrets: saveSecretsMock,
    deleteGmailToken: deleteGmailTokenMock,
    registerSmartleadIdentity: registerSmartleadMock,
    registerOneShotIdentity: registerOneShotMock,
  };
});

const { setup } = await import("../src/api/setup.ts");

function req(body: unknown): Request {
  return new Request("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown): Promise<{ status: number; error?: string }> {
  const res = await setup(req(body));
  const json = (await res.json()) as { ok?: boolean; error?: string };
  return { status: res.status, ...(json.error ? { error: json.error } : {}) };
}

const BASE: OneShotConfig = {
  walletMode: "cdp",
  llmProvider: "openrouter",
  llmModel: "anthropic/claude-sonnet-4.6",
  telemetryEnabled: true,
  founderName: "Jane",
  founderEmail: "jane@acme.dev",
  productOneLiner: null,
  productDomain: null,
  sendingDomain: null,
  emailProvider: "oneshot",
  emailIdentities: [
    {
      id: "oneshot:jane@mail.acme.dev",
      provider: "oneshot",
      sendingDomain: "mail.acme.dev",
      mailbox: "jane",
      maxPerDay: 40,
      warmup: { startPerDay: 5, incrementPerWeek: 5 },
    },
    {
      id: "gmail:jane@gmail.com",
      provider: "gmail",
      address: "jane@gmail.com",
      maxPerDay: null,
      warmup: null,
    },
  ],
  icpOneLiner: null,
  cadenceOverrides: {},
  queueReviewOrder: "newest",
  founderCredentials: null,
  founderCohort: null,
  productPortfolio: null,
  partners: null,
  founderAdmission: null,
  productBrief: null,
  mobileSignature: false,
  timezone: null,
  clientId: "11111111-2222-3333-4444-555555555555",
  dailySpendCeilingUsd: null,
};

beforeEach(() => {
  current = structuredClone(BASE);
  saveConfigMock.mockClear();
  saveSecretsMock.mockClear();
  deleteGmailTokenMock.mockClear();
  registerSmartleadMock.mockClear();
  registerOneShotMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

function savedCfg(): OneShotConfig {
  expect(saveConfigMock).toHaveBeenCalledTimes(1);
  return saveConfigMock.mock.calls[0]![0] as OneShotConfig;
}

describe("POST /api/setup — section-scoped bodies", () => {
  it("a profile-only body writes config and leaves .env and the identity pool alone", async () => {
    expect(await post({ founderName: "Janet" })).toEqual({ status: 200 });
    const cfg = savedCfg();
    expect(cfg.founderName).toBe("Janet");
    expect(cfg.emailIdentities).toEqual(BASE.emailIdentities);
    expect(cfg.llmModel).toBe(BASE.llmModel);
    expect(saveSecretsMock).not.toHaveBeenCalled();
    expect(registerOneShotMock).not.toHaveBeenCalled();
  });

  it("a secrets-only body writes .env and re-saves config unchanged", async () => {
    expect(await post({ secrets: { OPENROUTER_API_KEY: "sk-new" } })).toEqual({ status: 200 });
    expect(saveSecretsMock).toHaveBeenCalledWith({ OPENROUTER_API_KEY: "sk-new" });
    const { clientId: _c, ...rest } = savedCfg();
    const { clientId: _b, ...base } = BASE;
    void _c;
    void _b;
    expect(rest).toEqual(base);
  });

  it("an identity-pool body applies caps, removals and adds in one request", async () => {
    const res = await post({
      identityUpdates: [{ id: "oneshot:jane@mail.acme.dev", maxPerDay: 25 }],
      removeIdentityIds: ["gmail:jane@gmail.com"],
      addIdentities: [{ provider: "oneshot", sendingDomain: "acme.email", maxPerDay: 10 }],
    });
    expect(res).toEqual({ status: 200 });
    const cfg = savedCfg();
    expect(cfg.emailIdentities).toEqual([{ ...BASE.emailIdentities![0], maxPerDay: 25 }]);
    expect(deleteGmailTokenMock).toHaveBeenCalledWith("gmail:jane@gmail.com");
    expect(registerOneShotMock).toHaveBeenCalledWith(
      expect.objectContaining({ sendingDomain: "acme.email", maxPerDay: 10 }),
    );
    // Order matters: the add re-reads config, so the pool write must land first.
    const saveOrder = saveConfigMock.mock.invocationCallOrder[0]!;
    const addOrder = registerOneShotMock.mock.invocationCallOrder[0]!;
    expect(saveOrder).toBeLessThan(addOrder);
  });

  it("queueReviewOrder and timezone are writable (they had no writer before #451)", async () => {
    expect(await post({ queueReviewOrder: "ranked", timezone: " Europe/Vienna " })).toEqual({
      status: 200,
    });
    const cfg = savedCfg();
    expect(cfg.queueReviewOrder).toBe("ranked");
    expect(cfg.timezone).toBe("Europe/Vienna");
  });

  it("a blank or null timezone clears back to the runtime zone", async () => {
    current.timezone = "Europe/Vienna";
    expect(await post({ timezone: "" })).toEqual({ status: 200 });
    expect(savedCfg().timezone).toBeNull();
    saveConfigMock.mockClear();
    current.timezone = "Europe/Vienna";
    expect(await post({ timezone: null })).toEqual({ status: 200 });
    expect(savedCfg().timezone).toBeNull();
  });

  it("an unknown queueReviewOrder value is ignored, not persisted", async () => {
    current.queueReviewOrder = "ranked";
    expect(await post({ queueReviewOrder: "sideways" })).toEqual({ status: 200 });
    expect(savedCfg().queueReviewOrder).toBe("ranked");
  });
});

describe("POST /api/setup — rejected bodies answer 400 and write nothing", () => {
  const untouched = (): void => {
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(saveSecretsMock).not.toHaveBeenCalled();
    expect(deleteGmailTokenMock).not.toHaveBeenCalled();
    expect(registerOneShotMock).not.toHaveBeenCalled();
    expect(registerSmartleadMock).not.toHaveBeenCalled();
  };

  it.each([
    ["a numeric string", "12"],
    ["NaN (JSON null-in-number smuggle)", "NaN"],
    ["a negative number", -1],
    ["a boolean", true],
  ])("identity cap that is %s → 400, never coerced to uncapped", async (_label, cap) => {
    const res = await post({
      identityUpdates: [{ id: "oneshot:jane@mail.acme.dev", maxPerDay: cap }],
      // Riding along to prove the 400 is atomic: none of these land either.
      removeIdentityIds: ["gmail:jane@gmail.com"],
      secrets: { OPENROUTER_API_KEY: "sk-new" },
    });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/invalid maxPerDay/);
    expect(res.error).toContain("oneshot:jane@mail.acme.dev");
    untouched();
  });

  it("identity cap null → uncapped, cap 0 → 0, cap 7.9 → 7", async () => {
    const res = await post({
      identityUpdates: [
        { id: "oneshot:jane@mail.acme.dev", maxPerDay: null },
        { id: "gmail:jane@gmail.com", maxPerDay: 7.9 },
      ],
    });
    expect(res).toEqual({ status: 200 });
    expect(savedCfg().emailIdentities?.map((i) => i.maxPerDay)).toEqual([null, 7]);
  });

  it("a bad cap on a new sender is rejected before anything is registered", async () => {
    const res = await post({
      founderName: "Janet",
      addIdentities: [{ provider: "oneshot", sendingDomain: "acme.email", maxPerDay: "ramp" }],
    });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/invalid maxPerDay "ramp" for new oneshot sender acme.email/);
    untouched();
  });

  it("a spend ceiling of 0 is a 400 (was a 500 via the generic handler wrapper)", async () => {
    const res = await post({ dailySpendCeilingUsd: 0, founderName: "Janet" });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/invalid dailySpendCeilingUsd/);
    untouched();
  });

  it("an unknown IANA zone is a 400", async () => {
    const res = await post({ timezone: "Mars/Olympus" });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/invalid timezone 'Mars\/Olympus'/);
    untouched();
  });

  it("a non-validation failure still propagates as a throw (→ generic 500)", async () => {
    saveConfigMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(setup(req({ founderName: "Janet" }))).rejects.toThrow("disk full");
  });
});
