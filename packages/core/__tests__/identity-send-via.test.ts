import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import type { EmailIdentity, OneShotConfig } from "../src/types.ts";

// `sendVia` on a Smartlead identity: validated against the mailbox's direct
// credentials (fail closed), persisted under the same id, and the test send
// that exercises it.

const mocks = vi.hoisted(() => ({
  pool: [] as EmailIdentity[],
  saved: [] as OneShotConfig[],
  creds: true,
  lookupDown: false,
  LookupError: class extends Error {},
  smtp: { verify: vi.fn(), sendMail: vi.fn(), close: vi.fn() },
}));
let ledger: Ledger;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), emailIdentities: mocks.pool }),
    saveConfig: (cfg: OneShotConfig) => {
      mocks.saved.push(cfg);
      mocks.pool = cfg.emailIdentities ?? [];
    },
  };
});
vi.mock("../src/ledger.ts", async (original) => ({
  ...(await original<typeof import("../src/ledger.ts")>()),
  getLedger: () => ledger,
}));
vi.mock("../src/mailbox-config.ts", () => ({
  MailboxLookupError: mocks.LookupError,
  smartleadMailboxIdentities: () => mocks.pool.filter((i) => i.provider === "smartlead"),
  resetMailboxConnections: vi.fn(),
  mailboxConnection: async (id: string) => {
    const identity = mocks.pool.find((i) => i.id === id);
    if (!identity?.address || !mocks.creds)
      throw new Error("Direct mailbox credentials are unavailable.");
    const box = { user: identity.address, pass: "x", secure: true, port: 465 };
    return {
      address: identity.address,
      imap: { ...box, host: "imap.gmail.com", port: 993 },
      smtp: { ...box, host: "smtp.gmail.com" },
    };
  },
  mailboxConnectionForAddress: async (address: string) => {
    if (mocks.lookupDown)
      throw new mocks.LookupError("Could not reach Smartlead to resolve mailbox connections.");
    if (!mocks.creds) throw new Error("Connect IMAP and SMTP for this Smartlead mailbox.");
    const box = { user: address, pass: "x", secure: true };
    return {
      address,
      imap: { ...box, host: "imap.gmail.com", port: 993 },
      smtp: { ...box, host: "smtp.gmail.com", port: 465 },
    };
  },
}));
vi.mock("nodemailer", async (original) => {
  const actual = await original<typeof import("nodemailer")>();
  return {
    default: {
      createTransport: (options: { streamTransport?: boolean }) =>
        options.streamTransport ? actual.default.createTransport(options) : mocks.smtp,
    },
  };
});

const { setIdentitySendVia, validateSendVia, parseSendVia, defaultSendViaForSmartlead } =
  await import("../src/identity-send-via.ts");
const { sendTestEmail } = await import("../src/oneshot.ts");
const { outboundMessageId } = await import("../src/ledger-outbound.ts");

const SL: EmailIdentity = {
  id: "smartlead:jn@mail.example",
  provider: "smartlead",
  address: "jn@mail.example",
  maxPerDay: 40,
  warmup: { startPerDay: 10, incrementPerWeek: 10 },
};
const OS: EmailIdentity = {
  id: "oneshot:jn@os.example",
  provider: "oneshot",
  sendingDomain: "os.example",
  mailbox: "jn",
  maxPerDay: 50,
  warmup: null,
};

beforeEach(() => {
  ledger = new Ledger(":memory:");
  mocks.pool = [SL, OS];
  mocks.saved = [];
  mocks.creds = true;
  vi.clearAllMocks();
  mocks.smtp.verify.mockResolvedValue(true);
  mocks.smtp.sendMail.mockResolvedValue({ accepted: ["x"] });
});

describe("sendVia", () => {
  it("flips a Smartlead mailbox to smtp under the same id, keeping its cap and ramp", async () => {
    const out = await setIdentitySendVia(SL.id, "smtp");
    expect(out).toEqual({ changed: true, smtpHost: "smtp.gmail.com" });
    const flipped = mocks.pool.find((i) => i.id === SL.id);
    expect(flipped).toEqual({ ...SL, sendVia: "smtp" });
    expect((await setIdentitySendVia(SL.id, "smtp")).changed).toBe(false);
    await setIdentitySendVia(SL.id, "provider");
    expect(mocks.pool.find((i) => i.id === SL.id)).toEqual(SL);
  });

  it("refuses smtp when the mailbox's direct credentials do not resolve", async () => {
    mocks.creds = false;
    await expect(setIdentitySendVia(SL.id, "smtp")).rejects.toThrow(/credentials/);
    expect(mocks.saved).toEqual([]);
  });

  it("refuses smtp on a non-Smartlead identity and an unknown id", async () => {
    await expect(validateSendVia(OS.id, "smtp")).rejects.toThrow(/Smartlead mailboxes/);
    await expect(validateSendVia("smartlead:nobody@x.example", "smtp")).rejects.toThrow(
      /No identity/,
    );
    expect(await validateSendVia(OS.id, "provider")).toEqual({ smtpHost: null });
  });

  it("a new mailbox defaults to smtp when its credentials resolve, else provider with the reason", async () => {
    expect(await defaultSendViaForSmartlead("new@mail.example")).toEqual({
      sendVia: "smtp",
      reason: null,
      lookupFailed: false,
    });
    mocks.creds = false;
    expect(await defaultSendViaForSmartlead("new@mail.example")).toEqual({
      sendVia: "provider",
      reason: "Connect IMAP and SMTP for this Smartlead mailbox.",
      lookupFailed: false,
    });
    expect(mocks.saved).toEqual([]);
  });

  it("flags a Smartlead outage as a failed lookup, not missing credentials", async () => {
    mocks.lookupDown = true;
    try {
      expect(await defaultSendViaForSmartlead("new@mail.example")).toEqual({
        sendVia: "provider",
        reason: "Could not reach Smartlead to resolve mailbox connections.",
        lookupFailed: true,
      });
    } finally {
      mocks.lookupDown = false;
    }
  });

  it("parses only the two transports", () => {
    expect(parseSendVia("smtp")).toBe("smtp");
    expect(() => parseSendVia("api")).toThrow(/provider" or "smtp/);
  });
});

describe("sendTestEmail", () => {
  it("dry run resolves credentials and prints the Message-ID without sending", async () => {
    const { plan, result } = await sendTestEmail({
      identityId: SL.id,
      to: "Me@Example.com",
      step: "a",
      dryRun: true,
    });
    expect(result).toBeNull();
    expect(mocks.smtp.sendMail).not.toHaveBeenCalled();
    expect(plan).toMatchObject({
      from: "jn@mail.example",
      to: "me@example.com",
      smtpHost: "smtp.gmail.com",
      existing: null,
      messageId: outboundMessageId(plan.key, "jn@mail.example"),
    });
    expect(ledger.outboundSends.get(plan.key)).toBeNull();
  });

  it("a live send goes out once; the same step replays", async () => {
    const live = await sendTestEmail({ identityId: SL.id, to: "me@example.com", step: "b" });
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(ledger.outboundSends.get(live.plan.key)?.status).toBe("submitted");
    const again = await sendTestEmail({ identityId: SL.id, to: "me@example.com", step: "b" });
    expect(again.plan.existing).toBe("submitted");
    expect(again.plan.messageId).toBe(live.plan.messageId);
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-Smartlead identity before anything runs", async () => {
    await expect(
      sendTestEmail({ identityId: OS.id, to: "me@example.com", dryRun: true }),
    ).rejects.toThrow(/Smartlead mailboxes/);
  });
});
