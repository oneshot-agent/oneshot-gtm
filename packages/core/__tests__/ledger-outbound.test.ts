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

describe("migration v10", () => {
  it("creates outbound_sends with its status and receipt indexes", () => {
    const db = (ledger as unknown as { db: import("bun:sqlite").Database }).db;
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE tbl_name = 'outbound_sends' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual([
      "idx_outbound_sends_receipt",
      "idx_outbound_sends_status",
      "outbound_sends",
      "sqlite_autoindex_outbound_sends_1",
    ]);
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
