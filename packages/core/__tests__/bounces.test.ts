import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import type { BounceKind } from "../src/types.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-bounce-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function record(over: Partial<Parameters<Ledger["recordBounce"]>[0]> = {}): boolean {
  return ledger.recordBounce({
    messageId: "dsn-1",
    recipient: "jane@dead.example",
    identityId: "gmail:me@corp.example",
    kind: "hard" as BounceKind,
    statusCode: "5.1.1",
    diagnostic: "smtp; 550 user unknown",
    prospectId: null,
    bouncedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  });
}

describe("recordBounce", () => {
  it("reports the first sighting as new and every re-sighting as not", () => {
    // The sweep re-reads a 30-day window on every scheduler tick, so the same
    // DSN comes back dozens of times. Only the first may act on the cadence.
    expect(record()).toBe(true);
    expect(record()).toBe(false);
    expect(record()).toBe(false);
    expect(ledger.listRecentBounces()).toHaveLength(1);
  });

  it("keeps one row per recipient when a single report names several", () => {
    expect(record({ recipient: "a@dead.example" })).toBe(true);
    expect(record({ recipient: "b@dead.example" })).toBe(true);
    expect(ledger.listRecentBounces()).toHaveLength(2);
  });

  it("canonicalizes the recipient so casing can't create a duplicate", () => {
    expect(record({ recipient: "Jane@Dead.Example" })).toBe(true);
    expect(record({ recipient: "jane@dead.example" })).toBe(false);
  });

  it("truncates an overlong diagnostic rather than storing the whole SMTP dump", () => {
    record({ diagnostic: "x".repeat(1000) });
    expect(ledger.listRecentBounces()[0]?.diagnostic).toHaveLength(300);
  });
});

describe("suppressionFor", () => {
  it("suppresses an address that hard-bounced", () => {
    record({ kind: "hard" });
    expect(ledger.suppressionFor("jane@dead.example")).toMatchObject({
      recipient: "jane@dead.example",
      status_code: "5.1.1",
    });
  });

  it("matches case-insensitively", () => {
    record({ kind: "hard" });
    expect(ledger.suppressionFor("  JANE@DEAD.EXAMPLE ")).not.toBeNull();
  });

  it("does NOT suppress on a policy block", () => {
    // A 5.7.x is the receiving server refusing a message, not evidence the
    // mailbox is dead — suppressing would permanently burn a live prospect
    // over one spam-filter verdict.
    record({ kind: "block", statusCode: "5.7.1" });
    expect(ledger.suppressionFor("jane@dead.example")).toBeNull();
  });

  it("does NOT suppress on a soft bounce", () => {
    record({ kind: "soft", statusCode: "4.2.2" });
    expect(ledger.suppressionFor("jane@dead.example")).toBeNull();
  });

  it("returns null for an address that has never bounced", () => {
    expect(ledger.suppressionFor("fine@corp.example")).toBeNull();
  });

  it("suppresses once a soft bounce is followed by a hard one", () => {
    record({ messageId: "dsn-soft", kind: "soft", statusCode: "4.2.2" });
    expect(ledger.suppressionFor("jane@dead.example")).toBeNull();
    record({ messageId: "dsn-hard", kind: "hard", statusCode: "5.1.1" });
    expect(ledger.suppressionFor("jane@dead.example")).not.toBeNull();
  });
});

describe("bounceStatsByIdentity", () => {
  it("counts each kind per identity", () => {
    record({ messageId: "a", recipient: "1@x.example", kind: "hard" });
    record({ messageId: "b", recipient: "2@x.example", kind: "hard" });
    record({ messageId: "c", recipient: "3@x.example", kind: "block" });
    record({ messageId: "d", recipient: "4@x.example", kind: "soft" });
    record({ messageId: "e", recipient: "5@x.example", kind: "hard", identityId: "gmail:other" });

    const stats = ledger.bounceStatsByIdentity({ sinceIso: "2026-01-01T00:00:00.000Z" });
    expect(stats.get("gmail:me@corp.example")).toEqual({ hard: 2, block: 1, soft: 1 });
    expect(stats.get("gmail:other")).toEqual({ hard: 1, block: 0, soft: 0 });
  });

  it("excludes bounces older than the window", () => {
    record({ messageId: "old", recipient: "1@x.example", bouncedAt: "2026-01-01T00:00:00.000Z" });
    record({ messageId: "new", recipient: "2@x.example", bouncedAt: "2026-08-01T00:00:00.000Z" });
    const stats = ledger.bounceStatsByIdentity({ sinceIso: "2026-07-01T00:00:00.000Z" });
    expect(stats.get("gmail:me@corp.example")).toEqual({ hard: 1, block: 0, soft: 0 });
  });

  it("skips rows with no identity attribution", () => {
    record({ identityId: null });
    expect(ledger.bounceStatsByIdentity({ sinceIso: "2026-01-01T00:00:00.000Z" }).size).toBe(0);
  });

  it("is empty before anything bounces", () => {
    expect(ledger.bounceStatsByIdentity({ sinceIso: "2026-01-01T00:00:00.000Z" }).size).toBe(0);
  });
});

describe("bounced cadence status", () => {
  it("clears the draft and send-failure markers like other terminal states", () => {
    const prospectId = ledger.upsertProspect({
      name: "J",
      email: "jane@dead.example",
      source: "t",
    });
    ledger.enrollCadence({ prospectId, playName: "p", nextDueAt: "2026-08-01T00:00:00.000Z" });
    ledger.setCadenceDraft({
      prospectId,
      playName: "p",
      draft: { subject: "s", body: "b", flags: [], payload: null },
    });
    ledger.recordCadenceSendError({ prospectId, playName: "p", error: "boom" });

    ledger.setCadenceStatus({ prospectId, playName: "p", status: "bounced" });

    const cad = ledger.getCadence(prospectId, "p");
    expect(cad?.status).toBe("bounced");
    // A stale "send failed · retrying" marker on a dead address is actively
    // misleading — no retry can ever succeed.
    expect(cad?.last_send_error).toBeNull();
    expect(ledger.getCadenceDraft({ prospectId, playName: "p" })).toBeNull();
  });
});

describe("countBounces", () => {
  it("counts distinct bounce events (not per-cadence sequence_events rows) in a window", () => {
    record({ messageId: "a", recipient: "1@x.example", bouncedAt: "2026-08-28T09:00:00.000Z" });
    record({ messageId: "b", recipient: "2@x.example", bouncedAt: "2026-08-28T10:00:00.000Z" });
    // Outside the window.
    record({ messageId: "c", recipient: "3@x.example", bouncedAt: "2026-08-27T10:00:00.000Z" });

    const n = ledger.countBounces({
      sinceIso: "2026-08-28T00:00:00.000Z",
      untilIso: "2026-08-29T00:00:00.000Z",
    });
    expect(n).toBe(2);
  });

  it("counts every kind, including soft (no cadence stop) and unmatched (no prospect)", () => {
    // pollInboxBounces `continue`s before writing any sequence_events row for
    // both of these — they must still show up here, since they still fire
    // notifySlackBounceRecorded.
    record({ messageId: "soft", recipient: "1@x.example", kind: "soft" });
    record({ messageId: "unmatched", recipient: "2@x.example", prospectId: null });
    expect(
      ledger.countBounces({
        sinceIso: "2026-01-01T00:00:00.000Z",
        untilIso: "2027-01-01T00:00:00.000Z",
      }),
    ).toBe(2);
  });

  it("returns 0 with no window bounds beyond an empty table", () => {
    expect(ledger.countBounces()).toBe(0);
    record();
    expect(ledger.countBounces()).toBe(1);
  });
});

describe("countAutoPermanentBounces", () => {
  // issue #71 round-1 correction: countAutoPermanentBounces now reads
  // `inbox_replies` (via recordInboxReply, kind='auto_permanent') instead of
  // `sequence_events` — a dead-mailbox reply for a prospect with no
  // active/paused cadence still gets persisted to inbox_replies and still
  // fires notifySlackBounceRecorded, but pollInboxReplies only writes
  // sequence_events inside its active/paused-cadence loop, so the old
  // sequence_events-based count silently dropped that case.
  it("counts a persisted auto_permanent reply even when the prospect has no active/paused cadence", () => {
    const prospectId = ledger.upsertProspect({
      name: "Gone",
      email: "gone@dead.example",
      source: "t",
    });
    ledger.recordInboxReply({
      id: "msg-1",
      threadKey: "msg-1",
      prospectId,
      fromEmail: "gone@dead.example",
      subject: "Out of office",
      body: "I no longer work here.",
      receivedAt: "2026-08-28T09:00:00.000Z",
      kind: "auto_permanent",
    });
    const n = ledger.countAutoPermanentBounces({
      sinceIso: "2026-08-28T00:00:00.000Z",
      untilIso: "2026-08-29T00:00:00.000Z",
    });
    expect(n).toBe(1);
  });

  it("counts one row per real event, regardless of how many concurrent cadences the prospect had", () => {
    // Even though pollInboxReplies loops every active/paused cadence to
    // write sequence_events (potentially several rows for one email),
    // recordInboxReply is INSERT OR IGNORE keyed on the provider's own
    // message id — exactly one inbox_replies row per real inbound email.
    const prospectId = ledger.upsertProspect({
      name: "Gone",
      email: "gone2@dead.example",
      source: "t",
    });
    for (const playName of ["play-a", "play-b"]) {
      ledger.recordSequenceEvent({
        prospectId,
        playName,
        stepIndex: 0,
        channel: "email",
        status: "bounced",
        metadata: { reason: "auto-reply-permanent" },
        bouncedAt: "2026-08-28T09:00:00.000Z",
      });
    }
    ledger.recordInboxReply({
      id: "msg-2",
      threadKey: "msg-2",
      prospectId,
      fromEmail: "gone2@dead.example",
      subject: "Out of office",
      body: "I no longer work here.",
      receivedAt: "2026-08-28T09:00:00.000Z",
      kind: "auto_permanent",
    });
    const n = ledger.countAutoPermanentBounces({
      sinceIso: "2026-08-28T00:00:00.000Z",
      untilIso: "2026-08-29T00:00:00.000Z",
    });
    expect(n).toBe(1);
  });

  it("excludes a human reply and other reply kinds", () => {
    const prospectId = ledger.upsertProspect({
      name: "Human",
      email: "human@example.com",
      source: "t",
    });
    ledger.recordInboxReply({
      id: "msg-3",
      threadKey: "msg-3",
      prospectId,
      fromEmail: "human@example.com",
      subject: "re: stack",
      body: "Sure, let's talk.",
      receivedAt: "2026-08-28T09:00:00.000Z",
      kind: "human",
    });
    ledger.recordInboxReply({
      id: "msg-4",
      threadKey: "msg-4",
      prospectId,
      fromEmail: "human@example.com",
      subject: "OOO",
      body: "Back Monday.",
      receivedAt: "2026-08-28T09:05:00.000Z",
      kind: "auto",
    });
    expect(
      ledger.countAutoPermanentBounces({
        sinceIso: "2026-08-28T00:00:00.000Z",
        untilIso: "2026-08-29T00:00:00.000Z",
      }),
    ).toBe(0);
  });

  it("excludes rows outside the window", () => {
    const prospectId = ledger.upsertProspect({
      name: "NoTs",
      email: "nots@dead.example",
      source: "t",
    });
    ledger.recordInboxReply({
      id: "msg-5",
      threadKey: "msg-5",
      prospectId,
      fromEmail: "nots@dead.example",
      subject: "Gone",
      body: "No longer at this company.",
      receivedAt: "2026-01-01T00:00:00.000Z", // Outside the window below.
      kind: "auto_permanent",
    });
    expect(
      ledger.countAutoPermanentBounces({
        sinceIso: "2026-08-28T00:00:00.000Z",
        untilIso: "2026-08-29T00:00:00.000Z",
      }),
    ).toBe(0);
  });
});
