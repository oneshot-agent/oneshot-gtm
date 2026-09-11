import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { simpleParser } from "mailparser";

const mocks = vi.hoisted(() => ({
  identities: [
    { id: "smartlead:me@example.com", address: "me@example.com", provider: "smartlead" },
  ],
  uidValidity: 1n,
  open: vi.fn(),
  failUser: "",
  mails: [] as { uid: number; source: Buffer; threadId?: string }[],
  smtp: { verify: vi.fn(), sendMail: vi.fn(), close: vi.fn() },
}));
let ledger: Ledger;
vi.mock("../src/ledger.ts", async (original) => ({
  ...(await original<typeof import("../src/ledger.ts")>()),
  getLedger: () => ledger,
}));
vi.mock("../src/mailbox-config.ts", () => ({
  smartleadMailboxIdentities: () => mocks.identities,
  resetMailboxConnections: vi.fn(),
  mailboxConnection: async (id: string) => {
    const identity = mocks.identities.find((i) => i.id === id);
    if (!identity) throw new Error("This mailbox was removed.");
    return {
      address: identity.address,
      imap: {
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        user: identity.address,
        pass: "secret",
      },
      smtp: {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        user: identity.address,
        pass: "secret",
      },
    };
  },
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(private options: { auth: { user: string } }) {}
    on() {}
    async connect() {
      if (this.options.auth.user === mocks.failUser) throw new Error("secret auth error");
    }
    close() {}
    async list() {
      return [{ path: "INBOX", flags: new Set(), specialUse: "\\Inbox" }];
    }
    async mailboxOpen(path: string, options: unknown) {
      mocks.open(path, options);
      return { uidValidity: mocks.uidValidity };
    }
    async search(query: { uid?: string }) {
      const min = query.uid ? Number(query.uid.split(":")[0]) : 0;
      return mocks.mails.filter((m) => m.uid >= min).map((m) => m.uid);
    }
    async fetchAll(uids: number[]) {
      return mocks.mails.filter((m) => uids.includes(m.uid));
    }
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
  parseMailboxMessage,
  mailboxReplyMessage,
  sendMailboxReply,
  syncSmartleadMailboxes,
  mailboxHealth,
  listMailboxInbox,
  listMailboxBounces,
} = await import("../src/mailbox.ts");
const identityId = "smartlead:me@example.com";
const source = (id: string, headers = "", from = "prospect@example.org") =>
  Buffer.from(
    `From: ${from}\r\nTo: me@example.com\r\nMessage-ID: <${id}@example.org>\r\nSubject: Hello\r\nDate: Wed, 9 Sep 2026 10:00:00 +0000\r\n${headers}\r\nThanks for reaching out.`,
  );
async function parsed(id: string, headers = "", from?: string) {
  return parseMailboxMessage(
    source(id, headers, from),
    { identityId, address: "me@example.com", fallbackId: id },
    ledger,
  );
}
async function put(id = "first", headers = "") {
  const m = await parsed(id, headers);
  ledger.mailboxes.put(m);
  return m;
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
  mocks.identities = [{ id: identityId, address: "me@example.com", provider: "smartlead" }];
  mocks.mails = [];
  mocks.uidValidity = 1n;
  mocks.failUser = "";
  vi.clearAllMocks();
  mocks.smtp.verify.mockResolvedValue(true);
  mocks.smtp.sendMail.mockResolvedValue({ accepted: ["prospect@example.org"] });
});
afterEach(() => ledger.close());

describe("durable mailbox threads", () => {
  it.each(["delivered", "replied"] as const)(
    "retains %s outreach in the backfill watermark",
    (status) => {
      const id = ledger.upsertProspect({ email: "person@example.com", source: "test" });
      ledger.recordSequenceEvent({
        prospectId: id,
        playName: "test",
        stepIndex: 0,
        channel: "email",
        status,
      });
      expect(ledger.mailboxes.oldestOutreach()).not.toBeNull();
    },
  );

  it("allows retry after SMTP explicitly accepts no recipients", async () => {
    const inbound = await put();
    mocks.smtp.sendMail.mockResolvedValueOnce({ accepted: [] });
    await expect(sendMailboxReply(inbound.id, "answer", "rejected-all")).rejects.toThrow(
      /not sent/,
    );
    expect(ledger.mailboxes.attempt("rejected-all")?.status).toBe("failed");
    await sendMailboxReply(inbound.id, "answer", "retry-rejected-all");
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(2);
    expect(ledger.mailboxes.attempt("retry-rejected-all")?.status).toBe("sent");
  });

  it("keeps identical messages and organization isolated across workspaces", async () => {
    const other = new Ledger(":memory:");
    try {
      const m = await put();
      other.mailboxes.put(m);
      ledger.mailboxes.changeState(m.threadKey, [m.id], { read: true, archived: true });
      expect(ledger.mailboxes.threadState(m.threadKey)).toMatchObject({
        unread: false,
        archivedAt: expect.any(String),
      });
      expect(other.mailboxes.threadState(m.threadKey)).toMatchObject({
        unread: true,
        archivedAt: null,
      });
    } finally {
      other.close();
    }
  });
  it("deduplicates folder copies and does not reopen archived threads on re-fetch", async () => {
    const m = await put();
    ledger.mailboxes.changeState(m.threadKey, [m.id], { archived: true });
    expect(ledger.mailboxes.put(m)).toBe(false);
    expect(ledger.mailboxes.threadState(m.threadKey).archivedAt).not.toBeNull();
    expect(ledger.mailboxes.all()).toHaveLength(1);
  });
  it("rejects stale archives, keeps unseen arrivals unread, and reopens on new mail", async () => {
    const first = await put();
    ledger.mailboxes.changeState(first.threadKey, [first.id], { archived: true, read: true });
    const next = {
      ...(await parsed("second", "In-Reply-To: <first@example.org>\r\n")),
      at: new Date(Date.now() + 1000).toISOString(),
    };
    ledger.mailboxes.put(next);
    expect(next.threadKey).toBe(first.threadKey);
    expect(() =>
      ledger.mailboxes.changeState(first.threadKey, [first.id], { archived: true }),
    ).toThrow(/changed/);
    ledger.mailboxes.changeState(first.threadKey, [first.id], { read: true });
    expect(ledger.mailboxes.threadState(first.threadKey)).toMatchObject({
      unread: true,
      archivedAt: null,
    });
  });
  it("matches referenced outreach when the reply uses another address", async () => {
    const prospectId = ledger.upsertProspect({ email: "prospect@example.org" });
    const outbound = { ...(await parsed("outbound")), direction: "outbound" as const, prospectId };
    ledger.mailboxes.put(outbound);
    const reply = await parsed(
      "reply",
      "References: <outbound@example.org>\r\n",
      "alternate@example.org",
    );
    expect(reply.prospectId).toBe(prospectId);
    expect(reply.threadKey).toBe(outbound.threadKey);
  });
  it("never merges same-subject threads or two sending identities", async () => {
    const first = await put();
    const second = await put("different");
    expect(first.threadKey).not.toBe(second.threadKey);
    const another = await parseMailboxMessage(
      source("first"),
      {
        identityId: "smartlead:other@example.com",
        address: "other@example.com",
        fallbackId: "first",
      },
      ledger,
    );
    expect(another.threadKey).not.toBe(first.threadKey);
    expect(another.id).not.toBe(first.id);
  });
  it("keeps a partial-reference thread together when older ancestors arrive later", async () => {
    const child = await put("child", "In-Reply-To: <parent@example.org>\r\n");
    const parent = await put("parent", "In-Reply-To: <root@example.org>\r\n");
    const root = await put("root");
    expect(parent.threadKey).toBe(child.threadKey);
    expect(root.threadKey).toBe(child.threadKey);
  });
  it("does not mark a read thread unread when loading older history", async () => {
    const recent = await put();
    ledger.mailboxes.changeState(recent.threadKey, [recent.id], { read: true });
    ledger.mailboxes.put({ ...recent, id: "older", at: "2026-09-01T00:00:00Z" });
    expect(ledger.mailboxes.threadState(recent.threadKey).unread).toBe(false);
  });
  it("keeps manually matched old messages available behind the global watermark", async () => {
    const m = await put();
    const prospectId = ledger.upsertProspect({ email: "different@example.org" });
    ledger.mailboxes.associate(m.threadKey, prospectId);
    expect(ledger.mailboxes.inbound(identityId, "2099-01-01T00:00:00Z")).toHaveLength(1);
  });
  it("classifies auto replies using headers and decodes HTML-only mail", async () => {
    const m = await parseMailboxMessage(
      Buffer.from(
        "From: bot@example.org\r\nTo: me@example.com\r\nAuto-Submitted: auto-replied\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Out of office</p>",
      ),
      { identityId, address: "me@example.com", fallbackId: "auto" },
      ledger,
    );
    expect(m.kind).toBe("auto");
    expect(m.body).toContain("Out of office");
    expect(() => mailboxReplyMessage(m, "me@example.com", "Hi")).toThrow(/Message-ID/);
  });
});

describe("mailbox sync", () => {
  it("extracts structured delivery failures and exposes them to the bounce pipeline", async () => {
    const prospectId = ledger.upsertProspect({ email: "prospect@example.org" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "outreach",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    const raw = Buffer.from(
      "From: mailer-daemon@example.com\r\nTo: me@example.com\r\nMessage-ID: <dsn@example.com>\r\nSubject: Delivery Status Notification (Failure)\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; boundary=dsn; report-type=delivery-status\r\n\r\n--dsn\r\nContent-Type: text/plain\r\n\r\nAddress not found\r\n--dsn\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; example.com\r\n\r\nFinal-Recipient: rfc822; prospect@example.org\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 No such user\r\n\r\n--dsn--\r\n",
    );
    const m = await parseMailboxMessage(
      raw,
      { identityId, address: "me@example.com", fallbackId: "dsn" },
      ledger,
    );
    expect(m.kind).toBe("auto");
    expect(m.bounces?.[0]).toMatchObject({
      recipient: "prospect@example.org",
      kind: "hard",
      statusCode: "5.1.1",
    });
    ledger.mailboxes.put(m);
    expect(listMailboxBounces().bounces[0]).toMatchObject({
      recipient: "prospect@example.org",
      identityId,
      messageId: m.id,
    });
    ledger.mailboxes.put({
      ...m,
      id: "warmup-dsn",
      bounces: [
        {
          recipient: "warmup@example.net",
          kind: "hard",
          statusCode: "5.1.1",
          diagnostic: "No such user",
        },
      ],
    });
    expect(listMailboxBounces().bounces).toHaveLength(1);
  });
  it("reclassifies a previously imported explicit opt-out for cadence processing", async () => {
    const m = {
      ...(await parsed("unsubscribe")),
      body: "Don’t ever email me again.",
      kind: "human" as const,
    };
    ledger.mailboxes.put(m);
    await syncSmartleadMailboxes(true);
    expect(ledger.mailboxes.get(m.id)?.kind).toBe("unsubscribe");
  });
  it("pages imports, resumes checkpoints, and opens folders read-only", async () => {
    mocks.mails = Array.from({ length: 105 }, (_, i) => ({
      uid: i + 1,
      source: source(String(i + 1)),
    }));
    await syncSmartleadMailboxes(true);
    expect(ledger.mailboxes.all()).toHaveLength(105); // Includes newest tail while backfilling.
    expect(mailboxHealth()[0]?.backfillRemaining).toBe(true);
    await syncSmartleadMailboxes(true);
    expect(ledger.mailboxes.all()).toHaveLength(105);
    expect(mailboxHealth()[0]?.backfillRemaining).toBe(false);
    expect(mocks.open).toHaveBeenCalledWith("INBOX", { readOnly: true });
    mocks.uidValidity = 2n;
    await syncSmartleadMailboxes(true);
    expect(ledger.mailboxes.all()).toHaveLength(105);
  });
  it("reports partial failures without hiding other connected mailboxes", async () => {
    mocks.identities.push({
      id: "smartlead:bad@example.com",
      address: "bad@example.com",
      provider: "smartlead",
    });
    mocks.failUser = "bad@example.com";
    mocks.mails = [{ uid: 1, source: source("first") }];
    await syncSmartleadMailboxes(true);
    expect(mailboxHealth().map((h) => h.status)).toEqual(["connected", "error"]);
    expect(JSON.stringify(mailboxHealth())).not.toContain("secret");
    expect((await listMailboxInbox("smartlead:bad@example.com")).failed_sources).toEqual([
      "smartlead:bad@example.com",
    ]);
  });
  it("discovers newly registered identities without fixed workspace names", async () => {
    mocks.identities = [];
    await syncSmartleadMailboxes(true);
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.identities = [
      { id: "smartlead:new@another.org", address: "new@another.org", provider: "smartlead" },
    ];
    await syncSmartleadMailboxes(true);
    expect(mailboxHealth()[0]?.address).toBe("new@another.org");
  });
});

describe("threaded replies", () => {
  it("uses stored routing, real reply headers, and a stable send attempt", async () => {
    const inbound = await put();
    const message = await sendMailboxReply(inbound.id, "Here is my answer.", "send-request-one");
    const raw = mocks.smtp.sendMail.mock.calls[0]![0].raw as Buffer;
    const wire = await simpleParser(raw);
    expect(wire.inReplyTo).toBe(inbound.messageId);
    expect(wire.references).toContain(inbound.messageId);
    expect(wire.from?.value[0]?.address).toBe("me@example.com");
    expect(wire.subject).toBe("Re: Hello");
    expect(message.threadKey).toBe(inbound.threadKey);
    expect(
      (await sendMailboxReply(inbound.id, "Here is my answer.", "send-request-one")).messageId,
    ).toBe(message.messageId);
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
  });
  it("does not resend after a timeout, even if the client supplies a new request ID", async () => {
    const inbound = await put();
    mocks.smtp.sendMail.mockRejectedValue(new Error("connection lost after DATA"));
    await expect(sendMailboxReply(inbound.id, "answer", "send-unknown")).rejects.toThrow(/unknown/);
    expect(ledger.mailboxes.attempt("send-unknown")?.status).toBe("uncertain");
    await expect(sendMailboxReply(inbound.id, "answer edited", "send-another")).rejects.toThrow(
      /reconciled/,
    );
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
  });
  it("reconciles an uncertain send when its Sent copy arrives", async () => {
    const inbound = await put();
    mocks.smtp.sendMail.mockRejectedValue(new Error("lost response"));
    await expect(sendMailboxReply(inbound.id, "answer", "send-reconcile")).rejects.toThrow();
    const attempt = ledger.mailboxes.attempt("send-reconcile")!;
    ledger.mailboxes.put(attempt.message);
    await syncSmartleadMailboxes(true);
    expect(ledger.mailboxes.attempt(attempt.id)?.status).toBe("sent");
    await sendMailboxReply(inbound.id, "answer", attempt.id);
    expect(mocks.smtp.sendMail).toHaveBeenCalledTimes(1);
  });
  it("keeps failed sends out of sent history and rejects removed identities", async () => {
    const inbound = await put();
    mocks.smtp.verify.mockRejectedValue(new Error("bad password"));
    await expect(sendMailboxReply(inbound.id, "answer", "failed-request")).rejects.toThrow(
      /not sent/,
    );
    expect(ledger.mailboxes.attempt("failed-request")?.status).toBe("failed");
    expect(ledger.mailboxes.thread(inbound.threadKey)).toHaveLength(1);
    mocks.identities = [];
    await expect(sendMailboxReply(inbound.id, "answer", "removed-request")).rejects.toThrow(
      /removed/,
    );
  });
});
