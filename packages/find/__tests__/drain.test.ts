import { describe, expect, it } from "vitest";
import type { QueueRow } from "@oneshot-gtm/core";
import { idsForSentDrafts } from "../src/drain.ts";

function row(id: number): QueueRow {
  return {
    id,
    play_name: "show-hn",
    payload_json: "{}",
    dedupe_key: `k${id}`,
    source: "test",
    status: "approved",
    found_at: "now",
    reviewed_at: null,
    sent_at: null,
    notes: null,
    prospect_id: null,
  };
}

describe("idsForSentDrafts", () => {
  it("maps positionally even when middle drafts didn't send (the bug)", () => {
    const rows = [row(10), row(20), row(30)];
    const drafted = [{ sent: true }, { sent: false }, { sent: true }];
    expect(idsForSentDrafts(drafted, rows, false)).toEqual([10, 30]);
  });

  it("returns every row's id in dry-run, even when sent=false", () => {
    const rows = [row(10), row(20), row(30)];
    const drafted = [{ sent: false }, { sent: false }, { sent: false }];
    expect(idsForSentDrafts(drafted, rows, true)).toEqual([10, 20, 30]);
  });

  it("returns nothing when no draft sent and not dry-run", () => {
    const rows = [row(10), row(20)];
    const drafted = [{ sent: false }, { sent: false }];
    expect(idsForSentDrafts(drafted, rows, false)).toEqual([]);
  });

  it("ignores rows without a matching draft (defensive)", () => {
    const rows = [row(10), row(20), row(30)];
    const drafted = [{ sent: true }, { sent: true }];
    expect(idsForSentDrafts(drafted, rows, false)).toEqual([10, 20]);
  });
});
