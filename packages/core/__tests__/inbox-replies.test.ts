import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-inbox-replies-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function record(over: Partial<Parameters<Ledger["recordInboxReply"]>[0]> = {}): boolean {
  return ledger.recordInboxReply({
    id: "msg-1",
    threadKey: "thread-1",
    prospectId: 1,
    playName: "stack-consolidation",
    fromEmail: "Jane@Prospect.example",
    subject: "Re: stack thing",
    body: "It's sdk maintenance",
    receivedAt: "2026-08-25T22:00:00.000Z",
    sourceIdentityId: "gmail:me@corp.example",
    threadId: "thread-1",
    messageId: "<abc@mail.example>",
    ...over,
  });
}

describe("inbox_replies (v21)", () => {
  it("stores a reply and is idempotent on the provider id", () => {
    expect(record()).toBe(true);
    // Re-sweep sees the same mail — must be a no-op, not a duplicate row.
    expect(record({ body: "different body, same id" })).toBe(false);
    const rows = ledger.listInboxRepliesForProspect(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("It's sdk maintenance");
    // Sender address stored canonical, like every other prospect-email column.
    expect(rows[0]!.from_email).toBe("jane@prospect.example");
  });

  it("keeps every reply on a thread, not just the first", () => {
    record();
    record({ id: "msg-2", body: "second reply", receivedAt: "2026-08-26T09:00:00.000Z" });
    const rows = ledger.listInboxRepliesForProspect(1);
    expect(rows.map((r) => r.body)).toEqual(["It's sdk maintenance", "second reply"]);
  });

  it("lists prospects with replies, most recent activity first", () => {
    record();
    record({ id: "msg-9", prospectId: 2, receivedAt: "2026-08-26T12:00:00.000Z" });
    expect(ledger.listProspectIdsWithReplies()).toEqual([2, 1]);
  });

  it("listSequenceEventsForProspect returns sent steps across plays, oldest first", () => {
    ledger.recordSequenceEvent({
      prospectId: 1,
      playName: "stack-consolidation",
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "stack thing", body: "hey" },
    });
    ledger.recordSequenceEvent({
      prospectId: 1,
      playName: "luma-events",
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "event", body: "yo" },
    });
    const events = ledger.listSequenceEventsForProspect(1);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.play_name))).toEqual(
      new Set(["stack-consolidation", "luma-events"]),
    );
  });
});
