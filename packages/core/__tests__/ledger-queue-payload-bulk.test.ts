import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

// Issue #599: the /cadences page asks for every row's intro payload at once.
// The bulk lookup must agree with the single-row one — latest SENT row per
// (play, email), email canonicalised — and never widen to unsent rows.

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-payload-bulk-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function enqueue(playName: string, payload: Record<string, unknown>, sent: boolean): number {
  const id = ledger.enqueueTarget({
    playName,
    payload,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: `find:${playName}`,
  })!;
  if (sent) {
    ledger.setQueueStatus({ id, status: "approved" });
    ledger.setQueueStatus({ id, status: "sent" });
  }
  return id;
}

describe("Ledger.latestSentQueuePayloads", () => {
  it("returns the latest sent payload per play + email, canonicalising the email", () => {
    enqueue("show-hn", { email: "ada@x.io", fitReason: "older" }, true);
    enqueue("show-hn", { email: "Ada@X.io ", fitReason: "newer" }, true);
    enqueue("luma-events", { email: "ada@x.io", fitReason: "luma one" }, true);
    const out = ledger.latestSentQueuePayloads([
      { playName: "show-hn", email: "  ADA@x.io" },
      { playName: "luma-events", email: "ada@x.io" },
    ]);
    expect(out.get("show-hn|ada@x.io")?.["fitReason"]).toBe("newer");
    expect(out.get("luma-events|ada@x.io")?.["fitReason"]).toBe("luma one");
    expect(out.size).toBe(2);
  });

  it("agrees with the single-row lookup", () => {
    enqueue("show-hn", { email: "bob@x.io", fitReason: "first" }, true);
    enqueue("show-hn", { email: "bob@x.io", fitReason: "second" }, true);
    const one = ledger.latestSentQueuePayload("show-hn", "bob@x.io");
    const many = ledger.latestSentQueuePayloads([{ playName: "show-hn", email: "bob@x.io" }]);
    expect(many.get("show-hn|bob@x.io")).toEqual(one);
  });

  it("ignores pending and approved rows, unknown pairs, and pairs without an email", () => {
    enqueue("show-hn", { email: "cy@x.io", fitReason: "not sent" }, false);
    enqueue("show-hn", { email: "dee@x.io", fitReason: "sent" }, true);
    const out = ledger.latestSentQueuePayloads([
      { playName: "show-hn", email: "cy@x.io" },
      { playName: "show-hn", email: null },
      { playName: "post-funding", email: "dee@x.io" },
    ]);
    expect(out.size).toBe(0);
    expect(ledger.latestSentQueuePayloads([])).toEqual(new Map());
  });
});
