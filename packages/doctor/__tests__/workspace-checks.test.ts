import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cross-workspace guardrails: doctor reads OTHER workspaces' homes by path and
// warns when this one shares a sending domain or a Gmail account with them.

let cfgOverride: Record<string, unknown> = {};
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }),
  };
});

const { runDoctor } = await import("../src/check.ts");
const { createWorkspace } = await import("@oneshot-gtm/core");

let wsDir: string;
beforeEach(() => {
  wsDir = mkdtempSync(join(tmpdir(), "oneshot-doctor-ws-"));
  process.env["ONESHOT_GTM_WORKSPACES"] = wsDir;
  process.env["ONESHOT_GTM_WORKSPACE"] = "gtm";
  createWorkspace("gtm");
  cfgOverride = {};
});
afterEach(() => {
  delete process.env["ONESHOT_GTM_WORKSPACES"];
  delete process.env["ONESHOT_GTM_WORKSPACE"];
  rmSync(wsDir, { recursive: true, force: true });
});

function otherWorkspace(name: string, config: unknown, tokens?: unknown): void {
  const entry = createWorkspace(name);
  mkdirSync(entry.home, { recursive: true });
  writeFileSync(join(entry.home, "config.json"), JSON.stringify(config));
  if (tokens) writeFileSync(join(entry.home, "gmail-tokens.json"), JSON.stringify(tokens));
}

describe("doctor workspace checks", () => {
  it("names the current workspace first", async () => {
    const checks = await runDoctor();
    expect(checks[0]).toMatchObject({ name: "workspace", severity: "ok" });
    expect(checks[0]?.message.startsWith("gtm · ")).toBe(true);
  });

  it("warns when another workspace uses the same sending domain", async () => {
    cfgOverride = {
      emailIdentities: [
        {
          id: "oneshot:me@acme.email",
          provider: "oneshot",
          sendingDomain: "acme.email",
          maxPerDay: 50,
          warmup: null,
        },
      ],
    };
    otherWorkspace("sdk", {
      emailIdentities: [
        {
          id: "oneshot:hi@acme.email",
          provider: "oneshot",
          sendingDomain: "ACME.email",
          maxPerDay: 50,
          warmup: null,
        },
      ],
    });
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "sending domain acme.email");
    expect(hit?.severity).toBe("warn");
    expect(hit?.message).toContain("workspace 'sdk'");
  });

  it("warns when another workspace authorized the same Gmail account (via its token store)", async () => {
    cfgOverride = {
      emailIdentities: [
        {
          id: "gmail:me@gmail.com",
          provider: "gmail",
          address: "me@gmail.com",
          maxPerDay: 50,
          warmup: null,
        },
      ],
    };
    otherWorkspace(
      "sdk",
      { emailIdentities: [] },
      { "gmail:me@gmail.com": { refreshToken: "rt", address: "Me@Gmail.com" } },
    );
    const checks = await runDoctor();
    expect(checks.find((c) => c.name === "gmail me@gmail.com")?.severity).toBe("warn");
  });

  it("stays quiet when workspaces are properly separated", async () => {
    cfgOverride = {
      emailIdentities: [
        {
          id: "oneshot:me@gtm.email",
          provider: "oneshot",
          sendingDomain: "gtm.email",
          maxPerDay: 50,
          warmup: null,
        },
      ],
    };
    otherWorkspace("sdk", {
      emailIdentities: [
        {
          id: "oneshot:me@sdk.email",
          provider: "oneshot",
          sendingDomain: "sdk.email",
          maxPerDay: 50,
          warmup: null,
        },
      ],
    });
    const checks = await runDoctor();
    expect(
      checks.some((c) => c.name.startsWith("sending domain") || c.name.startsWith("gmail ")),
    ).toBe(false);
  });
});
