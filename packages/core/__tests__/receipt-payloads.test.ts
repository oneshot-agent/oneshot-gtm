import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";
import {
  RECEIPT_ARRAY_CAP,
  RECEIPT_STRING_CAP,
  slimReceiptPayload,
} from "../src/ledger-receipts.ts";

const PAGE = "x".repeat(51_200);

function webReadResult(): Record<string, unknown> {
  return {
    url: "https://acme.test/about",
    markdown: PAGE,
    metadata: { title: "About Acme" },
    truncated: true,
    receipt_id: "rcpt_1",
    request_id: "req_1",
    settlement_status: "settled",
    cost: 0.01,
  };
}

describe("slimReceiptPayload", () => {
  it("drops a web.read page but keeps the envelope and identifiers", () => {
    const slim = slimReceiptPayload("web.read", webReadResult()) as Record<string, unknown>;
    expect(slim["markdown"]).toBe(`[omitted: ${PAGE.length} chars]`);
    expect(slim).toMatchObject({
      url: "https://acme.test/about",
      metadata: { title: "About Acme" },
      truncated: true,
      receipt_id: "rcpt_1",
      request_id: "req_1",
      settlement_status: "settled",
      cost: 0.01,
    });
  });

  it("caps long arrays and slims nested values", () => {
    const results = Array.from({ length: RECEIPT_ARRAY_CAP + 5 }, (_, i) => ({
      url: `https://r${i}.test`,
      snippet: "s".repeat(RECEIPT_STRING_CAP + 1),
    }));
    const slim = slimReceiptPayload("web.search", { query: "q", results }) as {
      results: unknown[];
    };
    expect(slim.results).toHaveLength(RECEIPT_ARRAY_CAP + 1);
    expect(slim.results.at(-1)).toBe("[omitted: 5 more items]");
    expect(slim.results[0]).toEqual({
      url: "https://r0.test",
      snippet: `[omitted: ${RECEIPT_STRING_CAP + 1} chars]`,
    });
  });

  it("returns a small payload unchanged", () => {
    const payload = { provider: "gmail", message_id: "m1", thread_id: "t1", to: "a@x.com" };
    expect(slimReceiptPayload("email.send", payload)).toEqual(payload);
  });

  it("keeps contact-lookup and direct-mail receipts whole", () => {
    const long = { status: "completed", email: "a@x.com", note: PAGE };
    for (const callType of ["email.find", "email.verify", "direct_mail.order"]) {
      expect(slimReceiptPayload(callType, long)).toBe(long);
    }
  });
});

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-test-receipt-payloads-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

function storedJson(id: number): string {
  return ledger.getReceipt(id)!.signed_receipt!;
}

describe("recordReceipt", () => {
  it("stores a web.read receipt without the page", () => {
    const id = ledger.recordReceipt({
      playName: "p",
      callType: "web.read",
      costUsd: 0.01,
      signedReceipt: webReadResult(),
      oneshotRequestId: "req_1",
    });
    expect(storedJson(id).length).toBeLessThan(2000);
    expect(JSON.parse(storedJson(id))).toMatchObject({
      receipt_id: "rcpt_1",
      url: expect.any(String),
    });
  });

  it("still reuses an email.verify receipt that carries a long field", () => {
    ledger.recordReceipt({
      playName: "p",
      callType: "email.verify",
      costUsd: 0.01,
      signedReceipt: { status: "completed", email: "a@x.com", deliverable: true, raw: PAGE },
      oneshotRequestId: "req_v",
    });
    const hit = ledger.findContactReceipt({ email: "a@x.com" });
    expect(hit).not.toBeNull();
    expect(JSON.parse(hit!.signed_receipt!)["raw"]).toBe(PAGE);
  });
});

describe("compactReceiptPayloads", () => {
  function insertRaw(callType: string, json: string): number {
    const db = new Database(dbPath);
    try {
      return Number(
        db
          .prepare(
            "INSERT INTO receipts(play_name, call_type, cost_usd, signed_receipt) VALUES ('p', ?, 0.01, ?)",
          )
          .run(callType, json).lastInsertRowid,
      );
    } finally {
      db.close();
    }
  }

  it("dry run reports without writing; apply trims; a second run finds nothing", () => {
    const read = insertRaw("web.read", JSON.stringify(webReadResult()));
    const find = insertRaw(
      "email.find",
      JSON.stringify({ status: "completed", full_name: "Ada", company_domain: "x.com", big: PAGE }),
    );
    const small = insertRaw("email.send", JSON.stringify({ message_id: "m1" }));
    const findBefore = storedJson(find);

    const dry = ledger.compactReceiptPayloads({ apply: false });
    expect(dry.rows).toBe(1);
    expect(dry.bytesBefore).toBeGreaterThan(PAGE.length);
    expect(dry.bytesAfter).toBeLessThan(2000);
    expect(storedJson(read).length).toBeGreaterThan(PAGE.length);

    const applied = ledger.compactReceiptPayloads({ apply: true });
    expect(applied.rows).toBe(1);
    expect(JSON.parse(storedJson(read))).toMatchObject({
      markdown: `[omitted: ${PAGE.length} chars]`,
      request_id: "req_1",
    });
    expect(storedJson(find)).toBe(findBefore);
    expect(storedJson(small)).toBe(JSON.stringify({ message_id: "m1" }));

    expect(ledger.compactReceiptPayloads({ apply: true }).rows).toBe(0);
  });

  it("leaves a large row alone when slimming wouldn't change it", () => {
    // Over the 4 KB floor, but every field is short: already within the caps.
    const fields = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, "v"]));
    const id = insertRaw("enrich.profile", JSON.stringify(fields));
    expect(storedJson(id).length).toBeGreaterThan(4096);
    expect(ledger.compactReceiptPayloads({ apply: true })).toMatchObject({ rows: 0, skipped: 0 });
  });

  it("skips rows whose JSON doesn't parse", () => {
    const bad = insertRaw("web.read", `{not json ${PAGE}`);
    const res = ledger.compactReceiptPayloads({ apply: true });
    expect(res).toMatchObject({ rows: 0, skipped: 1 });
    expect(storedJson(bad).startsWith("{not json")).toBe(true);
  });

  it("vacuum shrinks the file after a trim", () => {
    for (let i = 0; i < 40; i++) insertRaw("web.read", JSON.stringify(webReadResult()));
    ledger.compactReceiptPayloads({ apply: true });
    const size = () => Bun.file(dbPath).size;
    ledger.vacuum();
    expect(size()).toBeLessThan(40 * PAGE.length);
  });
});
