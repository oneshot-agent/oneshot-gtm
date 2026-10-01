import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import {
  CONFIRM_MIN_AGE_MS,
  ONESHOT_UNCERTAIN_RETRIES,
  PermanentDeliveryError,
  SUBMITTED_NOT_FOUND_MS,
  TransientDeliveryError,
  UNCERTAIN_SETTLE_MS,
  runDeliveryChecks,
  runOutboundConfirmations,
  type ConfirmReaders,
} from "../src/send-delivery.ts";
import type { SentCopy } from "../src/gmail.ts";
import type { EmailIdentity } from "../src/types.ts";

vi.mock("../src/events.ts", async (orig) => ({
  ...(await orig<typeof import("../src/events.ts")>()),
  logEvent: vi.fn(),
}));

// The confirm sweep for keyed sends: each submitted or uncertain send is
// looked up in Sent (by Message-ID over SMTP, by recipient + subject + window
// over Gmail) and settled per the timings, with a delivery-check row for the
// dashboard. The legacy copy count leaves keyed receipts alone.

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const smtpId: EmailIdentity = {
  id: "smartlead:jn@mail.example",
  provider: "smartlead",
  address: "jn@mail.example",
  maxPerDay: 30,
  warmup: null,
  sendVia: "smtp",
};
const gmailId: EmailIdentity = {
  id: "gmail:jn@other.example",
  provider: "gmail",
  address: "jn@other.example",
  maxPerDay: 30,
  warmup: null,
};

let ledger: Ledger;
const db = () => (ledger as unknown as { db: Database }).db;

function addReceipt(identity: EmailIdentity, to: string, subject: string): number {
  const r = db()
    .query(
      `INSERT INTO receipts (play_name, call_type, cost_usd, signed_receipt, oneshot_request_id, created_at, sender_identity)
       VALUES ('test-play', 'email.send', 0, ?, ?, ?, ?)`,
    )
    .run(
      JSON.stringify({
        provider: identity.provider,
        transport: identity.provider === "gmail" ? undefined : "smtp",
        to,
        subject,
      }),
      `r:${Math.random()}`,
      new Date(T0).toISOString().replace("T", " ").slice(0, 19),
      identity.id,
    );
  return Number(r.lastInsertRowid);
}

/** A keyed send attempted at T0 and left in `status`. */
function keyed(
  key: string,
  status: "submitted" | "uncertain",
  identity: EmailIdentity = smtpId,
  withReceipt = status === "submitted",
  sentEvidence = true,
): { key: string; receiptId: number | null; messageId: string } {
  const to = `${key}@example.org`;
  const messageId = `<${key}@mail.example>`;
  ledger.outboundSends.claim({
    key,
    identityId: identity.id,
    transport: identity.provider === "gmail" ? "gmail" : "smtp",
    recipient: to,
    subject: "Hello there",
    body: "Body",
    messageId: identity.provider === "gmail" ? null : messageId,
    sentEvidence,
    now: new Date(T0),
  });
  const receiptId = withReceipt ? addReceipt(identity, to, "Hello there") : null;
  ledger.outboundSends.mark(key, status, {
    ...(receiptId != null ? { receiptId } : {}),
    ...(identity.provider === "gmail" ? { messageId: `gm-${key}` } : {}),
    now: new Date(T0),
  });
  return { key, receiptId, messageId };
}

function readers(found: Record<string, SentCopy[]>, gmail: SentCopy[] = []): ConfirmReaders {
  return {
    smtp: vi.fn(async ({ messageId }) => found[messageId] ?? []),
    gmail: vi.fn(async () => gmail),
  };
}
const copy = (messageId: string, offsetSec = 30, subject = "Hello there"): SentCopy => ({
  messageId,
  date: new Date(T0 + offsetSec * 1000).toISOString(),
  subject,
});

function sweep(nowMs: number, r: ConfirmReaders) {
  return runOutboundConfirmations({
    outbound: ledger.outboundSends,
    delivery: ledger.sendDelivery,
    nowMs,
    readers: r,
    identities: [smtpId, gmailId],
  });
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => ledger.close());

describe("runOutboundConfirmations", () => {
  it("waits until a send is at least the minimum age", async () => {
    keyed("young", "submitted");
    const r = readers({});
    expect(await sweep(T0 + CONFIRM_MIN_AGE_MS - 1_000, r)).toEqual([]);
    expect(r.smtp).not.toHaveBeenCalled();
  });

  it("confirms a send found once by its Message-ID and records an ok check", async () => {
    const s = keyed("once", "submitted");
    const out = await sweep(
      T0 + CONFIRM_MIN_AGE_MS,
      readers({ [s.messageId]: [copy(s.messageId)] }),
    );
    expect(out[0]).toMatchObject({ before: "submitted", after: "confirmed", observed: 1 });
    expect(ledger.outboundSends.get(s.key)).toMatchObject({ status: "confirmed", observed: 1 });
    expect(ledger.sendDelivery.forReceipt(s.receiptId!)).toMatchObject({
      status: "ok",
      observed: 1,
      keyed: true,
    });
  });

  it("confirms but flags a Message-ID found more than once", async () => {
    const s = keyed("twice", "submitted");
    const found = { [s.messageId]: [copy(s.messageId, 20), copy(`${s.messageId}-copy`, 50)] };
    await sweep(T0 + CONFIRM_MIN_AGE_MS, readers(found));
    expect(ledger.outboundSends.get(s.key)?.status).toBe("confirmed");
    expect(ledger.sendDelivery.forReceipt(s.receiptId!)).toMatchObject({
      status: "duplicate",
      observed: 2,
    });
  });

  it("confirms an uncertain send that turns up in Sent: it went out, so it is never retried", async () => {
    const s = keyed("dropped", "uncertain");
    await sweep(T0 + CONFIRM_MIN_AGE_MS, readers({ [s.messageId]: [copy(s.messageId)] }));
    expect(ledger.outboundSends.get(s.key)?.status).toBe("confirmed");
    expect(
      ledger.outboundSends.claim({ ...claimOf(s.key), now: new Date(T0 + 20 * 60_000) }).verdict,
    ).toBe("already_sent");
  });

  it("settles an uncertain send missing after the settle window as failed (retryable)", async () => {
    const s = keyed("lost", "uncertain");
    await sweep(T0 + UNCERTAIN_SETTLE_MS - 1_000, readers({}));
    expect(ledger.outboundSends.get(s.key)?.status).toBe("uncertain");
    await sweep(T0 + UNCERTAIN_SETTLE_MS, readers({}));
    expect(ledger.outboundSends.get(s.key)?.status).toBe("failed");
    const retry = ledger.outboundSends.claim({
      ...claimOf(s.key),
      now: new Date(T0 + 11 * 60_000),
    });
    expect(retry).toMatchObject({ verdict: "send", retry: true });
    expect(retry.send.messageId).toBe(s.messageId);
  });

  it("never resends an uncertain SMTP send whose server keeps no Sent copy", async () => {
    const s = keyed("nocopy", "uncertain", smtpId, false, false);
    await sweep(T0 + UNCERTAIN_SETTLE_MS, readers({}));
    const row = ledger.outboundSends.get(s.key)!;
    expect(row.status).toBe("not_found");
    expect(row.error).toMatch(/keeps no Sent copy/);
    expect(
      ledger.outboundSends.claim({ ...claimOf(s.key), now: new Date(T0 + 20 * 60_000) }).verdict,
    ).toBe("already_sent");
  });

  it("settles an uncertain OneShot send without reading, then gives up after the retries", async () => {
    const os: EmailIdentity = {
      id: "oneshot:jn@os.example",
      provider: "oneshot",
      sendingDomain: "os.example",
      maxPerDay: null,
      warmup: null,
    };
    ledger.outboundSends.claim({
      ...claimOf2("os1", os),
      now: new Date(T0),
    });
    ledger.outboundSends.mark("os1", "uncertain", { now: new Date(T0) });
    const r = readers({});
    await sweep(T0 + UNCERTAIN_SETTLE_MS - 1_000, r);
    expect(ledger.outboundSends.get("os1")?.status).toBe("uncertain");
    await sweep(T0 + UNCERTAIN_SETTLE_MS, r);
    expect(ledger.outboundSends.get("os1")?.status).toBe("failed");
    expect(r.smtp).not.toHaveBeenCalled();
    expect(r.gmail).not.toHaveBeenCalled();
    // Each retry that ends unknown again counts; the last one is left alone.
    for (let i = 1; i < ONESHOT_UNCERTAIN_RETRIES; i++) {
      if (ledger.outboundSends.get("os1")?.status === "uncertain") {
        ledger.outboundSends.mark("os1", "failed", { now: new Date(T0) });
      }
      ledger.outboundSends.claim({ ...claimOf2("os1", os), now: new Date(T0) });
      ledger.outboundSends.mark("os1", "uncertain", { now: new Date(T0) });
    }
    await sweep(T0 + UNCERTAIN_SETTLE_MS, r);
    expect(ledger.outboundSends.get("os1")).toMatchObject({
      status: "not_found",
      attempts: ONESHOT_UNCERTAIN_RETRIES,
    });
  });

  it("flags a submitted send missing after 30 minutes as not_found and never resends it", async () => {
    const s = keyed("silent", "submitted");
    await sweep(T0 + SUBMITTED_NOT_FOUND_MS - 1_000, readers({}));
    expect(ledger.outboundSends.get(s.key)?.status).toBe("submitted");
    await sweep(T0 + SUBMITTED_NOT_FOUND_MS, readers({}));
    expect(ledger.outboundSends.get(s.key)).toMatchObject({ status: "not_found", observed: 0 });
    expect(ledger.sendDelivery.forReceipt(s.receiptId!)).toMatchObject({
      status: "not_found",
      keyed: true,
    });
    expect(
      ledger.outboundSends.claim({ ...claimOf(s.key), now: new Date(T0 + 40 * 60_000) }).verdict,
    ).toBe("already_sent");
  });

  it("confirms a Gmail send by recipient + subject inside the window", async () => {
    const s = keyed("viagmail", "submitted", gmailId);
    const r = readers({}, [copy("<rewritten@gmail>", 5), copy("<other@gmail>", 6, "unrelated")]);
    await sweep(T0 + CONFIRM_MIN_AGE_MS, r);
    expect(r.gmail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "viagmail@example.org" }),
    );
    expect(ledger.outboundSends.get(s.key)).toMatchObject({ status: "confirmed", observed: 1 });
  });

  it("leaves a send unchanged on a transient read error, one read per mailbox", async () => {
    const a = keyed("t1", "submitted");
    const b = keyed("t2", "submitted");
    const r: ConfirmReaders = {
      smtp: vi.fn(async () => {
        throw new TransientDeliveryError("IMAP timeout");
      }),
      gmail: vi.fn(async () => []),
    };
    const out = await sweep(T0 + SUBMITTED_NOT_FOUND_MS + 60_000, r);
    expect(r.smtp).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(ledger.outboundSends.get(a.key)?.status).toBe("submitted");
    expect(ledger.outboundSends.get(b.key)?.status).toBe("submitted");
  });

  it("settles a send whose mailbox can never be read as not_found, shown as skipped", async () => {
    const s = keyed("gone", "submitted");
    const r: ConfirmReaders = {
      smtp: vi.fn(async () => {
        throw new PermanentDeliveryError("no Sent folder in this mailbox");
      }),
      gmail: vi.fn(async () => []),
    };
    await sweep(T0 + CONFIRM_MIN_AGE_MS, r);
    expect(ledger.outboundSends.get(s.key)?.status).toBe("not_found");
    expect(ledger.sendDelivery.forReceipt(s.receiptId!)?.status).toBe("skipped");
  });

  it("dry run reads but records nothing", async () => {
    const s = keyed("dry", "submitted");
    const out = await runOutboundConfirmations({
      outbound: ledger.outboundSends,
      delivery: ledger.sendDelivery,
      nowMs: T0 + CONFIRM_MIN_AGE_MS,
      readers: readers({ [s.messageId]: [copy(s.messageId)] }),
      identities: [smtpId],
      dryRun: true,
    });
    expect(out[0]?.after).toBe("confirmed");
    expect(ledger.outboundSends.get(s.key)?.status).toBe("submitted");
    expect(ledger.sendDelivery.forReceipt(s.receiptId!)).toBeNull();
  });
});

describe("legacy copy count", () => {
  it("skips keyed receipts but still audits unkeyed ones", async () => {
    const s = keyed("keyedone", "submitted");
    const unkeyed = addReceipt(
      { ...smtpId, id: "smartlead:other@mail.example", sendVia: undefined },
      "plain@example.org",
      "Hello there",
    );
    const candidates = ledger.sendDelivery.listCandidates({
      sinceIso: new Date(T0 - 60_000).toISOString(),
      untilIso: new Date(T0 + 60_000).toISOString(),
      limit: 10,
    });
    expect(candidates.map((c) => c.receiptId)).toEqual([unkeyed]);
    expect(candidates.map((c) => c.receiptId)).not.toContain(s.receiptId);
    // The full sweep agrees: only the unkeyed receipt is read.
    const smartlead = vi.fn(async () => []);
    await runDeliveryChecks({
      store: ledger.sendDelivery,
      nowMs: T0 + 40 * 60_000,
      sinceIso: new Date(T0 - 60_000).toISOString(),
      readers: { smartlead, gmail: vi.fn(async () => []) },
      identities: [{ ...smtpId, id: "smartlead:other@mail.example" }],
    });
    expect(smartlead).toHaveBeenCalledTimes(1);
    expect(ledger.sendDelivery.forReceipt(unkeyed)).toMatchObject({ keyed: false });
  });
});

function claimOf(key: string) {
  const row = ledger.outboundSends.get(key)!;
  return {
    key,
    identityId: row.identityId,
    transport: row.transport,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    messageId: "<fresh@mail.example>",
    sentEvidence: row.sentEvidence,
  };
}

function claimOf2(key: string, identity: EmailIdentity) {
  return {
    key,
    identityId: identity.id,
    transport: "oneshot",
    recipient: `${key}@example.org`,
    subject: "Hello there",
    body: "Body",
    messageId: null,
    sentEvidence: false,
  };
}
