import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A cadence follow-up sent into the first email's thread (`SendEmailInput.thread`),
// on the Gmail and OneShot transports. SMTP is covered in oneshot-keyed-send.
// Config + ledger are mocked so no real ~/.oneshot-gtm is touched; the keyed
// send runs on a real scratch ledger.

const recordReceipt = vi.fn().mockReturnValue(11);
let cfgOverride: Record<string, unknown> = {};
let tokenStoreOverride: Record<string, { refreshToken: string; address: string }> = {};

const emailMock = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>) => ({
    status: "sent",
    request_id: "os-req-2",
    cost: 0.04,
    email: { id: "os-mail-2", provider_message_id: "os-mail-2", status: "sent" },
  })),
);
vi.mock("@oneshot-agent/sdk", () => ({
  OneShot: class {
    email = emailMock;
  },
  ValidationError: class extends Error {},
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
      suppressionFor: () => null,
      contactSuppressionFor: () => null,
      recordReceipt,
      outboundSends: scratch.outboundSends,
      getSenderAssignment: () => null,
      hasPriorEmailSend: () => false,
      assignSender: (_email: string, id: string) => id,
      countEmailSendsSince: () => 0,
      firstEmailSendAt: () => null,
      withSendCapacityLock: <T>(fn: () => T) => fn(),
      reserveSendSlot: () => 1,
      releaseSendReservation: () => {},
      liveSendReservations: () => ({ byGroup: new Map(), byIdentity: new Map() }),
    }),
  };
});

const { sendEmail, gmailSentMessageIdFor, withoutReplyPrefix } = await import("../src/oneshot.ts");
const { _resetGmailCache } = await import("../src/gmail.ts");
const { Ledger } = await import("../src/ledger.ts");
let scratch: InstanceType<typeof Ledger>;

const GMAIL = "gmail:alpha@gmail.com";
const ONESHOT = "oneshot-alpha";
const INTRO_ID = "<CAintro123@mail.gmail.com>";
const GMAIL_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;
let envSnapshot: Record<string, string | undefined> = {};
let n = 0;

beforeEach(() => {
  envSnapshot = {};
  for (const k of GMAIL_KEYS) {
    envSnapshot[k] = process.env[k];
    process.env[k] = "test";
  }
  _resetGmailCache();
  recordReceipt.mockClear();
  emailMock.mockClear();
  scratch = new Ledger(":memory:");
  tokenStoreOverride = { [GMAIL]: { refreshToken: "rt-alpha", address: "alpha@gmail.com" } };
});

afterEach(() => {
  for (const k of GMAIL_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  _resetGmailCache();
  vi.unstubAllGlobals();
  delete process.env["AGENT_PRIVATE_KEY"];
});

function recipient(): string {
  return `beta-${Date.now()}-${n++}@example.org`;
}

function stubGmailFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (new URL(u).host === "oauth2.googleapis.com") {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (u.endsWith("/profile")) {
      return new Response(JSON.stringify({ emailAddress: "alpha@gmail.com" }), { status: 200 });
    }
    if (u.endsWith("/messages/send")) {
      return new Response(JSON.stringify({ id: "gm-2", threadId: "th-intro" }), { status: 200 });
    }
    if (u.includes("/messages/gm-intro?")) {
      return new Response(
        JSON.stringify({
          id: "gm-intro",
          threadId: "th-intro",
          internalDate: "0",
          payload: { headers: [{ name: "Message-ID", value: INTRO_ID }] },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function gmailSend(fetchMock: ReturnType<typeof vi.fn>): { raw: string; threadId?: string } {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/messages/send"));
  const body = JSON.parse(String((call![1] as RequestInit).body)) as {
    raw: string;
    threadId?: string;
  };
  return { ...body, raw: Buffer.from(body.raw, "base64url").toString("utf8") };
}

describe("withoutReplyPrefix", () => {
  it("drops one leading Re: in any case", () => {
    expect(withoutReplyPrefix("Re: alpha")).toBe("alpha");
    expect(withoutReplyPrefix("RE:alpha")).toBe("alpha");
    expect(withoutReplyPrefix("alpha re: beta")).toBe("alpha re: beta");
  });
});

describe("gmail: a follow-up into the first email's thread", () => {
  beforeEach(() => {
    cfgOverride = {
      emailIdentities: [{ id: GMAIL, provider: "gmail", maxPerDay: 50, warmup: null }],
    };
  });

  it("attaches the thread id and sets In-Reply-To/References", async () => {
    const fetchMock = stubGmailFetch();
    const to = recipient();
    const key = `gtm:test:email:alpha:${to}:1`;
    const out = await sendEmail(
      {
        to,
        subject: "Re: alpha pipeline",
        body: "one more thing",
        idempotencyKey: key,
        thread: {
          identityId: GMAIL,
          inReplyTo: INTRO_ID,
          references: [INTRO_ID],
          gmailThreadId: "th-intro",
        },
      },
      { playName: "alpha" },
    );
    const sent = gmailSend(fetchMock);
    expect(sent.threadId).toBe("th-intro");
    expect(sent.raw).toContain(`In-Reply-To: ${INTRO_ID}`);
    expect(sent.raw).toContain(`References: ${INTRO_ID}`);
    expect(sent.raw).toContain("Subject: Re: alpha pipeline");
    expect(out.subject).toBe("Re: alpha pipeline");
    expect(scratch.outboundSends.get(key)).toMatchObject({
      transport: "gmail",
      inReplyTo: INTRO_ID,
      references: [INTRO_ID],
    });
  });

  it("from another sender: no thread id, no headers, no Re:", async () => {
    const fetchMock = stubGmailFetch();
    const to = recipient();
    await sendEmail(
      {
        to,
        subject: "Re: alpha pipeline",
        body: "b",
        idempotencyKey: `gtm:test:email:alpha:${to}:1`,
        thread: { identityId: "gmail:beta@gmail.com", inReplyTo: INTRO_ID, gmailThreadId: "t" },
      },
      { playName: "alpha" },
    );
    const sent = gmailSend(fetchMock);
    expect(sent.threadId).toBeUndefined();
    expect(sent.raw).not.toContain("In-Reply-To");
    expect(sent.raw).not.toContain("References");
    expect(sent.raw).toContain("Subject: alpha pipeline");
  });

  it("reads the RFC Message-ID Gmail assigned to a sent email", async () => {
    stubGmailFetch();
    expect(await gmailSentMessageIdFor(GMAIL, "gm-intro")).toBe(INTRO_ID);
    // Not a Gmail identity in the pool: nothing to look up.
    expect(await gmailSentMessageIdFor("gmail:nobody@gmail.com", "gm-intro")).toBeNull();
  });
});

describe("oneshot: a follow-up into the first email's thread", () => {
  beforeEach(() => {
    process.env["AGENT_PRIVATE_KEY"] = "0xtest";
    cfgOverride = {
      emailIdentities: [
        {
          id: ONESHOT,
          provider: "oneshot",
          sendingDomain: "alpha.example.com",
          maxPerDay: null,
          warmup: null,
        },
      ],
    };
  });

  const thread = { identityId: ONESHOT, oneshotEmailId: "em-intro" };

  it("passes reply_to_email_id with the Re: subject", async () => {
    const to = recipient();
    const out = await sendEmail(
      { to, subject: "Re: alpha", body: "b", idempotencyKey: `k:${to}`, thread },
      { playName: "alpha" },
    );
    expect(emailMock).toHaveBeenCalledTimes(1);
    const opts = emailMock.mock.calls[0]![0] as { reply_to_email_id?: string; subject: string };
    expect(opts.reply_to_email_id).toBe("em-intro");
    expect(opts.subject).toBe("Re: alpha");
    expect(out.subject).toBe("Re: alpha");
  });

  it("reply_target_not_found: retries once as a new email under the same key", async () => {
    const to = recipient();
    const key = `k:${to}`;
    emailMock.mockRejectedValueOnce(
      Object.assign(new Error("Email quote failed"), {
        statusCode: 404,
        responseBody: JSON.stringify({ error: "reply_target_not_found" }),
      }),
    );
    const out = await sendEmail(
      { to, subject: "Re: alpha", body: "b", idempotencyKey: key, thread },
      { playName: "alpha" },
    );
    expect(emailMock).toHaveBeenCalledTimes(2);
    const [first, retry] = emailMock.mock.calls.map(
      (c) => c[0] as { reply_to_email_id?: string; subject: string; idempotencyKey: string },
    );
    expect(first!.reply_to_email_id).toBe("em-intro");
    expect(retry!.reply_to_email_id).toBeUndefined();
    expect(retry!.subject).toBe("alpha");
    expect(retry!.idempotencyKey).not.toBe(first!.idempotencyKey);
    expect(out.subject).toBe("alpha");
    // One email, one receipt, one row.
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(scratch.outboundSends.get(key)).toMatchObject({
      status: "confirmed",
      subject: "alpha",
      attempts: 2,
    });
  });

  it("any other failure is not retried without the thread", async () => {
    const to = recipient();
    const key = `k:${to}`;
    emailMock.mockRejectedValueOnce(new Error("Job timed out after 120s"));
    await expect(
      sendEmail(
        { to, subject: "Re: alpha", body: "b", idempotencyKey: key, thread },
        { playName: "alpha" },
      ),
    ).rejects.toThrow(/may have gone out/);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(scratch.outboundSends.get(key)?.status).toBe("uncertain");
  });

  it("an exact resend of the fallback goes out as the fallback did", async () => {
    const to = recipient();
    const key = `k:${to}`;
    emailMock.mockRejectedValueOnce(
      Object.assign(new Error("Email quote failed"), { statusCode: 404, responseBody: "" }),
    );
    emailMock.mockRejectedValueOnce(new Error("Job timed out after 120s"));
    await expect(
      sendEmail(
        { to, subject: "Re: alpha", body: "b", idempotencyKey: key, thread },
        { playName: "alpha" },
      ),
    ).rejects.toThrow(/may have gone out/);
    // The sweep settles it; the next run resends the stored fallback content.
    scratch.outboundSends.mark(key, "failed");
    await sendEmail(
      { to, subject: "Re: alpha", body: "b", idempotencyKey: key, thread },
      { playName: "alpha" },
    );
    const calls = emailMock.mock.calls.map(
      (c) => c[0] as { reply_to_email_id?: string; subject: string; idempotencyKey: string },
    );
    expect(calls).toHaveLength(3);
    expect(calls[2]!.reply_to_email_id).toBeUndefined();
    expect(calls[2]!.subject).toBe("alpha");
    expect(calls[2]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  });

  it("without a OneShot email id: a new email, no Re:", async () => {
    const to = recipient();
    await sendEmail(
      {
        to,
        subject: "Re: alpha",
        body: "b",
        idempotencyKey: `k:${to}`,
        thread: { identityId: ONESHOT, inReplyTo: INTRO_ID },
      },
      { playName: "alpha" },
    );
    const opts = emailMock.mock.calls[0]![0] as { reply_to_email_id?: string; subject: string };
    expect(opts.reply_to_email_id).toBeUndefined();
    expect(opts.subject).toBe("alpha");
  });
});
