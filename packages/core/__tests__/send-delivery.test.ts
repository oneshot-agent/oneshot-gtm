import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { LEDGER_SCHEMA_VERSION } from "../src/ledger-schema.ts";
import {
  DELIVERY_FINAL_AFTER_MS,
  PermanentDeliveryError,
  TransientDeliveryError,
  evaluateDelivery,
  runDeliveryChecks,
  type DeliveryReaders,
} from "../src/send-delivery.ts";
import type { SentCopy } from "../src/gmail.ts";
import type { EmailIdentity } from "../src/types.ts";

vi.mock("../src/events.ts", async (orig) => ({
  ...(await orig<typeof import("../src/events.ts")>()),
  logEvent: vi.fn(),
}));

// The incident this guards: one recorded Smartlead send, three copies in the
// mailbox's Sent folder 24-40 s apart (the provider retried underneath us).

const SENT_AT = "2026-09-29T01:59:02.000Z";
const SENT_MS = Date.parse(SENT_AT);
const at = (offsetSec: number) => new Date(SENT_MS + offsetSec * 1000).toISOString();
const copy = (id: string, offsetSec: number, subject = "perceptron ml"): SentCopy => ({
  messageId: `<${id}@mx.example>`,
  date: at(offsetSec),
  subject,
});

describe("evaluateDelivery", () => {
  const cand = { subject: "perceptron ml", sentAt: SENT_AT };
  const final = SENT_MS + DELIVERY_FINAL_AFTER_MS + 1000;

  it("one copy after the window → ok", () => {
    const v = evaluateDelivery(cand, [copy("a", 72)], final);
    expect(v).toMatchObject({ status: "ok", observed: 1 });
  });

  it("three copies → duplicate, at once, with times oldest first", () => {
    const v = evaluateDelivery(
      cand,
      [copy("c", 136), copy("a", 72), copy("b", 96)],
      SENT_MS + 5 * 60_000,
    );
    expect(v.status).toBe("duplicate");
    expect(v.observed).toBe(3);
    expect(v.deliveredAt).toEqual([at(72), at(96), at(136)]);
    expect(v.messageIds).toHaveLength(3);
  });

  it("no copy after the window → not_found", () => {
    expect(evaluateDelivery(cand, [], final)).toMatchObject({ status: "not_found", observed: 0 });
  });

  it("one or no copy inside the window is not final yet", () => {
    expect(evaluateDelivery(cand, [copy("a", 72)], SENT_MS + 5 * 60_000).status).toBeNull();
    expect(evaluateDelivery(cand, [], SENT_MS + 5 * 60_000).status).toBeNull();
  });

  it("ignores other subjects, copies outside the window, and repeated Message-IDs", () => {
    const v = evaluateDelivery(
      cand,
      [
        copy("a", 72),
        copy("a", 72), // same message listed twice
        copy("other", 80, "a different thread"),
        copy("early", -10 * 60), // before the window
        copy("late", 45 * 60), // after the window
      ],
      final,
    );
    expect(v).toMatchObject({ status: "ok", observed: 1 });
  });

  it("subject match ignores case and whitespace", () => {
    expect(evaluateDelivery(cand, [copy("a", 72, "  Perceptron   ML ")], final).observed).toBe(1);
  });
});

describe("runDeliveryChecks with the ledger store", () => {
  let dbPath: string;
  let ledger: Ledger;
  const db = () => (ledger as unknown as { db: Database }).db;

  const smartlead: EmailIdentity = {
    id: "smartlead:jn@mail.example",
    provider: "smartlead",
    address: "jn@mail.example",
    maxPerDay: 30,
    warmup: null,
  };
  const gmail: EmailIdentity = {
    id: "gmail:jn@other.example",
    provider: "gmail",
    address: "jn@other.example",
    maxPerDay: 30,
    warmup: null,
  };

  function addReceipt(opts: {
    provider: string;
    identity: string;
    to: string;
    subject: string;
    createdAt: string;
  }): number {
    const r = db()
      .query(
        `INSERT INTO receipts (play_name, call_type, cost_usd, signed_receipt, oneshot_request_id, created_at, sender_identity)
         VALUES ('accelerator-batch', 'email.send', 0, ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify({ provider: opts.provider, to: opts.to, subject: opts.subject, from: "x" }),
        `${opts.provider}:${Math.random()}`,
        opts.createdAt.replace("T", " ").slice(0, 19),
        opts.identity,
      );
    return Number(r.lastInsertRowid);
  }

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `oneshot-gtm-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    ledger = new Ledger(dbPath);
  });
  afterEach(() => {
    ledger.close();
    for (const s of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${dbPath}${s}`);
      } catch {
        // ignore
      }
    }
  });

  it("the migration lands on a fresh ledger at the latest version", () => {
    const v = (db().query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(LEDGER_SCHEMA_VERSION);
    const cols = db().query("PRAGMA table_info(send_delivery_checks)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(["receipt_id", "observed", "expected", "message_ids", "status"]),
    );
  });

  it("records a duplicate, links the queue row, and the row view reads it", async () => {
    const rid = addReceipt({
      provider: "smartlead",
      identity: smartlead.id,
      to: "michael@lab.example",
      subject: "perceptron ml",
      createdAt: SENT_AT,
    });
    db()
      .query(
        `INSERT INTO target_queue (play_name, payload_json, dedupe_key, source, status, last_draft_json)
         VALUES ('accelerator-batch', '{}', 'k1', 'find:test', 'sent', ?)`,
      )
      .run(JSON.stringify({ subject: "perceptron ml", body: "b", receiptIds: [rid] }));
    const readers: DeliveryReaders = {
      smartlead: vi.fn(async () => [copy("a", 72), copy("b", 96), copy("c", 136)]),
      gmail: vi.fn(async () => []),
    };
    const summary = await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: SENT_MS + 10 * 60_000,
      sinceIso: at(-3600),
      untilIso: at(600),
      readers,
      identities: [smartlead],
    });
    expect(summary.duplicate).toBe(1);
    const view = ledger.sendDelivery.forReceipts([rid]);
    expect(view).toMatchObject({
      status: "duplicate",
      observed: 3,
      expected: 1,
      transport: "smartlead",
    });
    expect(view?.deliveredAt).toHaveLength(3);
    const mism = ledger.sendDelivery.recentMismatches(at(-86_400));
    expect(mism[0]).toMatchObject({ receiptId: rid, recipient: "michael@lab.example" });
    expect(mism[0]?.queueId).not.toBeNull();
    // Recorded: the sweep does not pick it up again.
    expect(
      ledger.sendDelivery.listCandidates({ sinceIso: at(-3600), untilIso: at(600), limit: 10 }),
    ).toHaveLength(0);
  });

  it("a clean send stays pending inside the window, then records ok", async () => {
    addReceipt({
      provider: "gmail",
      identity: gmail.id,
      to: "a@b.example",
      subject: "hello",
      createdAt: SENT_AT,
    });
    const readers: DeliveryReaders = {
      smartlead: vi.fn(async () => []),
      gmail: vi.fn(async () => [copy("a", 5, "hello")]),
    };
    const early = await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: SENT_MS + 5 * 60_000,
      sinceIso: at(-3600),
      untilIso: at(600),
      readers,
      identities: [gmail],
    });
    expect(early.pending).toBe(1);
    expect(
      ledger.sendDelivery.listCandidates({ sinceIso: at(-3600), untilIso: at(600), limit: 10 }),
    ).toHaveLength(1);
    const later = await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: SENT_MS + DELIVERY_FINAL_AFTER_MS + 60_000,
      sinceIso: at(-3600),
      untilIso: at(3600),
      readers,
      identities: [gmail],
    });
    expect(later.ok).toBe(1);
  });

  it("OneShot sends are never candidates", () => {
    addReceipt({
      provider: "oneshot",
      identity: "legacy-oneshot",
      to: "a@b.example",
      subject: "s",
      createdAt: SENT_AT,
    });
    db()
      .query(
        `INSERT INTO receipts (play_name, call_type, cost_usd, signed_receipt, oneshot_request_id, created_at, sender_identity)
         VALUES ('p', 'email.send', 0.005, '{"status":"sent"}', 'req-1', ?, 'legacy-oneshot')`,
      )
      .run(SENT_AT.replace("T", " ").slice(0, 19));
    expect(
      ledger.sendDelivery.listCandidates({ sinceIso: at(-3600), untilIso: at(600), limit: 10 }),
    ).toHaveLength(0);
  });

  it("a transient mailbox error is not recorded; a permanent one is recorded as skipped", async () => {
    addReceipt({
      provider: "smartlead",
      identity: smartlead.id,
      to: "x@y.example",
      subject: "s",
      createdAt: SENT_AT,
    });
    const failing: DeliveryReaders = {
      smartlead: vi.fn(async () => {
        throw new TransientDeliveryError("IMAP timeout");
      }),
      gmail: vi.fn(async () => []),
    };
    const first = await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: SENT_MS + DELIVERY_FINAL_AFTER_MS + 60_000,
      sinceIso: at(-3600),
      untilIso: at(3600),
      readers: failing,
      identities: [smartlead],
    });
    expect(first.transient).toBe(1);
    expect(
      ledger.sendDelivery.listCandidates({ sinceIso: at(-3600), untilIso: at(3600), limit: 10 }),
    ).toHaveLength(1);

    const gone: DeliveryReaders = {
      smartlead: vi.fn(async () => {
        throw new PermanentDeliveryError("no Sent folder in this mailbox");
      }),
      gmail: vi.fn(async () => []),
    };
    const second = await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: SENT_MS + DELIVERY_FINAL_AFTER_MS + 60_000,
      sinceIso: at(-3600),
      untilIso: at(3600),
      readers: gone,
      identities: [smartlead],
    });
    expect(second.skipped).toBe(1);
    expect(
      ledger.sendDelivery.listCandidates({ sinceIso: at(-3600), untilIso: at(3600), limit: 10 }),
    ).toHaveLength(0);
  });

  it("an identity no longer configured is recorded as skipped, without reading anything", async () => {
    addReceipt({
      provider: "smartlead",
      identity: "smartlead:gone@x.example",
      to: "x@y.example",
      subject: "s",
      createdAt: SENT_AT,
    });
    const readers: DeliveryReaders = {
      smartlead: vi.fn(async () => []),
      gmail: vi.fn(async () => []),
    };
    const s = await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: SENT_MS + DELIVERY_FINAL_AFTER_MS + 60_000,
      sinceIso: at(-3600),
      untilIso: at(3600),
      readers,
      identities: [smartlead],
    });
    expect(s.skipped).toBe(1);
    expect(readers.smartlead).not.toHaveBeenCalled();
  });

  it("a dry run records nothing", async () => {
    addReceipt({
      provider: "smartlead",
      identity: smartlead.id,
      to: "m@x.example",
      subject: "s",
      createdAt: SENT_AT,
    });
    const readers: DeliveryReaders = {
      smartlead: vi.fn(async () => [copy("a", 10, "s"), copy("b", 30, "s")]),
      gmail: vi.fn(async () => []),
    };
    const s = await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: SENT_MS + 10 * 60_000,
      sinceIso: at(-3600),
      untilIso: at(600),
      readers,
      identities: [smartlead],
      dryRun: true,
    });
    expect(s.duplicate).toBe(1);
    expect(ledger.sendDelivery.recentMismatches(at(-86_400))).toHaveLength(0);
  });
});
