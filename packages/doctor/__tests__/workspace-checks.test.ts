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

describe("second-round review findings (#37)", () => {
  it("an other workspace with an EMPTY identity pool still collides via its sendingDomain", async () => {
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
    otherWorkspace("sdk", { sendingDomain: "acme.email", emailIdentities: [] });
    const checks = await runDoctor();
    expect(checks.find((c) => c.name === "sending domain acme.email")?.severity).toBe("warn");
  });

  it("reports a port collision even when the current workspace is the later entry", async () => {
    // gtm (current) got :3031 in beforeEach; give sdk the same port by editing the registry.
    const { loadRegistry, saveRegistry } = await import("@oneshot-gtm/core");
    otherWorkspace("sdk", { emailIdentities: [] });
    const reg = loadRegistry();
    reg.workspaces["sdk"]!.port = reg.workspaces["gtm"]!.port;
    saveRegistry(reg);
    const checks = await runDoctor();
    expect(checks.some((c) => c.name.startsWith("workspace port"))).toBe(true);
  });
});

describe("third-round review findings (#38)", () => {
  it("detects a shared Gmail account via THIS workspace's token store when the identity has no address", async () => {
    const { saveGmailToken } = await import("@oneshot-gtm/core");
    saveGmailToken("gmail:legacy", { refreshToken: "rt", address: "Me@Gmail.com" });
    cfgOverride = {
      emailIdentities: [{ id: "gmail:legacy", provider: "gmail", maxPerDay: 50, warmup: null }],
    };
    otherWorkspace("sdk", {
      emailIdentities: [
        {
          id: "gmail:me@gmail.com",
          provider: "gmail",
          address: "me@gmail.com",
          maxPerDay: 50,
          warmup: null,
        },
      ],
    });
    const checks = await runDoctor();
    expect(checks.find((c) => c.name === "gmail me@gmail.com")?.severity).toBe("warn");
  });
});

describe("fourth-round review findings (#38)", () => {
  it("a legacy Gmail workspace's unused sendingDomain is not a collision", async () => {
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
      emailProvider: "gmail",
      sendingDomain: "acme.email",
      emailIdentities: null,
    });
    const checks = await runDoctor();
    expect(checks.some((c) => c.name === "sending domain acme.email")).toBe(false);
  });
});

describe("smartlead identities in doctor", () => {
  const SL = {
    id: "smartlead:jane@acme.com",
    provider: "smartlead",
    address: "jane@acme.com",
    maxPerDay: 50,
    warmup: null,
  };

  it("warns when another workspace registered the same Smartlead mailbox", async () => {
    cfgOverride = { emailIdentities: [SL] };
    otherWorkspace("sdk", { emailIdentities: [{ ...SL }] });
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "smartlead jane@acme.com");
    expect(hit?.severity).toBe("warn");
    expect(hit?.message).toContain("'sdk'");
  });

  it("no warning when only this workspace has the mailbox", async () => {
    cfgOverride = { emailIdentities: [SL] };
    otherWorkspace("sdk", { emailIdentities: [] });
    const checks = await runDoctor();
    expect(checks.some((c) => c.name === "smartlead jane@acme.com")).toBe(false);
  });

  it("counts smartlead in the bounce-blind bucket and fails the sender line without a key", async () => {
    const prev = process.env["SMARTLEAD_API_KEY"];
    delete process.env["SMARTLEAD_API_KEY"];
    try {
      cfgOverride = { emailIdentities: [SL] };
      const checks = await runDoctor();
      const blind = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("not covered"),
      );
      expect(blind?.message).toContain("smartlead");
      const sender = checks.find((c) => c.name === "sender smartlead:jane@acme.com");
      expect(sender?.severity).toBe("fail");
      expect(sender?.message).toContain("SMARTLEAD_API_KEY not set");
    } finally {
      if (prev !== undefined) process.env["SMARTLEAD_API_KEY"] = prev;
    }
  });
});
