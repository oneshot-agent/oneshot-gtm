import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cross-workspace guardrails: doctor reads OTHER workspaces' homes by path and
// warns when this one shares a sending domain or a Gmail account with them.

let cfgOverride: Record<string, unknown> = {};
let walletReady = false;
let balanceValue = "1 USDC";
let ledgerMock: {
  bounceStatsByIdentity?: () => Map<string, { hard: number; block: number }>;
  countEmailSendsSince?: (identityId: string, _since: string) => number;
  latestCanaryResult?: () => {
    placement: string;
    created_at: string;
    spf: string;
    dkim: string;
    dmarc: string;
    same_domain: number;
  } | null;
  listTriggers?: () => Array<{ name: string; enabled: number; config_json?: string }>;
  listReceipts?: () => unknown[];
} = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }),
    oneshotEnvReady: () => walletReady,
    getBalance: async () => ({ balance: balanceValue, raw: balanceValue }),
    getLedger: () => ({
      bounceStatsByIdentity: ledgerMock.bounceStatsByIdentity || (() => new Map()),
      countEmailSendsSince: ledgerMock.countEmailSendsSince || (() => 0),
      latestCanaryResult: ledgerMock.latestCanaryResult || (() => null),
      listTriggers: ledgerMock.listTriggers || (() => []),
      listReceipts: ledgerMock.listReceipts || (() => []),
    }),
  };
});

const { runDoctor } = await import("../src/check.ts");
const { createWorkspace, secretsPath } = await import("@oneshot-gtm/core");

let wsDir: string;
beforeEach(() => {
  wsDir = mkdtempSync(join(tmpdir(), "oneshot-doctor-ws-"));
  process.env["ONESHOT_GTM_WORKSPACES"] = wsDir;
  process.env["ONESHOT_GTM_WORKSPACE"] = "gtm";
  createWorkspace("gtm");
  cfgOverride = {};
  walletReady = false;
  balanceValue = "1 USDC";
  ledgerMock = {};
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

  it("every check carries a valid group (the dashboard panel keys sections off it)", async () => {
    const checks = await runDoctor();
    const valid = new Set(["install", "senders", "deliverability", "finders", "spend"]);
    for (const c of checks) {
      expect(valid.has(c.group), `check '${c.name}' has group '${c.group}'`).toBe(true);
    }
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

describe("deliverability / bounce-rate check", () => {
  const gmailIdentity = {
    id: "gmail:test@gmail.com",
    provider: "gmail",
    address: "test@gmail.com",
    maxPerDay: 50,
    warmup: null,
  };

  describe("pass cases", () => {
    it("pass: zero bounce rate with sufficient volume (0/20)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 0, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 20 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("0.0% bounced");
    });

    it("pass: bounce rate below 2% warn threshold (1/100 = 1%)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 1, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 100 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("1.0% bounced");
    });

    it("warn: exactly 2% bounce rate is OK (boundary is exclusive)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 2, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 100 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("2.0% bounced");
    });
  });

  describe("warn cases", () => {
    it("warn: just over 2% bounce rate (2.1%)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 21, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 1000 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("2.1% bounced");
    });

    it("warn: below 5% fail threshold but above 2% (4%)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 4, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 100 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("4.0% bounced");
    });

    it("warn: zero bounce rate but 1+ spam blocks", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 0, block: 1 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 50 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("1 spam-block");
    });

    it("fail: exactly 5% bounce rate is WARN (boundary is exclusive)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 5, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 100 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("5.0% bounced");
    });
  });

  describe("fail cases", () => {
    it("fail: just over 5% bounce rate (5.1%)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 51, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 1000 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("fail");
      expect(hit?.message).toContain("5.1% bounced");
    });

    it("fail: well above 5% threshold (10%)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 10, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 100 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("fail");
      expect(hit?.message).toContain("10.0% bounced");
    });
  });

  describe("minimum volume threshold (19 vs 20 sends)", () => {
    it("below minimum (19 sends): reports as 'too few sends to rate' with ok severity", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 1, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 19 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("too few sends to rate");
      expect(hit?.message).toContain("1 hard");
      expect(hit?.message).toContain("19 sent");
    });

    it("at minimum (20 sends): reports bounce rate normally", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 1, block: 0 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 20 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("5.0% bounced");
      expect(hit?.message).not.toContain("too few");
    });

    it("below minimum with spam blocks: warns even with < 20 sends", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () =>
        new Map([["gmail:test@gmail.com", { hard: 0, block: 1 }]]);
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 10 : 0);
      const checks = await runDoctor();
      const hit = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("test@gmail.com"),
      );
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("too few sends to rate");
      expect(hit?.message).toContain("1 spam-block");
    });
  });

  describe("'not covered' verdict vs zero bounce rate", () => {
    it("oneshot provider is 'not covered' (blind)", async () => {
      cfgOverride = {
        emailIdentities: [
          {
            id: "oneshot:me@test.email",
            provider: "oneshot",
            sendingDomain: "test.email",
            maxPerDay: 50,
            warmup: null,
          },
        ],
      };
      ledgerMock.bounceStatsByIdentity = () => new Map();
      const checks = await runDoctor();
      const blind = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("not covered"),
      );
      expect(blind?.severity).toBe("warn");
      expect(blind?.message).toContain("1 identity not covered");
      expect(blind?.message).toContain("oneshot");
    });

    it("smartlead provider is 'not covered' (blind)", async () => {
      cfgOverride = {
        emailIdentities: [
          {
            id: "smartlead:test@acme.com",
            provider: "smartlead",
            address: "test@acme.com",
            maxPerDay: 50,
            warmup: null,
          },
        ],
      };
      ledgerMock.bounceStatsByIdentity = () => new Map();
      const checks = await runDoctor();
      const blind = checks.find(
        (c) => c.name === "deliverability" && c.message.includes("not covered"),
      );
      expect(blind?.severity).toBe("warn");
      expect(blind?.message).toContain("1 identity not covered");
      expect(blind?.message).toContain("smartlead");
    });

    it("gmail with zero bounces: returns 'no delivery failures' message (not per-identity)", async () => {
      cfgOverride = { emailIdentities: [gmailIdentity] };
      ledgerMock.bounceStatsByIdentity = () => new Map(); // No bounce stats at all => stats.size === 0
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 50 : 0);
      const checks = await runDoctor();
      const allDeliverability = checks.filter((c) => c.name === "deliverability");
      const hit = allDeliverability.find((c) => c.message.includes("no delivery failures"));
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("no delivery failures recorded");
      expect(allDeliverability.some((c) => c.message.includes("not covered"))).toBe(false);
    });

    it("no identities at all: reports 'no Gmail identity to monitor'", async () => {
      cfgOverride = { emailIdentities: [] };
      ledgerMock.bounceStatsByIdentity = () => new Map();
      const checks = await runDoctor();
      const allDeliverability = checks.filter((c) => c.name === "deliverability");
      const hit = allDeliverability.find((c) => c.message.includes("no Gmail identity"));
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("no Gmail identity to monitor");
    });

    it("mixed: oneshot + gmail with zero bounces shows 'not covered' then 'no delivery failures'", async () => {
      cfgOverride = {
        emailIdentities: [
          {
            id: "oneshot:me@test.email",
            provider: "oneshot",
            sendingDomain: "test.email",
            maxPerDay: 50,
            warmup: null,
          },
          gmailIdentity,
        ],
      };
      ledgerMock.bounceStatsByIdentity = () => new Map(); // No bounce stats => early exit after blind check
      ledgerMock.countEmailSendsSince = (id: string) => (id === "gmail:test@gmail.com" ? 30 : 0);
      const checks = await runDoctor();
      const allDeliverability = checks.filter((c) => c.name === "deliverability");
      // First check: the "not covered" warning for oneshot
      const blind = allDeliverability.find((c) => c.message.includes("not covered"));
      expect(blind).toBeDefined();
      expect(blind?.severity).toBe("warn");
      expect(blind?.message).toContain("oneshot");
      // Second check: the global "no delivery failures" message (stats.size === 0 returns early)
      const globalHit = allDeliverability.find((c) => c.message.includes("no delivery failures"));
      expect(globalHit).toBeDefined();
      expect(globalHit?.severity).toBe("ok");
    });
  });
});

describe("placement check", () => {
  describe("pass cases", () => {
    it("pass: placement is 'primary' (ideal)", async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -5);
      ledgerMock.latestCanaryResult = () => ({
        placement: "primary",
        created_at: tenDaysAgo,
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        same_domain: 0,
      });
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("primary");
      expect(hit?.message).toContain("10d ago");
    });
  });

  describe("warn cases", () => {
    it("warn: placement is 'promotions' tab", async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -5);
      ledgerMock.latestCanaryResult = () => ({
        placement: "promotions",
        created_at: fiveDaysAgo,
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        same_domain: 0,
      });
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("promotions");
    });

    it("warn: placement is 'tab' (generic)", async () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -5);
      ledgerMock.latestCanaryResult = () => ({
        placement: "tab",
        created_at: threeDaysAgo,
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        same_domain: 0,
      });
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("tab");
    });

    it("warn: placement is 'not_delivered'", async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -5);
      ledgerMock.latestCanaryResult = () => ({
        placement: "not_delivered",
        created_at: twoDaysAgo,
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        same_domain: 0,
      });
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("not_delivered");
    });

    it("warn: same_domain flag is set (not a real-world verdict)", async () => {
      const oneDayAgo = new Date(Date.now() - 1 * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -5);
      ledgerMock.latestCanaryResult = () => ({
        placement: "primary",
        created_at: oneDayAgo,
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        same_domain: 1,
      });
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("same-domain, not a real-world verdict");
    });

    it("warn: result is stale (> 14 days old)", async () => {
      const twentyDaysAgo = new Date(Date.now() - 20 * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -5);
      ledgerMock.latestCanaryResult = () => ({
        placement: "primary",
        created_at: twentyDaysAgo,
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        same_domain: 0,
      });
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("20d ago");
      expect(hit?.hint).toContain("last tested 20d ago");
    });
  });

  describe("fail cases", () => {
    it("fail: placement is 'spam'", async () => {
      const oneDayAgo = new Date(Date.now() - 1 * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, -5);
      ledgerMock.latestCanaryResult = () => ({
        placement: "spam",
        created_at: oneDayAgo,
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        same_domain: 0,
      });
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("fail");
      expect(hit?.message).toContain("spam");
    });
  });

  describe("never tested case", () => {
    it("ok with hint: never tested (latestCanaryResult is null)", async () => {
      ledgerMock.latestCanaryResult = () => null;
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "inbox placement");
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("never tested");
      expect(hit?.hint).toContain("bun run cli -- gmail placement");
    });
  });
});

describe("github token check", () => {
  beforeEach(() => {
    delete process.env["GITHUB_TOKEN"];
  });

  it("pass: both finders off, no check emitted", async () => {
    ledgerMock.listTriggers = () => [];
    const checks = await runDoctor();
    expect(checks.find((c) => c.name === "github token")).toBeUndefined();
  });

  it("pass: one finder on with token set", async () => {
    process.env["GITHUB_TOKEN"] = "ghp_test123";
    ledgerMock.listTriggers = () => [{ name: "github-stars", enabled: 1 }];
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "github token");
    expect(hit?.severity).toBe("ok");
    expect(hit?.message).toContain("5,000 req/hr");
  });

  it("warn: one finder on without token", async () => {
    ledgerMock.listTriggers = () => [{ name: "github-stars", enabled: 1 }];
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "github token");
    expect(hit?.severity).toBe("warn");
    expect(hit?.message).toContain("GITHUB_TOKEN not set");
    expect(hit?.message).toContain("60 req/hr");
    expect(hit?.hint).toContain(secretsPath());
  });

  it("warn: multiple finders enabled without token", async () => {
    ledgerMock.listTriggers = () => [
      { name: "github-stars", enabled: 1 },
      { name: "github-watch", enabled: 1 },
    ];
    const checks = await runDoctor();
    const hit = checks.find((c) => c.name === "github token");
    expect(hit?.severity).toBe("warn");
    expect(hit?.message).toContain("github-stars, github-watch");
  });
});

describe("wallet balance check", () => {
  it.each(["0 USDC", "unavailable"])("warns when the balance is %s", async (balance) => {
    walletReady = true;
    balanceValue = balance;

    const hit = (await runDoctor()).find((c) => c.name === "wallet balance");
    expect(hit?.severity).toBe("warn");
    expect(hit?.hint).toContain("USDC on Base");
  });

  it("passes for a positive parsed balance", async () => {
    walletReady = true;
    balanceValue = "2.50 USDC";

    const hit = (await runDoctor()).find((c) => c.name === "wallet balance");
    expect(hit?.severity).toBe("ok");
  });
});

describe("x credentials check", () => {
  beforeEach(() => {
    delete process.env["TWITTERAPI_IO_KEY"];
    delete process.env["X_API_KEY"];
    delete process.env["X_API_SECRET"];
    delete process.env["X_ACCESS_TOKEN"];
    delete process.env["X_ACCESS_SECRET"];
  });

  describe("xapi engine (first-party, default)", () => {
    it("pass: all four OAuth1 keys set", async () => {
      process.env["X_API_KEY"] = "key";
      process.env["X_API_SECRET"] = "secret";
      process.env["X_ACCESS_TOKEN"] = "token";
      process.env["X_ACCESS_SECRET"] = "access_secret";
      ledgerMock.listTriggers = () => [{ name: "x-reposters", enabled: 1, config_json: "{}" }];
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "x creds (first-party)");
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("OAuth1 user-context creds set");
    });

    it("warn: missing all four keys", async () => {
      ledgerMock.listTriggers = () => [{ name: "x-reposters", enabled: 1, config_json: "{}" }];
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "x creds (first-party)");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain(
        "X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET not set",
      );
    });

    it("warn: partial credentials (only 2 of 4)", async () => {
      process.env["X_API_KEY"] = "key";
      process.env["X_API_SECRET"] = "secret";
      ledgerMock.listTriggers = () => [{ name: "x-reposters", enabled: 1, config_json: "{}" }];
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "x creds (first-party)");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("X_ACCESS_TOKEN, X_ACCESS_SECRET not set");
    });

    it("no check emitted when no x-* triggers enabled", async () => {
      ledgerMock.listTriggers = () => [];
      const checks = await runDoctor();
      expect(checks.find((c) => c.name?.startsWith("x creds"))).toBeUndefined();
    });
  });

  describe("twitterapiio engine", () => {
    it("pass: single TWITTERAPI_IO_KEY set", async () => {
      process.env["TWITTERAPI_IO_KEY"] = "tio_test_key";
      ledgerMock.listTriggers = () => [
        {
          name: "x-reposters",
          enabled: 1,
          config_json: JSON.stringify({ engine: "twitterapiio" }),
        },
      ];
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "x creds (twitterapi.io)");
      expect(hit?.severity).toBe("ok");
      expect(hit?.message).toContain("TWITTERAPI_IO_KEY set");
    });

    it("warn: missing TWITTERAPI_IO_KEY", async () => {
      ledgerMock.listTriggers = () => [
        {
          name: "x-reposters",
          enabled: 1,
          config_json: JSON.stringify({ engine: "twitterapiio" }),
        },
      ];
      const checks = await runDoctor();
      const hit = checks.find((c) => c.name === "x creds (twitterapi.io)");
      expect(hit?.severity).toBe("warn");
      expect(hit?.message).toContain("TWITTERAPI_IO_KEY not set");
    });
  });
});
