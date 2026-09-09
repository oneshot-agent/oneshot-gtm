import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The 'calendar access' doctor check (issue #577): live-probes the
// designated calendar identity's token for calendar scope, failing loudly
// with a reconnect hint when the scope is missing or a live call rejects it.

let cfgOverride: Record<string, unknown> = {};
let getGmailProfileImpl: (() => Promise<{ emailAddress: string }>) | null = null;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }),
    oneshotEnvReady: () => false,
    getGmailProfile: async () => {
      if (getGmailProfileImpl) return getGmailProfileImpl();
      return { emailAddress: "jn@x.dev" };
    },
  };
});

const { runDoctor } = await import("../src/check.ts");
const { createWorkspace, saveGmailToken, CALENDAR_READONLY_SCOPE } =
  await import("@oneshot-gtm/core");

let wsDir: string;
beforeEach(() => {
  wsDir = mkdtempSync(join(tmpdir(), "oneshot-doctor-cal-"));
  process.env["ONESHOT_GTM_WORKSPACES"] = wsDir;
  process.env["ONESHOT_GTM_WORKSPACE"] = "gtm";
  createWorkspace("gtm");
  cfgOverride = {};
  getGmailProfileImpl = null;
});
afterEach(() => {
  delete process.env["ONESHOT_GTM_WORKSPACES"];
  delete process.env["ONESHOT_GTM_WORKSPACE"];
  rmSync(wsDir, { recursive: true, force: true });
});

function withCalendarIdentity(scope: string | null): void {
  cfgOverride = {
    calendarIdentityId: "gmail:jn@x.dev",
    calendarId: "primary",
    emailIdentities: [
      {
        id: "gmail:jn@x.dev",
        provider: "gmail",
        address: "jn@x.dev",
        maxPerDay: 0,
        warmup: null,
      },
    ],
  };
  saveGmailToken("gmail:jn@x.dev", { refreshToken: "rt", address: "jn@x.dev", scope });
}

describe("doctor calendar access check", () => {
  it("is absent (null) when calendarIdentityId is unset — feature off, entirely quiet", async () => {
    const checks = await runDoctor();
    expect(checks.find((c) => c.name === "calendar access")).toBeUndefined();
  });

  it("fails when the identity's token carries no calendar scope, with a reconnect hint", async () => {
    withCalendarIdentity(null);
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "calendar access");
    expect(hit?.severity).toBe("fail");
    expect(hit?.message).toContain("no recorded calendar.readonly scope");
    expect(hit?.hint).toContain("Reconnect for calendar");
  });

  it("fails when the scope is Gmail-only (no calendar.readonly)", async () => {
    withCalendarIdentity("https://www.googleapis.com/auth/gmail.send");
    const checks = await runDoctor();
    expect(checks.find((c) => c.name === "calendar access")?.severity).toBe("fail");
  });

  it("passes when the scope is present and the live probe succeeds", async () => {
    withCalendarIdentity(CALENDAR_READONLY_SCOPE);
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "calendar access");
    expect(hit?.severity).toBe("ok");
    expect(hit?.message).toContain("jn@x.dev");
    expect(hit?.message).toContain("primary");
  });

  it("fails when the persisted scope claims calendar but the live call rejects with ACCESS_TOKEN_SCOPE_INSUFFICIENT", async () => {
    withCalendarIdentity(CALENDAR_READONLY_SCOPE);
    getGmailProfileImpl = async () => {
      throw new Error(
        "Gmail API failed (403): ACCESS_TOKEN_SCOPE_INSUFFICIENT — insufficient scope",
      );
    };
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "calendar access");
    expect(hit?.severity).toBe("fail");
    expect(hit?.hint).toContain("Reconnect for calendar");
  });

  it("fails when calendarIdentityId points at a non-existent or non-gmail identity", async () => {
    cfgOverride = { calendarIdentityId: "gmail:never-added@x.dev" };
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "calendar access");
    expect(hit?.severity).toBe("fail");
    expect(hit?.message).toContain("does not point at a connected Gmail identity");
  });
});
