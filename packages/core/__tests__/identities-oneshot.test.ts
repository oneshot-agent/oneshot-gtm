import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailIdentity, OneShotConfig } from "../src/types.ts";

// Stateful mocked config: loadConfig returns the current `cfg`, saveConfig
// writes it back (so dedup / sequential-add tests see prior writes). No real
// ~/.oneshot-gtm is touched.
let cfg: OneShotConfig;
const deletedTokens: string[] = [];

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => cfg,
    saveConfig: (next: OneShotConfig) => {
      cfg = next;
    },
    deleteGmailToken: (id: string) => {
      deletedTokens.push(id);
    },
  };
});

const { registerOneShotIdentity, removeIdentity, resolveIdentities, LEGACY_ONESHOT_ID } =
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
  mobileSignature: false,
  clientId: null,
};

beforeEach(() => {
  cfg = { ...BASE };
  deletedTokens.length = 0;
});

describe("registerOneShotIdentity", () => {
  it("materializes the legacy pool on first add (keeps the legacy sender)", () => {
    const { identityId, created } = registerOneShotIdentity({ sendingDomain: "acme.com" });
    expect(created).toBe(true);
    expect(identityId).toBe("oneshot:jane@acme.com"); // mailbox defaults to founder first name
    const ids = cfg.emailIdentities!.map((i) => i.id);
    expect(ids).toContain(LEGACY_ONESHOT_ID); // legacy identity preserved
    expect(ids).toContain("oneshot:jane@acme.com");
  });

  it("defaults a new identity to the cold-start warm-up ramp", () => {
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "sales" });
    const added = cfg.emailIdentities!.find((i) => i.id === "oneshot:sales@acme.com")!;
    expect(added.provider).toBe("oneshot");
    expect(added.sendingDomain).toBe("acme.com");
    expect(added.mailbox).toBe("sales");
    expect(added.maxPerDay).toBe(50);
    expect(added.warmup).toEqual({ startPerDay: 10, incrementPerWeek: 10 });
  });

  it("honors an explicit maxPerDay and an explicit uncapped (null)", () => {
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "a", maxPerDay: 25 });
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "b", maxPerDay: null });
    const a = cfg.emailIdentities!.find((i) => i.id === "oneshot:a@acme.com")!;
    const b = cfg.emailIdentities!.find((i) => i.id === "oneshot:b@acme.com")!;
    expect(a.maxPerDay).toBe(25);
    expect(b.maxPerDay).toBeNull();
    expect(b.warmup).toBeNull();
  });

  it("supports multiple mailboxes within one domain", () => {
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "jane" });
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "sales" });
    const onAcme = cfg
      .emailIdentities!.filter((i) => i.sendingDomain === "acme.com")
      .map((i) => i.mailbox);
    expect(onAcme).toEqual(["jane", "sales"]);
  });

  it("is a no-op on a duplicate id", () => {
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "sales" });
    const before = cfg.emailIdentities!.length;
    const { created } = registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "sales" });
    expect(created).toBe(false);
    expect(cfg.emailIdentities!.length).toBe(before);
  });

  it("normalizes domain casing and a messy mailbox", () => {
    const { identityId } = registerOneShotIdentity({
      sendingDomain: "ACME.com",
      mailbox: "Sales Team!",
    });
    expect(identityId).toBe("oneshot:salesteam@acme.com");
  });

  it("falls back to 'agent' when the founder name yields no mailbox", () => {
    cfg = { ...BASE, founderName: null };
    const { identityId } = registerOneShotIdentity({ sendingDomain: "acme.com" });
    expect(identityId).toBe("oneshot:agent@acme.com");
  });
});

describe("removeIdentity", () => {
  it("drops an identity and reports removed", () => {
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "sales" });
    const { removed } = removeIdentity("oneshot:sales@acme.com");
    expect(removed).toBe(true);
    expect(cfg.emailIdentities!.some((i) => i.id === "oneshot:sales@acme.com")).toBe(false);
    expect(deletedTokens).toContain("oneshot:sales@acme.com"); // best-effort token cleanup
  });

  it("returns removed=false for an unknown id and leaves the pool intact", () => {
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "sales" });
    const before = cfg.emailIdentities!.length;
    const { removed } = removeIdentity("oneshot:nobody@acme.com");
    expect(removed).toBe(false);
    expect(cfg.emailIdentities!.length).toBe(before);
  });

  it("materializes the legacy pool so a removal on legacy config takes effect", () => {
    // Pool is still null here (legacy). Removing the legacy identity should
    // materialize then drop it, leaving an explicit empty pool.
    const { removed } = removeIdentity(LEGACY_ONESHOT_ID);
    expect(removed).toBe(true);
    expect(cfg.emailIdentities).toEqual([]);
  });
});

describe("resolveIdentities round-trips the added identity", () => {
  it("returns the persisted pool verbatim once set", () => {
    registerOneShotIdentity({ sendingDomain: "acme.com", mailbox: "sales" });
    const resolved = resolveIdentities(cfg);
    const added = resolved.find((i) => i.id === "oneshot:sales@acme.com") as EmailIdentity;
    expect(added).toBeTruthy();
    expect(added.provider).toBe("oneshot");
  });
});
