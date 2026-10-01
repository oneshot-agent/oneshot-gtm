import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailIdentity } from "../src/types.ts";

// The IMAP Sent readers: read-only, and the keyed lookup searches by the
// Message-ID header rather than counting everything sent to the recipient.

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  open: vi.fn(),
  boxes: [] as Array<{ path: string; flags: Set<string>; specialUse?: string }>,
  fetched: [] as Array<{ uid: number; internalDate: Date; envelope: Record<string, unknown> }>,
}));
vi.mock("../src/mailbox-config.ts", () => ({
  smartleadMailboxIdentities: () => [],
  resetMailboxConnections: vi.fn(),
  mailboxConnection: async () => ({
    address: "jn@mail.example",
    imap: { host: "imap.example.com", port: 993, secure: true, user: "jn", pass: "x" },
    smtp: { host: "smtp.example.com", port: 465, secure: true, user: "jn", pass: "x" },
  }),
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    on() {}
    async connect() {}
    async logout() {}
    close() {}
    async list() {
      return mocks.boxes;
    }
    async mailboxOpen(path: string, opts: unknown) {
      mocks.open(path, opts);
    }
    async search(query: unknown, opts: unknown) {
      return mocks.search(query, opts);
    }
    async *fetch() {
      for (const m of mocks.fetched) yield m;
    }
  },
}));

const { imapMessageIdReader, imapSentReader, PermanentDeliveryError } =
  await import("../src/send-delivery.ts");
const identity: EmailIdentity = {
  id: "smartlead:jn@mail.example",
  provider: "smartlead",
  address: "jn@mail.example",
  maxPerDay: null,
  warmup: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.boxes = [{ path: "[Gmail]/Sent Mail", flags: new Set(), specialUse: "\\Sent" }];
  mocks.search.mockResolvedValue([7]);
  mocks.fetched = [
    {
      uid: 7,
      internalDate: new Date("2026-10-01T10:00:30.000Z"),
      envelope: { messageId: "<abc@mail.example>", subject: "Hello" },
    },
  ];
});

describe("imapMessageIdReader", () => {
  it("opens Sent read-only and searches by the Message-ID header", async () => {
    const copies = await imapMessageIdReader({
      identity,
      messageId: "<abc@mail.example>",
      afterIso: "2026-10-01T09:58:00.000Z",
    });
    expect(mocks.open).toHaveBeenCalledWith("[Gmail]/Sent Mail", { readOnly: true });
    expect(mocks.search.mock.calls[0]![0]).toMatchObject({
      header: { "message-id": "<abc@mail.example>" },
    });
    expect(copies).toEqual([
      { messageId: "<abc@mail.example>", date: "2026-10-01T10:00:30.000Z", subject: "Hello" },
    ]);
  });

  it("is permanent when the mailbox has no Sent folder", async () => {
    mocks.boxes = [{ path: "INBOX", flags: new Set(), specialUse: "\\Inbox" }];
    await expect(
      imapMessageIdReader({ identity, messageId: "<x@y>", afterIso: "2026-10-01T09:58:00.000Z" }),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);
  });
});

describe("imapSentReader", () => {
  it("still counts by recipient inside the window", async () => {
    const copies = await imapSentReader({
      identity,
      recipient: "a@example.org",
      afterIso: "2026-10-01T10:01:00.000Z",
      beforeIso: "2026-10-01T10:30:00.000Z",
    });
    expect(mocks.search.mock.calls[0]![0]).toMatchObject({ to: "a@example.org" });
    // The one copy is before the window.
    expect(copies).toEqual([]);
  });
});
