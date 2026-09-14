import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The LinkedIn session behind live profile reads: nothing connected is a
// plain "ok" (provider history only), a cookie or a started login without a
// checked session warns, an expired one warns, a checked session reports who
// it is logged in as — whether it came from a hosted login or a cookie.

let cfgOverride: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }),
    oneshotEnvReady: () => false,
    getBalance: async () => ({ balance: "1 USDC", raw: "1 USDC" }),
    getLedger: () => ({
      bounceStatsByIdentity: () => new Map(),
      countEmailSendsSince: () => 0,
      latestCanaryResult: () => null,
      listTriggers: () => [],
      listReceipts: () => [],
    }),
  };
});

const { runDoctor } = await import("../src/check.ts");
const { createWorkspace } = await import("@oneshot-gtm/core");

let wsDir: string;
beforeEach(() => {
  wsDir = mkdtempSync(join(tmpdir(), "oneshot-doctor-li-"));
  process.env["ONESHOT_GTM_WORKSPACES"] = wsDir;
  process.env["ONESHOT_GTM_WORKSPACE"] = "gtm";
  createWorkspace("gtm");
  cfgOverride = {};
  delete process.env["LINKEDIN_SESSION_COOKIE"];
});
afterEach(() => {
  delete process.env["ONESHOT_GTM_WORKSPACES"];
  delete process.env["ONESHOT_GTM_WORKSPACE"];
  delete process.env["LINKEDIN_SESSION_COOKIE"];
  rmSync(wsDir, { recursive: true, force: true });
});

async function linkedinCheck() {
  const results = await runDoctor();
  const check = results.find((r) => r.name === "linkedin session");
  expect(check).toBeDefined();
  return check!;
}

describe("doctor: linkedin session", () => {
  it("unset cookie is ok and says research falls back to provider history", async () => {
    const check = await linkedinCheck();
    expect(check.severity).toBe("ok");
    expect(check.message).toContain("provider history only");
  });

  it("cookie set but never checked warns and points at config linkedin-session", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "AQEDx";
    const check = await linkedinCheck();
    expect(check.severity).toBe("warn");
    expect(check.message).toContain("never checked");
    expect(check.hint).toContain("config linkedin-session");
  });

  it("an expired session warns even when it was once checked", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "AQEDx";
    cfgOverride = {
      linkedinSessionCheckedAt: "2026-09-01T10:00:00.000Z",
      linkedinSessionName: "J. Nicolas",
      linkedinSessionInvalidAt: "2026-09-11T10:00:00.000Z",
    };
    const check = await linkedinCheck();
    expect(check.severity).toBe("warn");
    expect(check.message).toContain("expired");
  });

  it("a checked session is ok and names who it is logged in as", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "AQEDx";
    cfgOverride = {
      linkedinBrowserProfileId: "prof_1",
      linkedinSessionCheckedAt: "2026-09-11T10:00:00.000Z",
      linkedinSessionName: "J. Nicolas",
      linkedinSessionInvalidAt: null,
    };
    const check = await linkedinCheck();
    expect(check.severity).toBe("ok");
    expect(check.message).toContain("logged in as J. Nicolas");
    expect(check.message).toContain("via cookie");
  });

  it("a hosted login needs no cookie: a started one warns, a verified one is ok", async () => {
    cfgOverride = { linkedinBrowserProfileId: "prof_1", linkedinSessionCheckedAt: null };
    const started = await linkedinCheck();
    expect(started.severity).toBe("warn");
    expect(started.message).toContain("browser login");
    expect(started.hint).toContain("finish the login");
    cfgOverride = {
      linkedinBrowserProfileId: "prof_1",
      linkedinSessionCheckedAt: "2026-09-14T10:00:00.000Z",
      linkedinSessionName: "J. Nicolas",
      linkedinSessionInvalidAt: null,
    };
    const verified = await linkedinCheck();
    expect(verified.severity).toBe("ok");
    expect(verified.message).toContain("connected via browser login");
  });
});
