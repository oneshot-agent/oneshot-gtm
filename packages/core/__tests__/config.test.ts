import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { llmApiKey, oneshotEnvReady, SECRET_KEYS } from "../src/config.ts";

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
