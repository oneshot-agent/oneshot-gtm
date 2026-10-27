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
const validateSendViaMock = vi.fn().mockResolvedValue({ smtpHost: "smtp.example.com" });
const defaultSendViaMock = vi.fn();
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
    validateSendVia: validateSendViaMock,
    defaultSendViaForSmartlead: defaultSendViaMock,
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
  llmModel: "anthropic/claude-sonnet-5.5",
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
  slackWebhookUrl: null,
  dailySpendCeilingUsd: null,
  calendarIdentityId: null,
  calendarId: "primary",
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

  it("a sendVia edit is validated, then saved on the same identity id", async () => {
    current.emailIdentities = [
      ...current.emailIdentities!,
      {
        id: "smartlead:jane@mail.example.com",
        provider: "smartlead",
        address: "jane@mail.example.com",
        maxPerDay: 30,
        warmup: null,
      },
    ];
    const res = await post({
      identityUpdates: [{ id: "smartlead:jane@mail.example.com", sendVia: "smtp" }],
    });
    expect(res).toEqual({ status: 200 });
    expect(validateSendViaMock).toHaveBeenCalledWith("smartlead:jane@mail.example.com", "smtp");
    const saved = savedCfg().emailIdentities!.find(
      (i) => i.id === "smartlead:jane@mail.example.com",
    );
    // Cap untouched: the edit carried no maxPerDay.
    expect(saved).toMatchObject({ sendVia: "smtp", maxPerDay: 30 });
  });

  it("a new Smartlead mailbox with credentials is added on direct SMTP, with a notice", async () => {
    defaultSendViaMock.mockResolvedValueOnce({ sendVia: "smtp", reason: null });
    const res = await setup(
      req({ addIdentities: [{ provider: "smartlead", address: "New@mail.example.com" }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      sendViaNotices: [{ address: "new@mail.example.com", sendVia: "smtp", reason: null }],
    });
    expect(defaultSendViaMock).toHaveBeenCalledWith("new@mail.example.com");
    expect(registerSmartleadMock).toHaveBeenCalledWith(
      expect.objectContaining({ address: "New@mail.example.com", sendVia: "smtp" }),
    );
  });

  it("a new Smartlead mailbox without credentials is added on the API, with the reason", async () => {
    defaultSendViaMock.mockResolvedValueOnce({
      sendVia: "provider",
      reason: "Connect IMAP and SMTP for this Smartlead mailbox.",
    });
    const res = await setup(
      req({ addIdentities: [{ provider: "smartlead", address: "oauth@mail.example.com" }] }),
    );
    expect(await res.json()).toEqual({
      ok: true,
      sendViaNotices: [
        {
          address: "oauth@mail.example.com",
          sendVia: "provider",
          reason: "Connect IMAP and SMTP for this Smartlead mailbox.",
        },
      ],
    });
    expect(registerSmartleadMock).toHaveBeenCalledWith(
      expect.objectContaining({ sendVia: "provider" }),
    );
  });

  it("an explicit provider choice is kept without a credentials lookup", async () => {
    const res = await setup(
      req({
        addIdentities: [
          { provider: "smartlead", address: "api@mail.example.com", sendVia: "provider" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(defaultSendViaMock).not.toHaveBeenCalled();
    expect(registerSmartleadMock).toHaveBeenCalledWith(
      expect.objectContaining({ sendVia: "provider" }),
    );
  });

  it("re-adding a mailbox already in the pool does no lookup and changes nothing", async () => {
    current.emailIdentities = [
      ...current.emailIdentities!,
      {
        id: "smartlead:old@mail.example.com",
        provider: "smartlead",
        address: "old@mail.example.com",
        maxPerDay: 30,
        warmup: null,
      },
    ];
    const res = await setup(
      req({ addIdentities: [{ provider: "smartlead", address: "old@mail.example.com" }] }),
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(defaultSendViaMock).not.toHaveBeenCalled();
    expect(registerSmartleadMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ sendVia: expect.anything() }),
    );
  });

  it("an explicit smtp add without credentials is a 400 and registers nothing", async () => {
    defaultSendViaMock.mockResolvedValueOnce({ sendVia: "provider", reason: "no credentials" });
    const res = await post({
      addIdentities: [{ provider: "smartlead", address: "x@mail.example.com", sendVia: "smtp" }],
    });
    expect(res).toEqual({ status: 400, error: "x@mail.example.com: no credentials" });
    expect(registerSmartleadMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("a Smartlead outage during the credentials check is a 400 asking for a retry", async () => {
    defaultSendViaMock.mockResolvedValueOnce({
      sendVia: "provider",
      reason: "Could not reach Smartlead to resolve mailbox connections.",
      lookupFailed: true,
    });
    const res = await post({
      addIdentities: [{ provider: "smartlead", address: "x@mail.example.com" }],
    });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/could not check its SMTP credentials .*Retry/);
    expect(registerSmartleadMock).not.toHaveBeenCalled();
  });

  it("an unknown sendVia on an add is a 400", async () => {
    const res = await post({
      addIdentities: [{ provider: "smartlead", address: "x@mail.example.com", sendVia: "api" }],
    });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/sendVia must be/);
    expect(registerSmartleadMock).not.toHaveBeenCalled();
  });

  it("a sendVia edit that fails validation is a 400 and changes nothing", async () => {
    validateSendViaMock.mockRejectedValueOnce(
      new Error("Direct mailbox credentials are unavailable."),
    );
    const res = await post({
      identityUpdates: [{ id: "oneshot:jane@mail.acme.dev", sendVia: "smtp" }],
      secrets: { OPENROUTER_API_KEY: "sk-new" },
    });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/oneshot:jane@mail\.acme\.dev: Direct mailbox credentials/);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(saveSecretsMock).not.toHaveBeenCalled();
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

  it("calendarIdentityId pointing at a connected Gmail identity is accepted and calendarId trims/defaults", async () => {
    expect(
      await post({
        calendarIdentityId: "gmail:jane@gmail.com",
        calendarId: " work@group.calendar.google.com ",
      }),
    ).toEqual({ status: 200 });
    const cfg = savedCfg();
    expect(cfg.calendarIdentityId).toBe("gmail:jane@gmail.com");
    expect(cfg.calendarId).toBe("work@group.calendar.google.com");
  });

  it("calendarIdentityId: null turns the feature off and is accepted with no identity check", async () => {
    current.calendarIdentityId = "gmail:jane@gmail.com";
    expect(await post({ calendarIdentityId: null })).toEqual({ status: 200 });
    expect(savedCfg().calendarIdentityId).toBeNull();
  });

  it("a blank calendarId defaults back to 'primary'", async () => {
    expect(await post({ calendarIdentityId: "gmail:jane@gmail.com", calendarId: "  " })).toEqual({
      status: 200,
    });
    expect(savedCfg().calendarId).toBe("primary");
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

  it("a webhook URL that is not a Slack incoming webhook is a 400 (SSRF guard)", async () => {
    for (const bad of [
      "https://evil.example/services/T000",
      "http://hooks.slack.com/services/T000/B000/x",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      const out = await post({ slackWebhookUrl: bad });
      expect(out.status, bad).toBe(400);
      expect(out.error).toMatch(/hooks\.slack\.com/);
    }
    // A real one saves; a blank clears.
    expect(
      (await post({ slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/x" })).status,
    ).toBe(200);
    expect((await post({ slackWebhookUrl: "" })).status).toBe(200);
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

  it("a calendarIdentityId pointing at a non-existent identity is a 400 (never persisted, never polled)", async () => {
    const res = await post({ calendarIdentityId: "gmail:never-connected@x.dev" });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/is not a connected Gmail identity/);
    untouched();
  });

  it("a calendarIdentityId pointing at a non-Gmail identity is a 400", async () => {
    const res = await post({ calendarIdentityId: "oneshot:jane@mail.acme.dev" });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/is not a connected Gmail identity/);
    untouched();
  });

  it("a non-validation failure still propagates as a throw (→ generic 500)", async () => {
    saveConfigMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(setup(req({ founderName: "Janet" }))).rejects.toThrow("disk full");
  });
});

describe("minimum onboarding step saves", () => {
  it("rejects untouched and whitespace business fields without writing", async () => {
    expect((await post({ onboardingStep: 1 })).status).toBe(400);
    expect(
      (
        await post({
          onboardingStep: 1,
          founderName: " ",
          productOneLiner: " ",
          productDomain: "example.com",
        })
      ).status,
    ).toBe(400);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(saveSecretsMock).not.toHaveBeenCalled();
  });
  it("normalizes the website and saves only the requested business fields", async () => {
    expect(
      (
        await post({
          onboardingStep: 1,
          founderName: " Founder ",
          productOneLiner: " Bookkeeping ",
          productDomain: "https://EXAMPLE.com/about",
        })
      ).status,
    ).toBe(200);
    expect(savedCfg()).toMatchObject({
      founderName: "Founder",
      productOneLiner: "Bookkeeping",
      productDomain: "example.com",
      icpOneLiner: BASE.icpOneLiner,
    });
  });
  it("rejects an empty customer step and invalid AI settings", async () => {
    expect((await post({ onboardingStep: 2, icpOneLiner: " " })).status).toBe(400);
    expect(
      (await post({ onboardingStep: 3, llmProvider: "invalid", llmModel: "model" })).status,
    ).toBe(400);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(saveSecretsMock).not.toHaveBeenCalled();
  });
});

// The offer judge's config mirrors the reply classifier's: `decisions` needs
// a model, the threshold is 0–1, null clears it back to the default `llm`.
describe("POST /api/setup — offerJudge", () => {
  it("saves a decisions judge with its model and threshold", async () => {
    const body = { offerJudge: { engine: "decisions", model: " test/model ", minConfidence: 0.6 } };
    expect(await post(body)).toEqual({ status: 200 });
    expect(savedCfg().offerJudge).toEqual({
      engine: "decisions",
      model: "test/model",
      minConfidence: 0.6,
    });
  });

  it("refuses decisions without a model, an unknown engine and a threshold outside 0–1", async () => {
    for (const offerJudge of [
      { engine: "decisions" },
      { engine: "magic" },
      { engine: "llm", minConfidence: 1.5 },
    ]) {
      const res = await post({ offerJudge });
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/offerJudge/);
    }
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("offerExclusions: trimmed, blanks dropped; absent keeps, null or empty clears, non-strings refused", async () => {
    expect(
      await post({ offerExclusions: ["  recruiting:  hiring people ", "", "  ", "legal advice"] }),
    ).toEqual({ status: 200 });
    expect(savedCfg().offerExclusions).toEqual(["recruiting: hiring people", "legal advice"]);
    current = { ...current, offerExclusions: ["recruiting"] };
    saveConfigMock.mockClear();
    expect(await post({ founderName: "Janet" })).toEqual({ status: 200 });
    expect(savedCfg().offerExclusions).toEqual(["recruiting"]);
    for (const offerExclusions of [null, [" "]]) {
      saveConfigMock.mockClear();
      expect(await post({ offerExclusions })).toEqual({ status: 200 });
      expect(savedCfg().offerExclusions).toBeUndefined();
    }
    saveConfigMock.mockClear();
    const res = await post({ offerExclusions: ["ok", 3] });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/offerExclusions/);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("offerAnchor: saved as given, absent keeps, null clears, an unknown value refused", async () => {
    expect(await post({ offerAnchor: "prefer-product" })).toEqual({ status: 200 });
    expect(savedCfg().offerAnchor).toBe("prefer-product");
    current = { ...current, offerAnchor: "prefer-product" };
    saveConfigMock.mockClear();
    expect(await post({ founderName: "Janet" })).toEqual({ status: 200 });
    expect(savedCfg().offerAnchor).toBe("prefer-product");
    saveConfigMock.mockClear();
    expect(await post({ offerAnchor: "either" })).toEqual({ status: 200 });
    expect(savedCfg().offerAnchor).toBe("either");
    saveConfigMock.mockClear();
    expect(await post({ offerAnchor: null })).toEqual({ status: 200 });
    expect(savedCfg().offerAnchor).toBeUndefined();
    // A misspelling is a 400 here rather than a silent fall back to the
    // default, which would turn the preference off without saying so.
    saveConfigMock.mockClear();
    const res = await post({ offerAnchor: "prefer_product" });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/offerAnchor/);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("null clears it; absent leaves it as stored", async () => {
    current = { ...current, offerJudge: { engine: "decisions", model: "m" } };
    expect(await post({ founderName: "Janet" })).toEqual({ status: 200 });
    expect(savedCfg().offerJudge).toEqual({ engine: "decisions", model: "m" });
    saveConfigMock.mockClear();
    expect(await post({ offerJudge: null })).toEqual({ status: 200 });
    expect(savedCfg().offerJudge).toBeUndefined();
  });
});

describe("POST /api/setup — LinkedIn templates", () => {
  it("saves a template next to invitesPerDay, with no warnings when it fits", async () => {
    current = { ...current, linkedin: { invitesPerDay: 12 } };
    const res = await setup(req({ linkedin: { templates: { note: "Hi {first_name}." } } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(savedCfg().linkedin).toEqual({
      invitesPerDay: 12,
      templates: { note: "Hi {first_name}." },
    });
  });

  it("saves a note that can run long, and says so in warnings", async () => {
    const note = `Hi {first_name}, saw {evidence}. ${"a".repeat(200)}`;
    const res = await setup(req({ linkedin: { templates: { note } } }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(json.ok).toBe(true);
    expect(json.warnings).toEqual([expect.stringMatching(/^Connection request: up to \d+/)]);
    expect(savedCfg().linkedin?.templates?.note).toBe(note);
  });

  it("an unusable placeholder is a 400 and writes nothing", async () => {
    const res = await post({ linkedin: { templates: { noteFallback: "Hi {offer}" } } });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/^Connection request, no evidence: \{offer\} can't be used/);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});
