import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapClientId, llmApiKey, oneshotEnvReady, SECRET_KEYS } from "../src/config.ts";
import type { OneShotConfig } from "../src/types.ts";

/**
 * `config.ts` auto-applies `~/.oneshot-gtm/.env` into process.env at import time,
 * so the user's real keys may already be in process.env when these tests start.
 * Snapshot & restore around each case so nothing leaks between tests.
 */
let snapshot: Record<string, string | undefined> = {};

const KEYS_TO_TOUCH = [...SECRET_KEYS] as const;

beforeEach(() => {
  snapshot = {};
  for (const k of KEYS_TO_TOUCH) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS_TO_TOUCH) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe("llmApiKey", () => {
  it("returns the openrouter key when provider=openrouter", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-xyz";
    expect(llmApiKey("openrouter")).toBe("sk-or-xyz");
  });

  it("returns the openai key when provider=openai", () => {
    process.env.OPENAI_API_KEY = "sk-oai-xyz";
    expect(llmApiKey("openai")).toBe("sk-oai-xyz");
  });

  it("returns the anthropic key when provider=anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-xyz";
    expect(llmApiKey("anthropic")).toBe("sk-ant-xyz");
  });

  it("returns null when the matching env var is unset", () => {
    expect(llmApiKey("openrouter")).toBeNull();
    expect(llmApiKey("openai")).toBeNull();
    expect(llmApiKey("anthropic")).toBeNull();
  });
});

describe("oneshotEnvReady", () => {
  it("returns true when AGENT_PRIVATE_KEY is set", () => {
    process.env.AGENT_PRIVATE_KEY = "0xdeadbeef";
    expect(oneshotEnvReady()).toBe(true);
  });

  it("returns true when all three CDP vars are set", () => {
    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    process.env.CDP_WALLET_SECRET = "wallet";
    expect(oneshotEnvReady()).toBe(true);
  });

  it("returns false when CDP vars are partial (id + secret, missing wallet)", () => {
    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    expect(oneshotEnvReady()).toBe(false);
  });

  it("returns false when none of the four wallet vars are set", () => {
    expect(oneshotEnvReady()).toBe(false);
  });
});

describe("bootstrapClientId", () => {
  const baseCfg: OneShotConfig = {
    walletMode: "cdp",
    llmProvider: "openrouter",
    llmModel: "x",
    telemetryEnabled: true,
    founderName: null,
    founderEmail: null,
    productOneLiner: null,
    productDomain: null,
    sendingDomain: null,
    emailProvider: "oneshot" as const,
    emailIdentities: null,
    icpOneLiner: null,
    cadenceOverrides: null,
    founderCredentials: null,
    productPortfolio: null,
    partners: null,
    mobileSignature: false,
    clientId: null,
  };

  it("mints a UUID-shaped clientId when none is stored", () => {
    const { cfg, minted } = bootstrapClientId(baseCfg);
    expect(minted).toBe(true);
    expect(cfg.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("preserves an existing clientId verbatim and signals not minted", () => {
    const stored: OneShotConfig = {
      ...baseCfg,
      clientId: "11111111-2222-3333-4444-555555555555",
    };
    const { cfg, minted } = bootstrapClientId(stored);
    expect(minted).toBe(false);
    expect(cfg.clientId).toBe("11111111-2222-3333-4444-555555555555");
    // Same reference — no defensive clone when nothing was minted.
    expect(cfg).toBe(stored);
  });

  it("treats an empty-string clientId as missing and mints fresh", () => {
    const { cfg, minted } = bootstrapClientId({ ...baseCfg, clientId: "" });
    expect(minted).toBe(true);
    expect(cfg.clientId).toBeTruthy();
    expect(cfg.clientId?.length).toBeGreaterThan(0);
  });

  it("doesn't mutate the input when minting (returns a new cfg object)", () => {
    const original = { ...baseCfg };
    const { cfg } = bootstrapClientId(baseCfg);
    expect(baseCfg).toEqual(original);
    expect(cfg).not.toBe(baseCfg);
  });

  it("preserves every other field when minting", () => {
    const stored: OneShotConfig = {
      ...baseCfg,
      founderName: "Sam",
      founderEmail: "sam@acme.dev",
      icpOneLiner: "agent builders",
      productOneLiner: "single SDK",
      llmModel: "claude-sonnet-4.6",
    };
    const { cfg } = bootstrapClientId(stored);
    expect(cfg.founderName).toBe("Sam");
    expect(cfg.founderEmail).toBe("sam@acme.dev");
    expect(cfg.icpOneLiner).toBe("agent builders");
    expect(cfg.productOneLiner).toBe("single SDK");
    expect(cfg.llmModel).toBe("claude-sonnet-4.6");
  });

  it("two consecutive bootstraps mint different UUIDs", () => {
    const a = bootstrapClientId(baseCfg);
    const b = bootstrapClientId(baseCfg);
    expect(a.cfg.clientId).not.toBe(b.cfg.clientId);
  });
});

describe("SECRET_KEYS", () => {
  it("lists the documented secret env vars", () => {
    expect(SECRET_KEYS).toContain("OPENROUTER_API_KEY");
    expect(SECRET_KEYS).toContain("OPENAI_API_KEY");
    expect(SECRET_KEYS).toContain("ANTHROPIC_API_KEY");
    expect(SECRET_KEYS).toContain("CDP_API_KEY_ID");
    expect(SECRET_KEYS).toContain("CDP_API_KEY_SECRET");
    expect(SECRET_KEYS).toContain("CDP_WALLET_SECRET");
    expect(SECRET_KEYS).toContain("AGENT_PRIVATE_KEY");
  });
});
