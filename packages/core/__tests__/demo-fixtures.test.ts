import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _applySecretsToEnvForTests, configDir, secretsPath } from "../src/config.ts";
import { demoFixture, demoFixtureDir, demoMode } from "../src/demo.ts";
import { cadenceRocs, getBalance, listInbox, listSendingDomains } from "../src/oneshot.ts";

// ONESHOT_GTM_HOME is a fresh temp dir per test file (vitest.setup.ts), so
// configDir() — and therefore the fixture dir — is already isolated.
const dir = (): string => demoFixtureDir();

function writeFixture(name: string, value: unknown): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), name), JSON.stringify(value));
}

/** One RoCS goal row with the given spend — for the period-keyed fixture tests. */
function g(spend: number): Array<Record<string, unknown>> {
  return [{ goalId: "goal_x", spend, value: 4800, pendingValue: 0, rocs: 1, receiptCount: 8 }];
}

beforeEach(() => {
  rmSync(dir(), { recursive: true, force: true });
  delete process.env["ONESHOT_GTM_DEMO"];
});

afterEach(() => {
  delete process.env["ONESHOT_GTM_DEMO"];
});

describe("demoMode", () => {
  it("is off unless ONESHOT_GTM_DEMO is exactly 1", () => {
    expect(demoMode()).toBe(false);
    process.env["ONESHOT_GTM_DEMO"] = "0";
    expect(demoMode()).toBe(false);
    process.env["ONESHOT_GTM_DEMO"] = "true";
    expect(demoMode()).toBe(false);
    process.env["ONESHOT_GTM_DEMO"] = "1";
    expect(demoMode()).toBe(true);
  });
});

describe("demoFixture", () => {
  it("reads and parses a fixture from the demo home", () => {
    writeFixture("thing.json", { hello: "world" });
    expect(demoFixture<{ hello: string }>("thing.json")).toEqual({ hello: "world" });
  });

  it("returns null when the fixture is missing", () => {
    expect(demoFixture("nope.json")).toBeNull();
  });

  it("returns null on unparseable JSON rather than throwing mid-render", () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "broken.json"), "{ not json");
    expect(demoFixture("broken.json")).toBeNull();
  });

  it("resolves under configDir(), so a relocated home relocates the fixtures", () => {
    expect(dir()).toBe(join(configDir(), "demo"));
  });
});

// No wallet credentials are set in the test env, so `getAgent()` throws. A
// resolved promise is therefore proof that the demo seam short-circuited BEFORE
// any agent construction — which is the property that lets the demo run with
// placeholder keys.
describe("the four network reads under demo mode", () => {
  it("listInbox serves inbox.json", async () => {
    const fixture = {
      emails: [{ id: "e1", from: "a@b.dev", subject: "hi", received_at: "2026-08-01T00:00:00Z" }],
      count: 1,
      has_more: false,
      agent_id: "agent_demo",
    };
    writeFixture("inbox.json", fixture);
    process.env["ONESHOT_GTM_DEMO"] = "1";
    await expect(listInbox({ limit: 200 })).resolves.toEqual(fixture);
  });

  it("cadenceRocs picks the period key from rocs-by-goal.json", async () => {
    writeFixture("rocs-by-goal.json", { "7": g(0.1), "30": g(0.5), all: g(0.9) });
    process.env["ONESHOT_GTM_DEMO"] = "1";
    await expect(cadenceRocs({ periodDays: 7 })).resolves.toEqual(g(0.1));
    await expect(cadenceRocs({ periodDays: 30 })).resolves.toEqual(g(0.5));
    await expect(cadenceRocs()).resolves.toEqual(g(0.9));
    // Unknown period falls back to all-time rather than an empty table.
    await expect(cadenceRocs({ periodDays: 90 })).resolves.toEqual(g(0.9));
  });

  it("cadenceRocs still serves a legacy plain-array fixture for every period", async () => {
    const fixture = [
      { goalId: "goal_x", spend: 0.2, value: 4800, pendingValue: 0, rocs: 24000, receiptCount: 8 },
    ];
    writeFixture("rocs-by-goal.json", fixture);
    process.env["ONESHOT_GTM_DEMO"] = "1";
    await expect(cadenceRocs()).resolves.toEqual(fixture);
    await expect(cadenceRocs({ periodDays: 7 })).resolves.toEqual(fixture);
  });

  it("listSendingDomains serves domains.json", async () => {
    const fixture = [{ domain: "demo.email", pool_status: "active", warmup_score: 87 }];
    writeFixture("domains.json", fixture);
    process.env["ONESHOT_GTM_DEMO"] = "1";
    await expect(listSendingDomains()).resolves.toEqual(fixture);
  });

  it("getBalance serves balance.json", async () => {
    writeFixture("balance.json", { balance: "41.86 USDC", raw: "41.86 USDC" });
    process.env["ONESHOT_GTM_DEMO"] = "1";
    await expect(getBalance()).resolves.toEqual({ balance: "41.86 USDC", raw: "41.86 USDC" });
  });

  it("falls through to the real path when the fixture is absent", async () => {
    process.env["ONESHOT_GTM_DEMO"] = "1";
    // No balance.json written — the seam must not swallow the call, so this
    // reaches getAgent() and fails on the missing wallet credentials.
    await expect(getBalance()).rejects.toThrow(/wallet credentials/i);
  });

  it("ignores fixtures entirely when demo mode is off", async () => {
    writeFixture("balance.json", { balance: "999 USDC", raw: "999 USDC" });
    await expect(getBalance()).rejects.toThrow(/wallet credentials/i);
  });
});

// In demo mode the home's .env must be the SOLE source of secrets. Fill-the-
// blanks is not enough: the CLI parent inherits the real install's secrets
// before spawning the demo server, and Bun auto-loads a repo-root .env into
// every `bun run` child — either would shadow the demo placeholders and hand a
// "demo" dashboard a live wallet. This is the regression test for both paths.
describe("applySecretsToEnv under demo mode", () => {
  const TOUCHED = [
    "OPENROUTER_API_KEY",
    "AGENT_PRIVATE_KEY",
    "CDP_API_KEY_ID",
    "GITHUB_TOKEN",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TOUCHED) saved[k] = process.env[k];
  });

  afterEach(() => {
    delete process.env["ONESHOT_GTM_DEMO"];
    rmSync(secretsPath(), { force: true });
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("overwrites inherited values with the file's, and deletes secrets the file lacks", () => {
    writeFileSync(
      secretsPath(),
      "OPENROUTER_API_KEY=sk-or-demo-placeholder\nAGENT_PRIVATE_KEY=0xdemo\n",
    );
    // Simulate both leak paths: an inherited real key and a Bun-injected one.
    process.env["OPENROUTER_API_KEY"] = "sk-or-REAL";
    process.env["AGENT_PRIVATE_KEY"] = "0xREAL";
    process.env["CDP_API_KEY_ID"] = "real-cdp";
    process.env["GITHUB_TOKEN"] = "ghp_real";

    process.env["ONESHOT_GTM_DEMO"] = "1";
    _applySecretsToEnvForTests();

    expect(process.env["OPENROUTER_API_KEY"]).toBe("sk-or-demo-placeholder");
    expect(process.env["AGENT_PRIVATE_KEY"]).toBe("0xdemo");
    expect(process.env["CDP_API_KEY_ID"]).toBeUndefined();
    expect(process.env["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("keeps fill-the-blanks semantics when demo mode is off", () => {
    writeFileSync(secretsPath(), "OPENROUTER_API_KEY=sk-or-from-file\n");
    process.env["OPENROUTER_API_KEY"] = "sk-or-from-shell";
    delete process.env["AGENT_PRIVATE_KEY"];

    _applySecretsToEnvForTests();

    // Shell value wins; nothing is deleted.
    expect(process.env["OPENROUTER_API_KEY"]).toBe("sk-or-from-shell");
  });
});
