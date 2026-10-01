import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { Ledger } from "../src/ledger.ts";
import type { EmailIdentity } from "../src/types.ts";

// Keyed sends through a Smartlead mailbox's own SMTP (`sendVia: "smtp"`), on a
// real ledger: the semantic key is claimed in outbound_sends before SMTP runs,
// the Message-ID is derived from the key, and the outcome decides whether the
// contact touch is kept and whether the next attempt may send.

const mocks = vi.hoisted(() => ({
  identities: [] as EmailIdentity[],
  creds: true,
  smtp: { verify: vi.fn(), sendMail: vi.fn(), close: vi.fn() },
  fetch: vi.fn(),
}));
let ledger: Ledger;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      founderName: "Jane Doe",
      emailIdentities: mocks.identities,
    }),
  };
});
vi.mock("../src/ledger.ts", async (original) => ({
  ...(await original<typeof import("../src/ledger.ts")>()),
  getLedger: () => ledger,
}));
vi.mock("../src/mailbox-config.ts", () => ({
  smartleadMailboxIdentities: () => mocks.identities,
  resetMailboxConnections: vi.fn(),
  mailboxConnection: async (id: string) => {
    const identity = mocks.identities.find((i) => i.id === id);
    if (!identity?.address || !mocks.creds) {
      throw new Error(
        "Direct mailbox credentials are unavailable. Connect IMAP and SMTP in the inbox's mailbox settings.",
      );
    }
    const box = { user: identity.address, pass: "secret", secure: true, port: 465 };
    // smtp.gmail.com: the server files its own Sent copy, so no IMAP append runs.
    return {
      address: identity.address,
      imap: { ...box, host: "imap.gmail.com", port: 993 },
      smtp: { ...box, host: "smtp.gmail.com" },
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

const {
  sendEmail,
  replyEmail,
  outboundSendKey,
  outboundMessageId,
  contentSendKey,
  UncertainSendError,
} = await import("../src/oneshot.ts");
const { parseMailboxMessage } = await import("../src/mailbox.ts");
const { currentWorkspaceName } = await import("../src/shared-db.ts");
const { isSendDeferred } = await import("../src/send-routing.ts");
const { getSharedDb } = await import("../src/shared-db.ts");

const SMTP_ID: EmailIdentity = {
  id: "smartlead:jane@mail.example.com",
  provider: "smartlead",
  address: "jane@mail.example.com",
  maxPerDay: 50,
  warmup: null,
  sendVia: "smtp",
};

const ctx = { playName: "test-play" };
let to = "";
let n = 0;

beforeEach(() => {
  ledger = new Ledger(":memory:");
  mocks.identities = [SMTP_ID];
  mocks.creds = true;
  vi.clearAllMocks();
  mocks.smtp.verify.mockResolvedValue(true);
  mocks.smtp.sendMail.mockResolvedValue({ accepted: ["x"] });
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  // A fresh recipient per test: contact touches live in the shared DB.
  to = `prospect-${Date.now()}-${n++}@example.org`;
});
afterEach(() => {
  ledger.close();
  vi.unstubAllGlobals();
});

function keyFor(step: number | string = 0) {
  return outboundSendKey({ play: "test-play", who: to, step });
}

async function sentMessageId(call = 0): Promise<string | undefined> {
  const raw = (mocks.smtp.sendMail.mock.calls[call]![0] as { raw: Buffer }).raw;
  return (await simpleParser(raw)).messageId;
}

describe("semantic keys", () => {
  it("are stable across a re-draft, unlike the content fallback", () => {
    const a = { to, subject: "first draft", body: "one" };
    const b = { to, subject: "rewritten", body: "two" };
    expect(outboundSendKey({ play: "p", who: to, step: 0 })).toBe(
      outboundSendKey({ play: "p", who: to.toUpperCase(), step: 0 }),
    );
    expect(outboundSendKey({ play: "p", who: to, step: 0 })).not.toBe(
      outboundSendKey({ play: "p", who: to, step: 1 }),
    );
    expect(contentSendKey(SMTP_ID.id, a)).not.toBe(contentSendKey(SMTP_ID.id, b));
  });

  it("derive a deterministic Message-ID at the sender's domain", () => {
    const id = outboundMessageId("k", "jane@mail.example.com");
    expect(id).toMatch(/^<[0-9a-f]{32}@mail\.example\.com>$/);
    expect(outboundMessageId("k", "jane@mail.example.com")).toBe(id);
    expect(outboundMessageId("other", "jane@mail.example.com")).not.toBe(id);
  });

  it("an unknown outcome defers instead of failing the caller", () => {
    expect(isSendDeferred(new UncertainSendError("x"))).toBe(true);
  });
});

describe("sendVia smtp", () => {
  it("sends through the mailbox's SMTP under the key's Message-ID, never the Smartlead API", async () => {
    const key = keyFor();
    const out = await sendEmail({ to, subject: "hi", body: "hello", idempotencyKey: key }, ctx);
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    const expected = outboundMessageId(key, SMTP_ID.address!);
    expect(await sentMessageId()).toBe(expected);
    expect(out.result.request_id).toBe(expected);
    const row = ledger.outboundSends.get(key)!;
    expect(row).toMatchObject({
      status: "submitted",
      transport: "smtp",
      messageId: expected,
      receiptId: out.receiptId,
      attempts: 1,
      // smtp.gmail.com files its own Sent copy.
      sentEvidence: true,
    });
    expect(getSharedDb().touchesFor(to)[0]?.status).toBe("sent");
  });

  it("replays a re-drafted email under the same key instead of sending it again", async () => {
    const key = keyFor();
    const first = await sendEmail({ to, subject: "v1", body: "one", idempotencyKey: key }, ctx);
    const again = await sendEmail(
      { to, subject: "v2 rewritten", body: "two", idempotencyKey: key },
      ctx,
    );
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(again.receiptId).toBe(first.receiptId);
    expect(again.result.request_id).toBe(first.result.request_id);
  });

  it("keeps the touch and blocks the next attempt when the outcome is unknown", async () => {
    const key = keyFor();
    // Dropped after DATA: no SMTP response code.
    mocks.smtp.sendMail.mockRejectedValueOnce(Object.assign(new Error("socket hang up")));
    const err = await sendEmail({ to, subject: "s", body: "b", idempotencyKey: key }, ctx).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UncertainSendError);
    expect(ledger.outboundSends.get(key)?.status).toBe("uncertain");
    expect(getSharedDb().touchesFor(to)[0]?.status).toBe("sent");

    await expect(
      sendEmail({ to, subject: "s", body: "b", idempotencyKey: key }, ctx),
    ).rejects.toBeInstanceOf(UncertainSendError);
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
  });

  it("releases the touch on a definite rejection and retries under the same Message-ID", async () => {
    const key = keyFor();
    mocks.smtp.sendMail.mockRejectedValueOnce(
      Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 }),
    );
    await expect(
      sendEmail({ to, subject: "s", body: "b", idempotencyKey: key }, ctx),
    ).rejects.toThrow(/rejected/);
    expect(ledger.outboundSends.get(key)?.status).toBe("failed");
    expect(
      getSharedDb()
        .touchesFor(to)
        .filter((t) => t.status === "sent"),
    ).toHaveLength(0);

    await sendEmail({ to, subject: "s", body: "b", idempotencyKey: key }, ctx);
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(2);
    expect(await sentMessageId(0)).toBe(await sentMessageId(1));
    expect(ledger.outboundSends.get(key)).toMatchObject({ status: "submitted", attempts: 2 });
  });

  it("treats a connect or auth failure as definite: nothing was submitted", async () => {
    const key = keyFor();
    mocks.smtp.verify.mockRejectedValueOnce(new Error("Invalid login"));
    await expect(
      sendEmail({ to, subject: "s", body: "b", idempotencyKey: key }, ctx),
    ).rejects.toThrow();
    expect(mocks.smtp.sendMail).not.toHaveBeenCalled();
    expect(ledger.outboundSends.get(key)?.status).toBe("failed");
  });

  it("fails closed without mailbox credentials: no fallback to the Smartlead API", async () => {
    mocks.creds = false;
    const key = keyFor();
    await expect(
      sendEmail({ to, subject: "s", body: "b", idempotencyKey: key }, ctx),
    ).rejects.toThrow(/credentials are unavailable/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.smtp.sendMail).not.toHaveBeenCalled();
    // Nothing was attempted, so nothing was claimed, and the touch is released.
    expect(ledger.outboundSends.get(key)).toBeNull();
    expect(
      getSharedDb()
        .touchesFor(to)
        .filter((t) => t.status === "sent"),
    ).toHaveLength(0);
  });

  it("falls back to a content key when the caller passes none", async () => {
    await sendEmail({ to, subject: "s", body: "b" }, ctx);
    const key = contentSendKey(SMTP_ID.id, { to, subject: "s", body: "b" });
    expect(ledger.outboundSends.get(key)?.status).toBe("submitted");
  });
});

describe("sendVia provider (the default)", () => {
  it("still sends through the Smartlead API, unkeyed", async () => {
    const prior = process.env["SMARTLEAD_API_KEY"];
    process.env["SMARTLEAD_API_KEY"] = "sl-test-key";
    try {
      mocks.identities = [{ ...SMTP_ID, sendVia: undefined }];
      mocks.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { message_id: "msg_1" } }), {
          status: 200,
        }),
      );
      const key = keyFor();
      await sendEmail({ to, subject: "s", body: "b", idempotencyKey: key }, ctx);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.smtp.sendMail).not.toHaveBeenCalled();
      expect(ledger.outboundSends.get(key)).toBeNull();
    } finally {
      if (prior === undefined) delete process.env["SMARTLEAD_API_KEY"];
      else process.env["SMARTLEAD_API_KEY"] = prior;
    }
  });
});

describe("mailbox replies", () => {
  async function inbound(id: string) {
    const raw = Buffer.from(
      `From: ${to}\r\nTo: ${SMTP_ID.address}\r\nMessage-ID: <${id}@example.org>\r\nSubject: Question\r\nDate: Wed, 30 Sep 2026 10:00:00 +0000\r\n\r\nHow does it work?`,
    );
    const m = await parseMailboxMessage(
      raw,
      { identityId: SMTP_ID.id, address: SMTP_ID.address!, fallbackId: id },
      ledger,
    );
    ledger.mailboxes.put(m);
    return m;
  }
  const replyKey = (requestId: string) => `gtm:${currentWorkspaceName()}:reply:${requestId}`;

  it("records the reply in outbound_sends under its send request id", async () => {
    const m = await inbound("q1");
    const out = await replyEmail(
      {
        identityId: SMTP_ID.id,
        inboundEmailId: m.id,
        sendRequestId: "req-1",
        to,
        subject: "Question",
        body: "Like this.",
      },
      ctx,
    );
    const row = ledger.outboundSends.get(replyKey("req-1"))!;
    expect(row).toMatchObject({ status: "submitted", transport: "smtp", receiptId: out.receiptId });
    expect(row.messageId).toBe(await sentMessageId());
  });

  it("an unknown reply outcome is uncertain, with the Message-ID it went out under", async () => {
    const m = await inbound("q2");
    mocks.smtp.sendMail.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      replyEmail(
        {
          identityId: SMTP_ID.id,
          inboundEmailId: m.id,
          sendRequestId: "req-2",
          to,
          subject: "Question",
          body: "Like this.",
        },
        ctx,
      ),
    ).rejects.toThrow(/unknown/);
    const row = ledger.outboundSends.get(replyKey("req-2"))!;
    expect(row.status).toBe("uncertain");
    expect(row.messageId).toBe(await sentMessageId());
  });
});
