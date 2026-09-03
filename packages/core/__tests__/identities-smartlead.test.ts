import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotConfig } from "../src/types.ts";

// registerSmartleadIdentity: defaults, provider-cap clamp, explicit caps,
// dedupe, and legacy-pool materialization. Config is mocked stateful so no
// real ~/.oneshot-gtm is touched.

let cfg: OneShotConfig;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => cfg,
    saveConfig: (next: OneShotConfig) => {
      cfg = next;
    },
  };
});

const { registerSmartleadIdentity, LEGACY_ONESHOT_ID } = await import("../src/identities.ts");

const BASE: OneShotConfig = {
  walletMode: "cdp",
  llmProvider: "openrouter",
  llmModel: "x",
  telemetryEnabled: true,
  founderName: "Jane Doe",
  founderEmail: null,
  productOneLiner: null,
  productDomain: null,
  sendingDomain: "legacy.com",
  emailProvider: "oneshot",
  emailIdentities: null,
  icpOneLiner: null,
  cadenceOverrides: null,
  founderCredentials: null,
  productPortfolio: null,
  partners: null,
  founderAdmission: null,
  productBrief: null,
  mobileSignature: false,
  timezone: null,
  slackWebhookUrl: null,
  clientId: null,
  dailySpendCeilingUsd: null,
};

beforeEach(() => {
  cfg = { ...BASE };
});

describe("registerSmartleadIdentity", () => {
  it("materializes the legacy pool on first add and normalizes the id", () => {
    const { identityId, created } = registerSmartleadIdentity({ address: " Jane@ACME.com " });
    expect(created).toBe(true);
    expect(identityId).toBe("smartlead:jane@acme.com");
    const ids = cfg.emailIdentities!.map((i) => i.id);
    expect(ids).toContain(LEGACY_ONESHOT_ID);
    expect(ids).toContain("smartlead:jane@acme.com");
    const added = cfg.emailIdentities!.find((i) => i.id === identityId)!;
    expect(added.provider).toBe("smartlead");
    expect(added.address).toBe("jane@acme.com");
  });

  it("defaults to the warm-up ramp with the 50/day ceiling", () => {
    registerSmartleadIdentity({ address: "a@x.com" });
    const added = cfg.emailIdentities!.find((i) => i.id === "smartlead:a@x.com")!;
    expect(added.maxPerDay).toBe(50);
    expect(added.warmup).toEqual({ startPerDay: 10, incrementPerWeek: 10 });
  });

  it("clamps the DEFAULT ceiling to Smartlead's message_per_day when lower", () => {
    registerSmartleadIdentity({ address: "low@x.com", providerMessagePerDay: 30 });
    expect(cfg.emailIdentities!.find((i) => i.id === "smartlead:low@x.com")!.maxPerDay).toBe(30);
    registerSmartleadIdentity({ address: "high@x.com", providerMessagePerDay: 200 });
    expect(cfg.emailIdentities!.find((i) => i.id === "smartlead:high@x.com")!.maxPerDay).toBe(50);
    registerSmartleadIdentity({ address: "none@x.com", providerMessagePerDay: null });
    expect(cfg.emailIdentities!.find((i) => i.id === "smartlead:none@x.com")!.maxPerDay).toBe(50);
  });

  it("an explicit maxPerDay overrides the provider clamp; the ramp is kept", () => {
    registerSmartleadIdentity({ address: "cap@x.com", maxPerDay: 80, providerMessagePerDay: 30 });
    const added = cfg.emailIdentities!.find((i) => i.id === "smartlead:cap@x.com")!;
    expect(added.maxPerDay).toBe(80);
    expect(added.warmup).toEqual({ startPerDay: 10, incrementPerWeek: 10 });
  });

  it("explicit null = truly uncapped, ramp cleared", () => {
    registerSmartleadIdentity({ address: "inf@x.com", maxPerDay: null });
    const added = cfg.emailIdentities!.find((i) => i.id === "smartlead:inf@x.com")!;
    expect(added.maxPerDay).toBeNull();
    expect(added.warmup).toBeNull();
  });

  it("re-adding a known address is a no-op that keeps tuned caps", () => {
    registerSmartleadIdentity({ address: "dup@x.com", maxPerDay: 12 });
    const { created } = registerSmartleadIdentity({ address: "DUP@x.com" });
    expect(created).toBe(false);
    const dupes = cfg.emailIdentities!.filter((i) => i.id === "smartlead:dup@x.com");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.maxPerDay).toBe(12);
  });

  it("rejects a blank address", () => {
    expect(() => registerSmartleadIdentity({ address: "  " })).toThrow(/needs an address/);
  });
});
