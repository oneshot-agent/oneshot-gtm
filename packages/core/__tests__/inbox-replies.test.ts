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

describe("inbox_replies.kind (v23)", () => {
  it("stores the classification and reads it back", () => {
    record({ kind: "auto" });
    expect(ledger.listInboxRepliesForProspect(1)[0]!.kind).toBe("auto");
  });

  it("defaults to NULL (pre-classifier rows read as human via coalesce)", () => {
    record();
    expect(ledger.listInboxRepliesForProspect(1)[0]!.kind).toBeNull();
  });

  it("migrates the column onto a pre-v23 ledger without losing rows", () => {
    // Simulate a pre-v23 install: rebuild inbox_replies without `kind`, insert
    // a legacy row, then re-run migrations by reopening the ledger.
    const db = (ledger as unknown as { db: { exec(s: string): void } }).db;
    db.exec("DROP TABLE inbox_replies");
    db.exec(`
      CREATE TABLE inbox_replies (
        id                 TEXT PRIMARY KEY,
        thread_key         TEXT NOT NULL,
        prospect_id        INTEGER NOT NULL,
        play_name          TEXT,
        from_email         TEXT NOT NULL,
        subject            TEXT,
        body               TEXT NOT NULL,
        received_at        TEXT NOT NULL,
        source_identity_id TEXT,
        thread_id          TEXT,
        message_id         TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    db.exec(`
      INSERT INTO inbox_replies (id, thread_key, prospect_id, from_email, body, received_at)
      VALUES ('legacy-1', 't1', 7, 'old@prospect.example', 'hi', '2026-06-01T00:00:00.000Z')`);
    ledger.close();

    ledger = new Ledger(dbPath); // migrate() adds the column
    const rows = ledger.listInboxRepliesForProspect(7);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBeNull();
    // And new writes can set it.
    record({ id: "msg-new", kind: "unsubscribe" });
    expect(ledger.listInboxRepliesForProspect(1)[0]!.kind).toBe("unsubscribe");
  });
});

describe("contactSuppressionFor", () => {
  it("returns the newest unsubscribe / dead-mailbox verdict for an address", () => {
    record({ kind: "auto" }); // temporary OOO never suppresses
    expect(ledger.contactSuppressionFor("jane@prospect.example")).toBeNull();

    record({ id: "msg-2", kind: "unsubscribe", receivedAt: "2026-08-26T10:00:00.000Z" });
    const hit = ledger.contactSuppressionFor("Jane@Prospect.example"); // canonicalized lookup
    expect(hit).toMatchObject({ kind: "unsubscribe", received_at: "2026-08-26T10:00:00.000Z" });
  });

  it("treats a dead-mailbox autoresponder as a do-not-send", () => {
    record({ kind: "auto_permanent" });
    expect(ledger.contactSuppressionFor("jane@prospect.example")?.kind).toBe("auto_permanent");
  });

  it("human replies never suppress", () => {
    record({ kind: "human" });
    record({ id: "msg-2" }); // NULL kind (legacy) — also human
    expect(ledger.contactSuppressionFor("jane@prospect.example")).toBeNull();
  });
});

describe("inbox_replies.intent (issue #480)", () => {
  it("defaults to NULL and can be set independently of kind", () => {
    record({ kind: "human" });
    expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBeNull();
    ledger.setInboxReplyIntent("msg-1", "interested", "asked about pricing tiers");
    const row = ledger.listInboxRepliesForProspect(1)[0]!;
    expect(row.intent).toBe("interested");
    expect(row.intent_reason).toBe("asked about pricing tiers");
    // kind is untouched by the intent write — the two classifiers are independent.
    expect(row.kind).toBe("human");
  });

  it("a bare 'not interested' stays kind: human AND classifies as a decline", () => {
    // classifyReply (reply-classify.ts) keeps a soft no as `human` — only an
    // explicit removal request promotes to `unsubscribe`. The intent
    // classifier is the layer that tells declines apart from interest.
    record({ kind: "human", body: "Thanks, but not interested right now." });
    ledger.setInboxReplyIntent("msg-1", "not_now", "declined, no explicit removal request");
    const row = ledger.listInboxRepliesForProspect(1)[0]!;
    expect(row.kind).toBe("human");
    expect(row.intent).toBe("not_now");
  });

  it("listInboxReplyIntents bulk-reads by id and is empty-safe", () => {
    expect(ledger.listInboxReplyIntents([])).toEqual(new Map());
    record({ kind: "human" });
    record({ id: "msg-2", kind: "human" });
    ledger.setInboxReplyIntent("msg-1", "interested", "r1");
    const out = ledger.listInboxReplyIntents(["msg-1", "msg-2", "msg-nonexistent"]);
    expect(out.get("msg-1")).toEqual({ intent: "interested", intentReason: "r1" });
    expect(out.get("msg-2")).toEqual({ intent: null, intentReason: null });
    expect(out.has("msg-nonexistent")).toBe(false);
  });

  it("a triage failure leaves intent NULL without losing the reply", () => {
    // Simulates the best-effort path in pollInboxReplies: recordInboxReply
    // always runs; setInboxReplyIntent is skipped entirely on a triage error.
    record({ kind: "human" });
    expect(ledger.listInboxRepliesForProspect(1)).toHaveLength(1);
    expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBeNull();
  });

  // Round-1 correction (#558): claimInboxReplyForTriage replaces a bare
  // re-check of `intent` with an atomic UPDATE ... WHERE intent IS NULL, so
  // two overlapping pollInboxReplies() calls (background scheduler tick +
  // manual `cadence advance`) racing the same freshly-inserted row can't both
  // trigger a paid triageEmails() call.
  it("claimInboxReplyForTriage: only one of two concurrent callers wins the claim", () => {
    record({ kind: "human" });
    expect(ledger.claimInboxReplyForTriage("msg-1")).toBe(true);
    // A second caller observing the same still-in-flight row must lose.
    expect(ledger.claimInboxReplyForTriage("msg-1")).toBe(false);
    // The pending marker is not a real category — never a valid ReplyIntent.
    expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBe("__triage_pending__");
  });

  it("claimInboxReplyForTriage: a failed triage releases the claim so a later poll can retry", () => {
    record({ kind: "human" });
    expect(ledger.claimInboxReplyForTriage("msg-1")).toBe(true);
    // Winner's triage call fails — it releases the claim back to NULL.
    ledger.setInboxReplyIntent("msg-1", null, null);
    expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBeNull();
    // A later poll can now claim and succeed.
    expect(ledger.claimInboxReplyForTriage("msg-1")).toBe(true);
    ledger.setInboxReplyIntent("msg-1", "interested", "r");
    expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBe("interested");
  });

  it("claimInboxReplyForTriage: never re-claims a row that already has a real classification", () => {
    record({ kind: "human" });
    ledger.setInboxReplyIntent("msg-1", "not_now", "declined");
    expect(ledger.claimInboxReplyForTriage("msg-1")).toBe(false);
    expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBe("not_now");
  });

  // Round-2 correction (#558, this round): every other claim-marker in
  // ledger.ts pairs its atomic claim with a sweepStale* recovery so a crash
  // between the claim and the release doesn't strand the marker forever.
  // claimInboxReplyForTriage had none — a process death mid-triage left
  // '__triage_pending__' on the row permanently (unclaimable, unclassified,
  // and visible to every intent reader). sweepStaleInboxReplyTriage is the
  // cold-boot recovery, called once from apps/server/src/bin.ts like the
  // other sweeps.
  describe("sweepStaleInboxReplyTriage", () => {
    it("resets a stranded __triage_pending__ claim back to NULL", () => {
      record({ kind: "human" });
      expect(ledger.claimInboxReplyForTriage("msg-1")).toBe(true);
      expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBe("__triage_pending__");
      // Simulate a crash: nobody calls setInboxReplyIntent to release it.
      expect(ledger.sweepStaleInboxReplyTriage()).toBe(1);
      expect(ledger.listInboxRepliesForProspect(1)[0]!.intent).toBeNull();
      // The row is claimable again after the sweep.
      expect(ledger.claimInboxReplyForTriage("msg-1")).toBe(true);
    });

    it("never touches rows with a real classification or no claim at all", () => {
      record({ kind: "human" });
      record({ id: "msg-2", kind: "human" });
      ledger.setInboxReplyIntent("msg-1", "interested", "r");
      // msg-2 is left with intent NULL (no claim in flight).
      expect(ledger.sweepStaleInboxReplyTriage()).toBe(0);
      const rows = ledger.listInboxRepliesForProspect(1);
      expect(rows.find((r) => r.id === "msg-1")!.intent).toBe("interested");
      expect(rows.find((r) => r.id === "msg-2")!.intent).toBeNull();
    });

    it("is a no-op on an empty table", () => {
      expect(ledger.sweepStaleInboxReplyTriage()).toBe(0);
    });
  });

  it("listUntriagedHumanReplies finds human replies with no intent yet, oldest first", () => {
    record({ id: "msg-1", kind: "human", receivedAt: "2026-08-20T00:00:00.000Z" });
    record({ id: "msg-2", kind: "human", receivedAt: "2026-08-25T00:00:00.000Z" });
    record({ id: "msg-3", kind: "auto" }); // never human — excluded
    ledger.setInboxReplyIntent("msg-2", "interested", "already triaged");

    const untriaged = ledger.listUntriagedHumanReplies();
    expect(untriaged.map((r) => r.id)).toEqual(["msg-1"]);
  });

  it("listUntriagedHumanReplies includes pre-v23 NULL-kind rows (they read as human)", () => {
    record({ id: "msg-legacy" }); // no kind arg → NULL
    expect(ledger.listUntriagedHumanReplies().map((r) => r.id)).toEqual(["msg-legacy"]);
  });
});
