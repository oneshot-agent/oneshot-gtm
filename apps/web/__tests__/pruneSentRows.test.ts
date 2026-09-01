import { describe, expect, it } from "vitest";
import type { RunPlayEvent } from "@oneshot-gtm/shared-types";
import { pruneSentRows, remapFilteredEventIndexes } from "../src/lib/pruneSentRows";

const r = (label: string): Record<string, string> => ({ email: `${label}@x.dev`, name: label });

describe("pruneSentRows", () => {
  it("drops rows whose index has a non-empty send event; survives keep aligned dedupeKeys", () => {
    const rows = [r("a"), r("b"), r("c")];
    const keys = ["k-a", "k-b", "k-c"];
    const events: RunPlayEvent[] = [
      { kind: "draft", index: 0, subject: "s", body: "b", flags: [] },
      { kind: "send", index: 0, receiptIds: [101] },
      { kind: "draft", index: 1, subject: "s", body: "b", flags: ["ai-vocab"] },
      // index 1: no send event → held
      { kind: "draft", index: 2, subject: "s", body: "b", flags: [] },
      { kind: "send", index: 2, receiptIds: [103] },
      { kind: "done", total: 3, sent: 2 },
    ];

    const out = pruneSentRows(events, rows, keys);
    expect(out.prunedCount).toBe(2);
    expect(out.rows).toEqual([r("b")]);
    expect(out.dedupeKeys).toEqual(["k-b"]);
  });

  it("no send events (e.g. dry-run): passes input through unchanged", () => {
    const rows = [r("a"), r("b")];
    const keys = ["k-a", "k-b"];
    const events: RunPlayEvent[] = [
      { kind: "draft", index: 0, subject: "s", body: "b", flags: [] },
      { kind: "draft", index: 1, subject: "s", body: "b", flags: [] },
      { kind: "done", total: 2, sent: 0 },
    ];
    const out = pruneSentRows(events, rows, keys);
    expect(out.prunedCount).toBe(0);
    expect(out.rows).toBe(rows); // same reference
    expect(out.dedupeKeys).toBe(keys);
  });

  it("send event with empty receiptIds is treated as not-sent", () => {
    const rows = [r("a")];
    const keys = ["k-a"];
    const events: RunPlayEvent[] = [{ kind: "send", index: 0, receiptIds: [] }];
    const out = pruneSentRows(events, rows, keys);
    expect(out.prunedCount).toBe(0);
    expect(out.rows).toEqual([r("a")]);
  });

  it("null dedupeKey is preserved as null in surviving output", () => {
    const rows = [r("a"), r("b")];
    const keys = [null, "k-b"];
    const events: RunPlayEvent[] = [{ kind: "send", index: 1, receiptIds: [42] }];
    const out = pruneSentRows(events, rows, keys);
    expect(out.rows).toEqual([r("a")]);
    expect(out.dedupeKeys).toEqual([null]);
  });
});

describe("remapFilteredEventIndexes", () => {
  it("maps filtered live indexes back to the full rows array", () => {
    const rows = [r("a"), r("b"), r("c")];
    const events: RunPlayEvent[] = [
      {
        kind: "verify",
        total: 3,
        verified: 2,
        dropped: [{ email: "b@x.dev", reason: "bad", index: 1 }],
      },
      { kind: "send", index: 1, receiptIds: [42] },
    ];

    const mapped = remapFilteredEventIndexes(events, rows);
    expect(mapped[1]).toEqual({ kind: "send", index: 2, receiptIds: [42] });
    expect(pruneSentRows(mapped, rows, ["a", "b", "c"]).rows).toEqual([r("a"), r("b")]);
  });

  it("recovers missing drop indexes in older records by email", () => {
    const rows = [r("a"), r("b"), r("c")];
    const events: RunPlayEvent[] = [
      { kind: "verify", total: 3, verified: 2, dropped: [{ email: "b@x.dev", reason: "bad" }] },
      { kind: "send", index: 1, receiptIds: [42] },
    ];

    expect(remapFilteredEventIndexes(events, rows)[1]).toEqual({
      kind: "send",
      index: 2,
      receiptIds: [42],
    });
  });

  it("does not identity-map indexed events when a legacy drop cannot be resolved", () => {
    const events: RunPlayEvent[] = [
      {
        kind: "verify",
        total: 2,
        verified: 1,
        dropped: [{ email: "unknown@x.dev", reason: "bad" }],
      },
      { kind: "send", index: 0, receiptIds: [42] },
    ];

    expect(remapFilteredEventIndexes(events, [r("a"), r("b")])).toEqual([events[0]]);
  });
});
