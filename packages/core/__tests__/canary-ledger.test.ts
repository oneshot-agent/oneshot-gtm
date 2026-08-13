import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-canary-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function canary(over: Partial<Parameters<Ledger["recordCanaryResult"]>[0]> = {}): number {
  return ledger.recordCanaryResult({
    fromIdentity: "gmail:a@one.example",
    toIdentity: "gmail:b@two.example",
    placement: "inbox",
    labelIds: ["INBOX", "CATEGORY_PERSONAL"],
    auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    subject: "quick question",
    sourcePlay: "post-funding",
    sameDomain: false,
    latencyMs: 4200,
    ...over,
  });
}

describe("canary results", () => {
  it("returns null before any test has run", () => {
    expect(ledger.latestCanaryResult()).toBeNull();
  });

  it("round-trips a result", () => {
    canary();
    expect(ledger.latestCanaryResult()).toMatchObject({
      from_identity: "gmail:a@one.example",
      to_identity: "gmail:b@two.example",
      placement: "inbox",
      spf: "pass",
      source_play: "post-funding",
      same_domain: 0,
      latency_ms: 4200,
    });
  });

  it("keeps history and returns the newest", () => {
    // Append-only so a reputation trend stays visible, not just the last verdict.
    canary({ placement: "inbox" });
    canary({ placement: "spam" });
    expect(ledger.latestCanaryResult()?.placement).toBe("spam");
  });

  it("preserves the raw labels so a placement call can be re-litigated", () => {
    canary({ labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], placement: "promotions" });
    const labels = JSON.parse(ledger.latestCanaryResult()?.labels_json ?? "[]") as string[];
    expect(labels).toContain("CATEGORY_PROMOTIONS");
  });

  it("stores the same-domain flag", () => {
    canary({ sameDomain: true });
    expect(ledger.latestCanaryResult()?.same_domain).toBe(1);
  });

  it("stores a never-arrived result with a null latency", () => {
    canary({ placement: "not_delivered", latencyMs: null, labelIds: [] });
    expect(ledger.latestCanaryResult()).toMatchObject({
      placement: "not_delivered",
      latency_ms: null,
    });
  });
});

describe("latestSentEmailCopy", () => {
  function seedSent(playName: string, meta: unknown): void {
    const prospectId = ledger.upsertProspect({
      name: "P",
      email: `${Math.random().toString(36).slice(2)}@x.example`,
      source: "t",
    });
    ledger.recordSequenceEvent({
      prospectId,
      playName,
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: meta,
    });
  }

  it("returns null with no send history", () => {
    expect(ledger.latestSentEmailCopy()).toBeNull();
  });

  it("returns the most recent sent email's real subject and body", () => {
    seedSent("post-funding", { subject: "your Series A", body: "Hey — saw the round." });
    expect(ledger.latestSentEmailCopy()).toEqual({
      subject: "your Series A",
      body: "Hey — saw the round.",
      playName: "post-funding",
    });
  });

  it("can be scoped to one play", () => {
    seedSent("post-funding", { subject: "a", body: "a-body" });
    seedSent("hiring-signal", { subject: "b", body: "b-body" });
    expect(ledger.latestSentEmailCopy({ playName: "post-funding" })?.subject).toBe("a");
  });

  it("skips rows with no persisted body instead of giving up", () => {
    // Pre-v8 rows and non-email payloads carry no subject/body. Reading only
    // the newest row would return null whenever one of those happened to be on
    // top, and the canary would silently fall back to generic filler.
    seedSent("post-funding", { subject: "real", body: "real body" });
    seedSent("post-funding", { label: "no body here" });
    seedSent("post-funding", { subject: "also no body" });
    expect(ledger.latestSentEmailCopy()?.subject).toBe("real");
  });

  it("skips a row whose body is blank", () => {
    seedSent("post-funding", { subject: "real", body: "real body" });
    seedSent("post-funding", { subject: "empty", body: "   " });
    expect(ledger.latestSentEmailCopy()?.subject).toBe("real");
  });

  it("survives malformed metadata JSON", () => {
    seedSent("post-funding", { subject: "real", body: "real body" });
    // Written through a second connection: metadata_json is only ever produced
    // by JSON.stringify, so there's no ledger API that can create this row.
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status, metadata_json)
         VALUES(1, 'post-funding', 1, 'email', 'sent', '{not json')`,
      )
      .run();
    raw.close();
    expect(ledger.latestSentEmailCopy()?.subject).toBe("real");
  });

  it("includes copy whose step later flipped to replied", () => {
    // markLatestStepReplied UPDATEs a 'sent' row in place. Matching only
    // status='sent' would skip every prospect who answered — i.e. the
    // best-performing copy there is — and silently replay something older.
    const prospectId = ledger.upsertProspect({ name: "P", email: "r@x.example", source: "t" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "post-funding",
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "the winner", body: "copy that got a reply" },
    });
    ledger.markLatestStepReplied({ prospectId, playName: "post-funding" });

    expect(ledger.latestSentEmailCopy()?.subject).toBe("the winner");
  });

  it("includes copy whose step is marked delivered", () => {
    const prospectId = ledger.upsertProspect({ name: "P", email: "d@x.example", source: "t" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "post-funding",
      stepIndex: 0,
      channel: "email",
      status: "delivered",
      metadata: { subject: "delivered one", body: "body" },
    });
    expect(ledger.latestSentEmailCopy()?.subject).toBe("delivered one");
  });

  it("ignores non-email channels and unsent steps", () => {
    const prospectId = ledger.upsertProspect({ name: "P", email: "p@x.example", source: "t" });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "p",
      stepIndex: 0,
      channel: "sms",
      status: "sent",
      metadata: { subject: "sms", body: "sms body" },
    });
    ledger.recordSequenceEvent({
      prospectId,
      playName: "p",
      stepIndex: 1,
      channel: "email",
      status: "queued",
      metadata: { subject: "queued", body: "queued body" },
    });
    expect(ledger.latestSentEmailCopy()).toBeNull();
  });
});
