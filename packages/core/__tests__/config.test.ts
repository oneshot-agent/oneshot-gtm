import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapClientId,
  configDir,
  DEFAULT_LLM_MODEL,
  llmApiKey,
  currentNoOfferPlays,
  loadConfig,
  noOfferPlaysOf,
  offerAnchorOf,
  offerExclusionsOf,
  oneshotEnvReady,
  SECRET_KEYS,
  withCurrentDefaultModel,
} from "../src/config.ts";
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
    // Same reference: no defensive clone when nothing was minted.
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
      icpOneLiner: "B2B fintech founders",
      productOneLiner: "invoicing API",
      llmModel: "claude-sonnet-5.5",
    };
    const { cfg } = bootstrapClientId(stored);
    expect(cfg.founderName).toBe("Sam");
    expect(cfg.founderEmail).toBe("sam@acme.dev");
    expect(cfg.icpOneLiner).toBe("B2B fintech founders");
    expect(cfg.productOneLiner).toBe("invoicing API");
    expect(cfg.llmModel).toBe("claude-sonnet-5.5");
  });

  it("two consecutive bootstraps mint different UUIDs", () => {
    const a = bootstrapClientId(baseCfg);
    const b = bootstrapClientId(baseCfg);
    expect(a.cfg.clientId).not.toBe(b.cfg.clientId);
  });
});

describe("retired default model", () => {
  const configFile = () => join(configDir(), "config.json");
  afterEach(() => rmSync(configFile(), { force: true }));

  it("defaults to Claude Sonnet 5.5 on OpenRouter", () => {
    expect(DEFAULT_LLM_MODEL).toBe("anthropic/claude-sonnet-5.5");
  });

  it("moves a saved Sonnet 4.6 default to Sonnet 5.5 on both providers", () => {
    const base = { llmModel: "anthropic/claude-sonnet-4.6" } as OneShotConfig;
    expect(withCurrentDefaultModel(base).llmModel).toBe("anthropic/claude-sonnet-5.5");
    expect(withCurrentDefaultModel({ ...base, llmModel: "claude-sonnet-4-6" }).llmModel).toBe(
      "claude-sonnet-5-5",
    );
  });

  it("keeps any other saved model", () => {
    const cfg = { llmModel: "openai/gpt-5.1" } as OneShotConfig;
    expect(withCurrentDefaultModel(cfg)).toBe(cfg);
    // An inherited object key is not a mapping.
    const odd = { llmModel: "constructor" } as OneShotConfig;
    expect(withCurrentDefaultModel(odd)).toBe(odd);
  });

  it("loadConfig reads a config saved under the old default as the new default", () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      configFile(),
      JSON.stringify({ llmProvider: "openrouter", llmModel: "anthropic/claude-sonnet-4.6" }),
    );
    expect(loadConfig().llmModel).toBe(DEFAULT_LLM_MODEL);
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

describe("offerExclusionsOf", () => {
  it("trims each entry and drops blanks, repeats and non-strings", () => {
    expect(
      offerExclusionsOf({
        offerExclusions: [" recruiting:  hiring ", "", "recruiting: hiring", 3],
      }),
    ).toEqual(["recruiting: hiring"]);
  });

  it("reads a lone string as one entry and anything else as none", () => {
    expect(offerExclusionsOf({ offerExclusions: " legal advice " })).toEqual(["legal advice"]);
    expect(offerExclusionsOf({})).toEqual([]);
    expect(offerExclusionsOf({ offerExclusions: { a: 1 } })).toEqual([]);
  });
});

describe("noOfferPlaysOf", () => {
  it("trims each play name and drops blanks, repeats and non-strings", () => {
    expect(noOfferPlaysOf({ noOfferPlays: [" repo-interest ", "", "repo-interest", 3] })).toEqual([
      "repo-interest",
    ]);
  });

  it("reads a lone string as one play and anything else as none", () => {
    expect(noOfferPlaysOf({ noOfferPlays: "luma-events" })).toEqual(["luma-events"]);
    expect(noOfferPlaysOf({})).toEqual([]);
    expect(noOfferPlaysOf({ noOfferPlays: { a: 1 } })).toEqual([]);
  });
});

describe("currentNoOfferPlays", () => {
  const configFile = () => join(configDir(), "config.json");
  afterEach(() => rmSync(configFile(), { force: true }));

  it("reads none when there is no config file", () => {
    rmSync(configFile(), { force: true });
    expect(currentNoOfferPlays()).toEqual([]);
  });

  it("sees a hand edit to the file on the next call", () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configFile(), JSON.stringify({ noOfferPlays: ["repo-interest"] }));
    expect(currentNoOfferPlays()).toEqual(["repo-interest"]);
    // A different size changes the stamp even inside one mtime tick.
    writeFileSync(configFile(), JSON.stringify({ noOfferPlays: ["repo-interest", "luma-events"] }));
    expect(currentNoOfferPlays()).toEqual(["repo-interest", "luma-events"]);
  });
});

describe("offerAnchorOf", () => {
  it("turns the preference on for the exact value only", () => {
    expect(offerAnchorOf({ offerAnchor: "prefer-product" })).toBe("prefer-product");
  });

  it("reads absent, `either` and anything unrecognized as `either`", () => {
    expect(offerAnchorOf({})).toBe("either");
    expect(offerAnchorOf({ offerAnchor: "either" })).toBe("either");
    // A misspelling must not silently half-apply: it is the default.
    expect(offerAnchorOf({ offerAnchor: "prefer_product" })).toBe("either");
    expect(offerAnchorOf({ offerAnchor: "product" })).toBe("either");
    expect(offerAnchorOf({ offerAnchor: 3 })).toBe("either");
  });
});
