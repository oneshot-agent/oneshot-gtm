import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { STALE_PENDING_MS } from "../src/ledger-outbound.ts";

let ledger: Ledger;
beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => ledger.close());

const t0 = new Date("2026-10-01T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const input = (over: Partial<Parameters<Ledger["outboundSends"]["claim"]>[0]> = {}) => ({
  key: "gtm:test:email:play:a@example.org:0",
  identityId: "smartlead:me@example.com",
  transport: "smtp",
  recipient: "a@example.org",
  subject: "Hello",
  body: "Hi there",
  messageId: "<abc@example.com>",
  sentEvidence: true,
  now: t0,
  ...over,
});

const rawDb = (l: Ledger) => (l as unknown as { db: import("bun:sqlite").Database }).db;

describe("migrations v10 + v11", () => {
  it("creates outbound_sends with its status, receipt and in-flight reply indexes", () => {
    const names = rawDb(ledger)
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE tbl_name = 'outbound_sends' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual([
      "idx_outbound_sends_receipt",
      "idx_outbound_sends_status",
      "outbound_reply_inflight",
      "outbound_sends",
      "sqlite_autoindex_outbound_sends_1",
    ]);
  });
});

const legacyMessage = (id: string, inboundId: string) => ({
  id: `mailbox:smartlead:me@example.com:${id}`,
  identityId: "smartlead:me@example.com",
  threadKey: `thread-${inboundId}`,
  messageId: `<${id}@example.com>`,
  references: [`<${inboundId}@example.org>`],
  from: "me@example.com",
  to: ["prospect@example.org"],
  subject: "Re: Hello",
  body: `body ${id}`,
  at: "2026-09-29T10:00:00.000Z",
  direction: "outbound",
});

describe("migration v11: mailbox_attempts → outbound_sends", () => {
  const prevWs = process.env["ONESHOT_GTM_WORKSPACE"];
  beforeEach(() => {
    process.env["ONESHOT_GTM_WORKSPACE"] = "test";
  });
  afterEach(() => {
    if (prevWs === undefined) delete process.env["ONESHOT_GTM_WORKSPACE"];
    else process.env["ONESHOT_GTM_WORKSPACE"] = prevWs;
  });

  function seedLegacy(db: import("bun:sqlite").Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS mailbox_attempts (
      id TEXT PRIMARY KEY, inbound_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)`);
    const rows: [string, string, string][] = [
      ["req-sending", "in-1", "sending"],
      ["req-uncertain", "in-2", "uncertain"],
      ["req-sent", "in-3", "sent"],
      ["req-failed", "in-4", "failed"],
    ];
    for (const [id, inbound, status] of rows) {
      db.query("INSERT INTO mailbox_attempts VALUES (?, ?, ?, ?)").run(
        id,
        inbound,
        status,
        JSON.stringify({
          id,
          inboundId: inbound,
          status,
          error: status === "failed" ? "SMTP rejected the reply." : null,
          message: legacyMessage(id, inbound),
        }),
      );
    }
  }

  it("copies every attempt with the status map, overwriting #765's mirror row", async () => {
    const { migrateRepliesOntoOutboundSends } = await import("../src/ledger-schema.ts");
    const db = rawDb(ledger);
    seedLegacy(db);
    // The outcome-only mirror #765 wrote for the sent reply: no body, a receipt.
    ledger.outboundSends.claim({
      key: "gtm:test:reply:req-sent",
      identityId: "smartlead:me@example.com",
      transport: "smtp",
      recipient: "prospect@example.org",
      subject: "Re: Hello",
      body: "",
      messageId: "<req-sent@example.com>",
      sentEvidence: false,
    });
    ledger.outboundSends.mark("gtm:test:reply:req-sent", "submitted", { receiptId: 42 });
    migrateRepliesOntoOutboundSends(db);
    const get = (id: string) => ledger.outboundSends.get(`gtm:test:reply:${id}`)!;
    expect(get("req-sending").status).toBe("uncertain");
    expect(get("req-uncertain").status).toBe("uncertain");
    expect(get("req-sent").status).toBe("confirmed");
    expect(get("req-failed")).toMatchObject({
      status: "failed",
      error: "SMTP rejected the reply.",
    });
    expect(get("req-sent")).toMatchObject({
      kind: "reply",
      body: "body req-sent",
      messageId: "<req-sent@example.com>",
      inboundId: "in-3",
      threadKey: "thread-in-3",
      inReplyTo: "<in-3@example.org>",
      references: ["<in-3@example.org>"],
      dateHeader: "2026-09-29T10:00:00.000Z",
      receiptId: 42,
      sentEvidence: false,
    });
    const before = db.query("SELECT * FROM outbound_sends ORDER BY key").all();
    migrateRepliesOntoOutboundSends(db);
    expect(db.query("SELECT * FROM outbound_sends ORDER BY key").all()).toEqual(before);
    expect(before).toHaveLength(4);
  });

  it("a reopened pre-v11 ledger runs the copy once and lands on the latest version", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { LEDGER_SCHEMA_VERSION } = await import("../src/ledger-schema.ts");
    const dir = mkdtempSync(join(tmpdir(), "ledger-v11-"));
    try {
      const path = join(dir, "ledger.db");
      const first = new Ledger(path);
      const db = rawDb(first);
      db.exec("DROP INDEX outbound_reply_inflight");
      seedLegacy(db);
      db.exec("PRAGMA user_version = 10");
      first.close();
      const reopened = new Ledger(path);
      try {
        const version = rawDb(reopened).query("PRAGMA user_version").get() as {
          user_version: number;
        };
        expect(version.user_version).toBe(LEDGER_SCHEMA_VERSION);
        const count = rawDb(reopened)
          .query("SELECT count(*) AS n FROM outbound_sends WHERE kind = 'reply'")
          .get() as { n: number };
        expect(count.n).toBe(4);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OutboundSendStore.claimReply", () => {
  const reply = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    identityId: "smartlead:me@example.com",
    transport: "smtp",
    recipient: "a@example.org",
    subject: "Re: Hello",
    body: "answer",
    messageId: `<${key}@example.com>`,
    sentEvidence: false,
    inboundId: "inbound-1",
    threadKey: "thread-1",
    inReplyTo: "<in@example.org>",
    references: ["<in@example.org>"],
    dateHeader: t0.toISOString(),
    now: t0,
    ...over,
  });

  it("allows one reply in flight per inbound message, and another after a failure", () => {
    const store = ledger.outboundSends;
    expect(store.claimReply(reply("r1")).verdict).toBe("claimed");
    expect(store.claimReply(reply("r1")).verdict).toBe("exists");
    expect(store.claimReply(reply("r2")).verdict).toBe("busy");
    expect(store.get("r2")).toBeNull();
    store.mark("r1", "uncertain");
    expect(store.claimReply(reply("r2")).verdict).toBe("busy");
    store.mark("r1", "failed");
    expect(store.claimReply(reply("r2")).verdict).toBe("claimed");
    // Another inbound message is never blocked.
    expect(store.claimReply(reply("r3", { inboundId: "inbound-2" })).verdict).toBe("claimed");
  });

  it("the database index refuses a second in-flight reply even past the store", () => {
    ledger.outboundSends.claimReply(reply("r1"));
    expect(() =>
      rawDb(ledger)
        .query(
          `INSERT INTO outbound_sends (key, identity_id, transport, recipient, subject, status,
             first_attempt_at, last_attempt_at, kind, inbound_id)
           VALUES ('r9', 'x', 'smtp', 'a@example.org', 's', 'uncertain', 't', 't', 'reply', 'inbound-1')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("lists a mailbox's unconfirmed replies, skipping fresh pending ones", () => {
    const store = ledger.outboundSends;
    store.claimReply(reply("fresh"));
    store.claimReply(reply("old", { inboundId: "inbound-2", now: at(-STALE_PENDING_MS - 1) }));
    store.claimReply(reply("sent", { inboundId: "inbound-3" }));
    store.mark("sent", "submitted");
    expect(
      store
        .unconfirmedReplies("smartlead:me@example.com", t0)
        .map((s) => s.key)
        .toSorted(),
    ).toEqual(["old", "sent"]);
  });
});

describe("OutboundSendStore.claim", () => {
  it("lets the first caller send and stops a concurrent second one", () => {
    const store = ledger.outboundSends;
    expect(store.claim(input())).toMatchObject({ verdict: "send", retry: false });
    expect(store.claim(input({ now: at(1_000) })).verdict).toBe("in_flight");
  });

  it("turns a pending claim older than the stale window into uncertain", () => {
    const store = ledger.outboundSends;
    store.claim(input());
    const late = store.claim(input({ now: at(STALE_PENDING_MS + 1) }));
    expect(late.verdict).toBe("uncertain");
    expect(store.get(input().key)?.status).toBe("uncertain");
    expect(store.claim(input({ now: at(STALE_PENDING_MS + 2) })).verdict).toBe("uncertain");
  });

  it.each(["submitted", "confirmed", "not_found"] as const)("never resends a %s key", (status) => {
    const store = ledger.outboundSends;
    store.claim(input());
    store.mark(input().key, status, { now: t0 });
    expect(store.claim(input({ now: at(60_000) })).verdict).toBe("already_sent");
  });

  it("retries a failed key under the Message-ID of the first attempt", () => {
    const store = ledger.outboundSends;
    store.claim(input());
    store.mark(input().key, "failed", { error: "550", now: t0 });
    const retry = store.claim(input({ messageId: "<other@example.com>", now: at(60_000) }));
    expect(retry).toMatchObject({ verdict: "send", retry: true });
    expect(retry.send).toMatchObject({
      status: "pending",
      attempts: 2,
      messageId: "<abc@example.com>",
      error: null,
    });
  });

  it("after an unknown outcome a retry keeps the first attempt's content", () => {
    const store = ledger.outboundSends;
    store.claim(input());
    store.mark(input().key, "uncertain", { now: t0 });
    store.mark(input().key, "failed", { now: at(10 * 60_000) });
    const retry = store.claim(input({ subject: "Rewritten", body: "new", now: at(11 * 60_000) }));
    expect(retry.send).toMatchObject({ subject: "Hello", body: "Hi there", exactResend: true });
  });

  it("after a definite failure a retry takes the new draft", () => {
    const store = ledger.outboundSends;
    store.claim(input());
    store.mark(input().key, "failed", { now: t0 });
    const retry = store.claim(input({ subject: "Rewritten", body: "new", now: at(60_000) }));
    expect(retry.send).toMatchObject({ subject: "Rewritten", body: "new", exactResend: false });
  });

  it("stamps submitted / confirmed / checked times by status", () => {
    const store = ledger.outboundSends;
    store.claim(input());
    store.mark(input().key, "submitted", { receiptId: 9, now: at(1_000) });
    expect(store.get(input().key)).toMatchObject({
      submittedAt: at(1_000).toISOString(),
      confirmedAt: null,
      checkedAt: null,
      receiptId: 9,
    });
    store.mark(input().key, "confirmed", { observed: 1, now: at(5 * 60_000) });
    expect(store.get(input().key)).toMatchObject({
      confirmedAt: at(5 * 60_000).toISOString(),
      checkedAt: at(5 * 60_000).toISOString(),
      observed: 1,
      receiptId: 9,
    });
    expect(store.forReceipt(9)?.key).toBe(input().key);
  });

  it("lists submitted and uncertain rows past the minimum age, oldest first", () => {
    const store = ledger.outboundSends;
    for (const [i, status] of (
      ["submitted", "uncertain", "confirmed", "failed"] as const
    ).entries()) {
      const key = `k${i}`;
      store.claim(input({ key, now: at(i * 1_000) }));
      store.mark(key, status, { now: at(i * 1_000) });
    }
    store.claim(input({ key: "young", now: at(9 * 60_000) }));
    store.mark("young", "submitted");
    const due = store.listUnconfirmed({ minAgeMs: 3 * 60_000, limit: 10, now: at(10 * 60_000) });
    expect(due.map((r) => r.key)).toEqual(["k0", "k1"]);
  });
});
