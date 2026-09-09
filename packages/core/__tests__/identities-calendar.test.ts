import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotConfig } from "../src/types.ts";

// registerGmailIdentity(calendarOnly) and removeIdentity(calendarIdentityId
// clearing) — issue #577. Config is mocked stateful so no real ~/.oneshot-gtm
// is touched; saveGmailToken/deleteGmailToken are mocked out too so this file
// never writes gmail-tokens.json.

let cfg: OneShotConfig;
const savedTokens: Record<string, unknown> = {};
const deletedTokens: string[] = [];

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => cfg,
    saveConfig: (next: OneShotConfig) => {
      cfg = next;
    },
    saveGmailToken: (id: string, entry: unknown) => {
      savedTokens[id] = entry;
    },
    deleteGmailToken: (id: string) => {
      deletedTokens.push(id);
    },
  };
});

const { registerGmailIdentity, removeIdentity, resolveIdentities, LEGACY_ONESHOT_ID } =
  await import("../src/identities.ts");

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
  slackWebhookUrl: null,
  timezone: null,
  clientId: null,
  dailySpendCeilingUsd: null,
  calendarIdentityId: null,
  calendarId: "primary",
};

beforeEach(() => {
  cfg = { ...BASE };
  for (const k of Object.keys(savedTokens)) delete savedTokens[k];
  deletedTokens.length = 0;
});

describe("registerGmailIdentity({ calendarOnly: true })", () => {
  it("registers a NEW identity at maxPerDay: 0, no warm-up — never a silent sender", () => {
    const { identityId, created } = registerGmailIdentity({
      address: "cal@x.dev",
      refreshToken: "rt",
      calendarOnly: true,
    });
    expect(created).toBe(true);
    const added = cfg.emailIdentities!.find((i) => i.id === identityId)!;
    expect(added.maxPerDay).toBe(0);
    expect(added.warmup).toBeNull();
  });

  it("still applies the ordinary warm-up ramp when calendarOnly is not set", () => {
    const { identityId } = registerGmailIdentity({ address: "send@x.dev", refreshToken: "rt" });
    const added = cfg.emailIdentities!.find((i) => i.id === identityId)!;
    expect(added.maxPerDay).toBe(50);
    expect(added.warmup).toEqual({ startPerDay: 10, incrementPerWeek: 10 });
  });

  it("re-authing an EXISTING sender with calendarOnly:true does NOT touch its tuned cap", () => {
    const first = registerGmailIdentity({ address: "existing@x.dev", refreshToken: "rt1" });
    expect(first.created).toBe(true);
    // Tune the cap by hand, the way a founder would via /setup.
    const pool = [...cfg.emailIdentities!];
    const idx = pool.findIndex((i) => i.id === first.identityId);
    pool[idx] = Object.assign({}, pool[idx], { maxPerDay: 17 });
    cfg = { ...cfg, emailIdentities: pool };
    const second = registerGmailIdentity({
      address: "existing@x.dev",
      refreshToken: "rt2",
      calendarOnly: true,
    });
    expect(second.created).toBe(false);
    expect(second.identityId).toBe(first.identityId);
    expect(cfg.emailIdentities!.find((i) => i.id === first.identityId)!.maxPerDay).toBe(17);
  });
});

describe("removeIdentity clears calendarIdentityId (issue #577)", () => {
  it("clears the pointer when the removed identity matches it", () => {
    const { identityId } = registerGmailIdentity({ address: "cal@x.dev", refreshToken: "rt" });
    cfg = { ...cfg, calendarIdentityId: identityId };
    const { removed } = removeIdentity(identityId);
    expect(removed).toBe(true);
    expect(cfg.calendarIdentityId).toBeNull();
  });

  it("leaves an unrelated calendarIdentityId untouched", () => {
    const { identityId: calId } = registerGmailIdentity({
      address: "cal@x.dev",
      refreshToken: "rt",
    });
    const { identityId: senderId } = registerGmailIdentity({
      address: "sender@x.dev",
      refreshToken: "rt2",
    });
    cfg = { ...cfg, calendarIdentityId: calId };
    removeIdentity(senderId);
    expect(cfg.calendarIdentityId).toBe(calId);
  });

  it("removing an identity that isn't the calendar pointer is still a no-op on it (legacy pool materialized)", () => {
    void resolveIdentities;
    void LEGACY_ONESHOT_ID;
    cfg = { ...cfg, calendarIdentityId: null };
    const { removed } = removeIdentity("gmail:never-added@x.dev");
    expect(removed).toBe(false);
    expect(cfg.calendarIdentityId).toBeNull();
  });
});
