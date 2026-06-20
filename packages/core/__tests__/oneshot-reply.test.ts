import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// replyEmail dispatch: a reply goes out from the identity whose mailbox
// received the inbound email — Gmail path threads (threadId + In-Reply-To),
// records a cost-0 "email.reply" receipt, and never touches sender rotation.
// Config + ledger are mocked so no real ~/.oneshot-gtm is touched.

const recordReceipt = vi.fn().mockReturnValue(7);
let cfgOverride: Record<string, unknown> = {};
let tokenStoreOverride: Record<string, { refreshToken: string; address: string }> = {};

// Fake OneShot SDK so the OneShot reply/send path is exercised without a wallet
// or network. `email` captures the opts we pass (reply_to_email_id + idempotencyKey).
const emailMock = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>) => ({
    status: "sent",
    request_id: "os-req-1",
    cost: 0.04,
    email: { id: "os-mail-1", provider_message_id: "os-mail-1", status: "sent" },
  })),
);
vi.mock("@oneshot-agent/sdk", () => ({
  OneShot: class {
    email = emailMock;
  },
}));

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      founderName: "Jane Doe",
      emailIdentities: null,
      ...cfgOverride,
    }),
    loadGmailTokens: () => tokenStoreOverride,
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    getLedger: () => ({
      recordReceipt,
      // Rotation dependencies for the sendEmail() path: fresh prospect, no pins.
      getSenderAssignment: () => null,
      hasPriorEmailSend: () => false,
      assignSender: (_email: string, id: string) => id,
      countEmailSendsSince: () => 0,
      firstEmailSendAt: () => null,
    }),
  };
});

const { replyEmail, replySubject, sendEmail } = await import("../src/oneshot.ts");
const { _resetGmailCache } = await import("../src/gmail.ts");

const GMAIL_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const k of GMAIL_KEYS) {
    envSnapshot[k] = process.env[k];
    process.env[k] = "test";
  }
  _resetGmailCache();
  recordReceipt.mockClear();
  cfgOverride = {
    emailIdentities: [
      { id: "gmail:jane@gmail.com", provider: "gmail", maxPerDay: 50, warmup: null },
    ],
  };
  tokenStoreOverride = {
    "gmail:jane@gmail.com": { refreshToken: "rt-jane", address: "jane@gmail.com" },
  };
});

afterEach(() => {
  for (const k of GMAIL_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  _resetGmailCache();
  vi.unstubAllGlobals();
});

function stubGmailFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (u.endsWith("/profile")) {
      return new Response(JSON.stringify({ emailAddress: "jane@gmail.com" }), { status: 200 });
    }
    if (u.endsWith("/messages/send")) {
      return new Response(JSON.stringify({ id: "gm-9", threadId: "t-9" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("replySubject", () => {
  it('prepends "Re: " once, case-insensitively', () => {
    expect(replySubject("quick question")).toBe("Re: quick question");
    expect(replySubject("Re: quick question")).toBe("Re: quick question");
    expect(replySubject("RE: quick question")).toBe("RE: quick question");
    expect(replySubject("  trustclaw stack ")).toBe("Re: trustclaw stack");
  });
});

describe("replyEmail — gmail identity", () => {
  it("sends a threaded reply from the receiving account and records a cost-0 email.reply receipt", async () => {
    const fetchMock = stubGmailFetch();
    const out = await replyEmail(
      {
        identityId: "gmail:jane@gmail.com",
        to: "pat@acme.com",
        subject: "trustclaw stack",
        body: "Hey Pat,\n\nfair point.",
        threadId: "t-9",
        inReplyTo: "<pat-msg-1@mail.acme.com>",
      },
      { playName: "inbox-reply" },
    );

    expect(out.result.cost).toBe(0);
    expect(out.result.request_id).toBe("gm-9");
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        playName: "inbox-reply",
        callType: "email.reply",
        costUsd: 0,
        senderIdentity: "gmail:jane@gmail.com",
        signedReceipt: expect.objectContaining({
          provider: "gmail",
          thread_id: "t-9",
          subject: "Re: trustclaw stack",
        }),
      }),
    );

    const sendCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/messages/send"));
    const payload = JSON.parse(String((sendCall![1] as RequestInit).body)) as {
      raw: string;
      threadId?: string;
    };
    // threadId is a Message-resource field — threads our copy in the sender's mailbox.
    expect(payload.threadId).toBe("t-9");
    const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(mime).toContain("Subject: Re: trustclaw stack");
    expect(mime).toMatch(/^In-Reply-To: <pat-msg-1@mail\.acme\.com>$/m);
    expect(mime).toMatch(/^References: <pat-msg-1@mail\.acme\.com>$/m);
    expect(mime).toContain('From: "Jane Doe" <jane@gmail.com>');
  });

  it("sends without threading fields when the inbound carried none", async () => {
    const fetchMock = stubGmailFetch();
    await replyEmail(
      {
        identityId: "gmail:jane@gmail.com",
        to: "pat@acme.com",
        subject: "Re: ping",
        body: "b",
      },
      { playName: "inbox-reply" },
    );
    const sendCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/messages/send"));
    const payload = JSON.parse(String((sendCall![1] as RequestInit).body)) as {
      raw: string;
      threadId?: string;
    };
    expect(payload.threadId).toBeUndefined();
    const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(mime).not.toMatch(/^In-Reply-To:/m);
  });
});

describe("replyEmail — error paths", () => {
  it("throws on an unknown identity id", async () => {
    await expect(
      replyEmail(
        { identityId: "gmail:gone@x.com", to: "a@b.com", subject: "s", body: "b" },
        { playName: "inbox-reply" },
      ),
    ).rejects.toThrow(/unknown sender identity/);
  });

  it("throws (not env-token fallback) when the identity has no stored refresh token", async () => {
    tokenStoreOverride = {};
    await expect(
      replyEmail(
        { identityId: "gmail:jane@gmail.com", to: "a@b.com", subject: "s", body: "b" },
        { playName: "inbox-reply" },
      ),
    ).rejects.toThrow(/no Gmail refresh token/);
  });
});

describe("replyEmail — oneshot identity (SDK 0.19 threading + idempotency)", () => {
  beforeEach(() => {
    process.env["AGENT_PRIVATE_KEY"] = "0xtest";
    emailMock.mockClear();
    cfgOverride = {
      emailIdentities: [
        {
          id: "legacy-oneshot",
          provider: "oneshot",
          sendingDomain: "oneshotagents.com",
          maxPerDay: null,
          warmup: null,
        },
      ],
    };
  });
  afterEach(() => delete process.env["AGENT_PRIVATE_KEY"]);

  it("threads via reply_to_email_id, carries an idempotency key, and records a paid email.reply receipt", async () => {
    const out = await replyEmail(
      {
        identityId: "legacy-oneshot",
        to: "pat@acme.com",
        subject: "trustclaw stack",
        body: "Hey Pat, fair point.",
        replyToEmailId: "inbox-abc",
      },
      { playName: "inbox-reply" },
    );

    expect(emailMock).toHaveBeenCalledTimes(1);
    const opts = emailMock.mock.calls[0]![0] as {
      reply_to_email_id?: string;
      idempotencyKey?: string;
      from_domain?: string;
    };
    expect(opts.reply_to_email_id).toBe("inbox-abc");
    expect(opts.idempotencyKey).toMatch(/^[0-9a-f]{40}$/);
    expect(opts.from_domain).toBe("oneshotagents.com");

    expect(out.result.request_id).toBe("os-req-1");
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callType: "email.reply",
        costUsd: 0.04,
        senderIdentity: "legacy-oneshot",
        // recordCallReceipt mirrors the same audit fields it sends to OneShot.
        memo: expect.any(String),
        decisionContext: expect.objectContaining({
          playName: "inbox-reply",
          callType: "email.reply",
        }),
      }),
    );
  });

  it("derives a stable idempotency key (same content → same key; different body → different key)", async () => {
    const base = {
      identityId: "legacy-oneshot",
      to: "pat@acme.com",
      subject: "re: x",
      replyToEmailId: "inbox-abc",
    };
    await replyEmail({ ...base, body: "same body" }, { playName: "inbox-reply" });
    await replyEmail({ ...base, body: "same body" }, { playName: "inbox-reply" });
    await replyEmail({ ...base, body: "DIFFERENT body" }, { playName: "inbox-reply" });
    const keys = emailMock.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("degrades to a fresh send (no reply_to_email_id) when the inbound id is absent", async () => {
    await replyEmail(
      { identityId: "legacy-oneshot", to: "pat@acme.com", subject: "ping", body: "b" },
      { playName: "inbox-reply" },
    );
    const opts = emailMock.mock.calls[0]![0] as { reply_to_email_id?: string; subject?: string };
    expect(opts.reply_to_email_id).toBeUndefined();
    expect(opts.subject).toBe("Re: ping");
  });

  it("sendEmail (the main cadence/queue path) also carries an idempotency key", async () => {
    await sendEmail(
      { to: "pat@acme.com", subject: "saw your launch", body: "Hey Pat, nice work." },
      { playName: "show-hn" },
    );
    const opts = emailMock.mock.calls[0]![0] as {
      idempotencyKey?: string;
      reply_to_email_id?: string;
    };
    expect(opts.idempotencyKey).toMatch(/^[0-9a-f]{40}$/);
    // A normal send is not a reply.
    expect(opts.reply_to_email_id).toBeUndefined();
  });
});
