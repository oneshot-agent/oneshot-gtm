import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { Database } from "bun:sqlite";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-ledger-extra-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("recentIcpDecisions", () => {
  it("returns the newest reviewed labels and keeps sent rows as approvals", () => {
    // Human rejections happen post-enqueue via the /queue route (insert-time
    // rejections are always machine gates and are excluded structurally
    // since v26 — decision='auto_reject').
    const rejected = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Wine meetup" },
      dedupeKey: "reject",
      source: "test",
    });
    ledger.setQueueStatus({
      id: rejected!,
      status: "rejected",
      notes: "wrong industry",
      decidedBy: "human",
    });
    const approved = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {
        title: "Agent builders",
        url: "https://example.com/agent-builders",
        email: "private@example.com",
        phone: "+43 555 0100",
        linkedinUrl: "https://linkedin.com/in/private",
        nested: { email: "also-private@example.com" },
      },
      dedupeKey: "approve",
      source: "test",
      notes: "right topic",
    });
    ledger.setQueueStatus({ id: approved!, status: "approved" });
    const sent = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Agent SDK" },
      dedupeKey: "sent",
      source: "test",
    });
    ledger.setQueueStatus({
      id: sent!,
      status: "sent",
      notes: "founder approved",
      decidedBy: "human",
    });
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Not reviewed" },
      dedupeKey: "pending",
      source: "test",
    });

    expect(ledger.recentIcpDecisions(2)).toEqual([
      { candidate: { title: "Agent SDK" }, decision: true, reason: "founder approved" },
      {
        candidate: {
          title: "Agent builders",
          url: "https://example.com/agent-builders",
        },
        decision: true,
        reason: "right topic",
      },
    ]);
    expect(ledger.recentIcpDecisions()).toContainEqual({
      candidate: { title: "Wine meetup" },
      decision: false,
      reason: "wrong industry",
    });
    expect(rejected).not.toBeNull();
  });
});

describe("listReceipts filters", () => {
  it("filters by playName", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "job-change", callType: "enrich.profile", costUsd: 0.2 });
    ledger.recordReceipt({ playName: "show-hn", callType: "email.find", costUsd: 0.05 });

    const only = ledger.listReceipts({ playName: "show-hn" });
    expect(only).toHaveLength(2);
    expect(only.every((r) => r.play_name === "show-hn")).toBe(true);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 5; i++) {
      ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    }
    expect(ledger.listReceipts({ limit: 2 })).toHaveLength(2);
  });

  it("sinceIso excludes older receipts", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    // future cutoff → no receipts qualify
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(ledger.listReceipts({ sinceIso: future })).toHaveLength(0);
  });
});

describe("finderApprovalStats", () => {
  it("counts reviewed source variants and treats sent as approved", () => {
    const add = (key: string, source: string): number =>
      ledger.enqueueTarget({ playName: "github-stars", payload: {}, dedupeKey: key, source })!;
    const approved = add("a", "find:github-stars:owner/repo");
    const sent = add("b", "find:github-stars:other/repo");
    const rejected = add("c", "find:github-stars");
    add("pending", "find:github-stars");
    ledger.setQueueStatus({ id: approved, status: "approved" });
    ledger.setQueueStatus({ id: sent, status: "sent", decidedBy: "human" });
    ledger.setQueueStatus({ id: rejected, status: "rejected", decidedBy: "human" });

    expect(ledger.finderApprovalStats({ finder: "github-stars", sinceIso: "2000-01-01" })).toEqual({
      approved: 2,
      reviewed: 3,
      rate: 2 / 3,
    });
  });
});

describe("recordReceipt — cost handling", () => {
  // Post-SDK-0.15.2 + post-wrapper-cleanup: every wrapper in core/oneshot.ts
  // forwards `result.cost` as explicit costUsd. recordReceipt no longer
  // re-reads cost from the signedReceipt JSON (one source of truth).
  // Anything not a finite number → NULL in the column.

  it("persists an explicit numeric costUsd", () => {
    const id = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      costUsd: 0.0123,
    });
    expect(ledger.getReceipt(id)?.cost_usd).toBeCloseTo(0.0123);
  });

  it("ignores any `cost` field on signedReceipt — only explicit costUsd counts", () => {
    // Verifies the cleanup: the JSON-extract fallback path is gone.
    const id = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      signedReceipt: { cost: 0.05 },
      // no explicit costUsd
    });
    expect(ledger.getReceipt(id)?.cost_usd).toBeNull();
  });

  it("leaves cost_usd NULL when costUsd is omitted entirely", () => {
    const id = ledger.recordReceipt({ playName: "p", callType: "web.search" });
    expect(ledger.getReceipt(id)?.cost_usd).toBeNull();
  });

  it("rejects non-finite costUsd (Infinity / NaN) as NULL", () => {
    // Number.isFinite guard — undefined / Infinity / NaN never get coerced
    // into a number that distorts CAC math.
    const id1 = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      costUsd: Infinity,
    });
    const id2 = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      costUsd: Number.NaN,
    });
    expect(ledger.getReceipt(id1)?.cost_usd).toBeNull();
    expect(ledger.getReceipt(id2)?.cost_usd).toBeNull();
  });

  it("persists signedReceipt JSON for forensic queries even when costUsd is null", () => {
    const id = ledger.recordReceipt({
      playName: "p",
      callType: "web.search",
      signedReceipt: { found: true, email: "x@y.dev" },
    });
    const row = ledger.getReceipt(id);
    expect(row?.cost_usd).toBeNull();
    expect(row?.signed_receipt).toContain('"email":"x@y.dev"');
  });
});

describe("totalSpendUsd", () => {
  it("sums explicit cost_usd values; NULL rows are excluded", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.25 });
    // No explicit cost AND no signedReceipt → NULL → excluded from the sum.
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send" });
    expect(ledger.totalSpendUsd()).toBeCloseTo(0.35);
  });

  it("filters by playName", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    ledger.recordReceipt({ playName: "job-change", callType: "email.send", costUsd: 0.9 });
    expect(ledger.totalSpendUsd({ playName: "show-hn" })).toBeCloseTo(0.1);
  });

  it("returns 0 when no receipts exist", () => {
    expect(ledger.totalSpendUsd()).toBe(0);
  });
});

describe("countSends", () => {
  it("counts sent/delivered/replied, skips bounced/failed/queued", () => {
    const pid = ledger.upsertProspect({ name: "A", email: "a@x.com", source: "t" });
    for (const status of ["sent", "delivered", "replied", "bounced", "queued", "failed"] as const) {
      ledger.recordSequenceEvent({
        prospectId: pid,
        playName: "show-hn",
        stepIndex: 0,
        channel: "email",
        status,
      });
    }
    expect(ledger.countSends()).toBe(3);
    expect(ledger.countSends({ playName: "show-hn" })).toBe(3);
    expect(ledger.countSends({ playName: "other" })).toBe(0);
  });
});

describe("prospectHasFirstTouch (cross-play first-touch guard)", () => {
  it("false with no events; true once a step-0 send/replied exists; ignores step-1 and non-sent status", () => {
    const pid = ledger.upsertProspect({ name: "P", email: "p@x.com", source: "t" });
    expect(ledger.prospectHasFirstTouch(pid)).toBe(false);

    // step-1 only (a follow-up with no recorded original) — still false.
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "stack-consolidation",
      stepIndex: 1,
      channel: "email",
      status: "sent",
    });
    expect(ledger.prospectHasFirstTouch(pid)).toBe(false);

    // step-0 but bounced — status filter excludes it.
    const bounced = ledger.upsertProspect({ name: "B", email: "b@x.com", source: "t" });
    ledger.recordSequenceEvent({
      prospectId: bounced,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "bounced",
    });
    expect(ledger.prospectHasFirstTouch(bounced)).toBe(false);

    // step-0 sent under ANY play — now true (cross-play: different play name).
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "replied",
    });
    expect(ledger.prospectHasFirstTouch(pid)).toBe(true);
  });
});

describe("isEmailPendingInQueue (cross-play pending dedup)", () => {
  it("matches pending/approved rows by email or founderEmail; ignores terminal rows + non-matches", () => {
    const pendingId = ledger.enqueueTarget({
      playName: "repo-interest",
      payload: { email: "Dup@X.com" }, // mixed case in payload
      dedupeKey: "a",
      source: "x",
    });
    expect(ledger.isEmailPendingInQueue("dup@x.com")).toBe(true); // case-insensitive match
    expect(ledger.isEmailPendingInQueue("  DUP@x.COM  ")).toBe(true); // trimmed + lowercased

    // founderEmail field (show-hn-style recipient), set to approved.
    const approvedId = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { founderEmail: "founder@x.com" },
      dedupeKey: "b",
      source: "x",
    });
    ledger.setQueueStatus({ id: approvedId!, status: "approved" });
    expect(ledger.isEmailPendingInQueue("founder@x.com")).toBe(true);

    // non-matching address.
    expect(ledger.isEmailPendingInQueue("nobody@x.com")).toBe(false);

    // terminal rows don't block future work.
    ledger.setQueueStatus({ id: pendingId!, status: "rejected" });
    expect(ledger.isEmailPendingInQueue("dup@x.com")).toBe(false);
  });
});

describe("removePendingQueueTarget", () => {
  it("removes only unreviewed reservations", () => {
    const pendingId = ledger.enqueueTarget({
      playName: "profile-intro",
      payload: {},
      dedupeKey: "pending",
      source: "test",
    })!;
    const approvedId = ledger.enqueueTarget({
      playName: "profile-intro",
      payload: {},
      dedupeKey: "approved",
      source: "test",
    })!;
    ledger.setQueueStatus({ id: approvedId, status: "approved" });

    expect(ledger.removePendingQueueTarget(pendingId)).toBe(true);
    expect(ledger.getQueueRow(pendingId)).toBeNull();
    expect(ledger.removePendingQueueTarget(approvedId)).toBe(false);
    expect(ledger.getQueueRow(approvedId)?.status).toBe("approved");
  });
});

describe("setQueueStatus pending", () => {
  it("restores an unreviewed row and applies notes", () => {
    const id = ledger.enqueueTarget({
      playName: "profile-intro",
      payload: {},
      dedupeKey: "restore-pending",
      source: "test",
      initialStatus: "expired",
      notes: "classification in progress",
    })!;

    expect(ledger.getQueueRow(id)?.reviewed_at).not.toBeNull();
    ledger.setQueueStatus({ id, status: "pending", notes: "ready for review" });

    expect(ledger.getQueueRow(id)).toMatchObject({
      status: "pending",
      reviewed_at: null,
      notes: "ready for review",
    });
  });
});

describe("approvedCountsByPlay", () => {
  it("counts approved rows per play and omits plays with none", () => {
    const enqueue = (playName: string, key: string, status?: "approved" | "sent"): void => {
      const id = ledger.enqueueTarget({ playName, payload: {}, dedupeKey: key, source: "x" });
      if (status) ledger.setQueueStatus({ id: id!, status });
    };
    enqueue("luma-events", "l1", "approved");
    enqueue("luma-events", "l2", "approved");
    enqueue("repo-interest", "r1", "approved");
    // Non-approved rows of an otherwise-approved play don't inflate the count…
    enqueue("repo-interest", "r2");
    enqueue("repo-interest", "r3", "sent");
    // …and a play with no approved row at all is absent, not zero.
    enqueue("show-hn", "s1");

    expect(ledger.approvedCountsByPlay()).toEqual({ "luma-events": 2, "repo-interest": 1 });
  });

  it("returns an empty map on an empty queue", () => {
    expect(ledger.approvedCountsByPlay()).toEqual({});
  });
});

describe("listQueue({ ids })", () => {
  it("returns only the requested rows, still honouring the other filters", () => {
    const a = ledger.enqueueTarget({
      playName: "luma-events",
      payload: {},
      dedupeKey: "a",
      source: "x",
    })!;
    const b = ledger.enqueueTarget({
      playName: "luma-events",
      payload: {},
      dedupeKey: "b",
      source: "x",
    })!;
    const c = ledger.enqueueTarget({
      playName: "luma-events",
      payload: {},
      dedupeKey: "c",
      source: "x",
    })!;
    for (const id of [a, b, c]) ledger.setQueueStatus({ id, status: "approved" });
    // A selected row that moved on since the founder ticked it must drop out.
    ledger.setQueueStatus({ id: c, status: "sent" });

    const got = ledger.listQueue({ ids: [a, b, c], status: "approved" });
    expect(got.map((r) => r.id).toSorted()).toEqual([a, b].toSorted());
  });

  it("returns nothing for an empty pick (never the whole table)", () => {
    ledger.enqueueTarget({ playName: "show-hn", payload: {}, dedupeKey: "z", source: "x" });
    expect(ledger.listQueue({ ids: [] })).toEqual([]);
    // Sanity: the same call without `ids` does list rows.
    expect(ledger.listQueue({}).length).toBe(1);
  });
});

describe("expirePendingOlderThan", () => {
  it("flips only pending rows older than the cutoff", () => {
    // Fresh pending row — should NOT be expired.
    const freshId = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "fresh",
      source: "x",
    });

    // Approved row — should NOT be expired regardless of age.
    const approvedId = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "approved",
      source: "x",
    });
    ledger.setQueueStatus({ id: approvedId!, status: "approved" });

    // 100-day-old pending row — should be expired. Backdate via raw sql.
    const oldId = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "old",
      source: "x",
    });
    const oldIso = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE target_queue SET found_at = ? WHERE id = ?")
      .run(oldIso, oldId);

    const n = ledger.expirePendingOlderThan(30);
    expect(n).toBe(1);
    expect(ledger.getQueueRow(freshId!)?.status).toBe("pending");
    expect(ledger.getQueueRow(approvedId!)?.status).toBe("approved");
    expect(ledger.getQueueRow(oldId!)?.status).toBe("expired");
  });
});

describe("dequeueApproved atomic lease", () => {
  function enqueueApproved(dedupe: string): number {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: dedupe,
      source: "x",
    });
    ledger.setQueueStatus({ id: id!, status: "approved" });
    return id!;
  }

  it("marks claimed rows with drain_claimed_at", () => {
    const id = enqueueApproved("a");
    const rows = ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    expect(rows.map((r) => r.id)).toEqual([id]);
    const fresh = ledger.getQueueRow(id) as { drain_claimed_at: string | null } | null;
    expect(fresh?.drain_claimed_at).not.toBeNull();
  });

  it("two sequential calls return disjoint row sets (second sees first's lease)", () => {
    const idA = enqueueApproved("a");
    const idB = enqueueApproved("b");
    const idC = enqueueApproved("c");
    const first = ledger.dequeueApproved({ playName: "show-hn", limit: 2 });
    const second = ledger.dequeueApproved({ playName: "show-hn", limit: 5 });
    const firstIds = new Set(first.map((r) => r.id));
    const secondIds = new Set(second.map((r) => r.id));
    expect(firstIds.size).toBe(2);
    expect(secondIds.size).toBe(1);
    for (const id of firstIds) expect(secondIds.has(id)).toBe(false);
    expect([...firstIds, ...secondIds].toSorted((a, b) => a - b)).toEqual(
      [idA, idB, idC].toSorted((a, b) => a - b),
    );
  });

  it("an expired claim (lease elapsed) becomes re-claimable", () => {
    const id = enqueueApproved("a");
    ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    // Backdate the claim to 20 min ago — older than the 15 min default lease.
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE target_queue SET drain_claimed_at = ? WHERE id = ?")
      .run(stale, id);
    const second = ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    expect(second.map((r) => r.id)).toEqual([id]);
  });

  it("setQueueStatus({sent}) excludes the row even when drain_claimed_at is set", () => {
    const id = enqueueApproved("a");
    ledger.dequeueApproved({ playName: "show-hn", limit: 1 });
    ledger.setQueueStatus({ id, status: "sent" });
    const second = ledger.dequeueApproved({ playName: "show-hn", limit: 1, leaseSeconds: 0 });
    expect(second).toEqual([]);
  });
});

describe("cadence next-step draft round-trip", () => {
  it("set/get round-trip + advanceCadence clears it", () => {
    const pid = ledger.upsertProspect({ name: "P", email: "p@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "stack-consolidation",
      nextDueAt: new Date().toISOString(),
    });
    ledger.setCadenceDraft({
      prospectId: pid,
      playName: "stack-consolidation",
      draft: {
        subject: "follow-up",
        body: "the value angle",
        flags: [],
        payload: { kind: "email", subject: "follow-up", body: "the value angle" },
      },
    });
    const stored = ledger.getCadenceDraft({
      prospectId: pid,
      playName: "stack-consolidation",
    });
    expect(stored?.subject).toBe("follow-up");
    expect(stored?.body).toBe("the value angle");
    expect(stored?.flags).toEqual([]);
    expect(stored?.draftedAt).toBeTruthy();

    // advanceCadence atomically clears the draft (stale for the new step).
    ledger.advanceCadence({
      prospectId: pid,
      playName: "stack-consolidation",
      newStep: 1,
      nextDueAt: null,
    });
    const after = ledger.getCadenceDraft({
      prospectId: pid,
      playName: "stack-consolidation",
    });
    expect(after).toBeNull();
  });

  it("clearCadenceDraft is a no-op when no draft exists", () => {
    const pid = ledger.upsertProspect({ name: "P2", email: "p2@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    expect(() => ledger.clearCadenceDraft({ prospectId: pid, playName: "show-hn" })).not.toThrow();
  });

  it("setCadenceStatus to a non-active state clears the persisted draft", () => {
    const pid = ledger.upsertProspect({ name: "P3", email: "p3@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.setCadenceDraft({
      prospectId: pid,
      playName: "show-hn",
      draft: { subject: "s", body: "b", flags: [], payload: {} },
    });
    expect(ledger.getCadenceDraft({ prospectId: pid, playName: "show-hn" })).not.toBeNull();
    ledger.setCadenceStatus({
      prospectId: pid,
      playName: "show-hn",
      status: "replied",
    });
    expect(ledger.getCadenceDraft({ prospectId: pid, playName: "show-hn" })).toBeNull();
  });
});

describe("manual cadence stops", () => {
  it("stores the disposition, leaves sibling cadences active, and expires queued revives", () => {
    const pid = ledger.upsertProspect({ name: "Stop Me", email: "stop@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "repo-interest",
      nextDueAt: new Date().toISOString(),
    });
    const queueId = ledger.enqueueTarget({
      playName: "breakup-revive",
      payload: { email: "stop@x.com" },
      dedupeKey: `prospect:${pid}`,
      source: "test",
      initialStatus: "approved",
    })!;
    ledger.setQueueProspectId(queueId, pid);

    expect(
      ledger.stopCadence({
        prospectId: pid,
        playName: "show-hn",
        reason: "not_a_fit",
        note: "wrong role",
      }),
    ).toBe(true);

    const stopped = ledger.getCadence(pid, "show-hn")!;
    expect(stopped).toMatchObject({
      status: "stopped",
      stop_reason: "not_a_fit",
      stop_note: "wrong role",
      next_due_at: null,
    });
    expect(stopped.stopped_at).toBeTruthy();
    expect(ledger.getCadence(pid, "repo-interest")?.status).toBe("active");
    expect(ledger.getQueueRow(queueId)?.status).toBe("expired");
    expect(ledger.breakupReviveHoldFor("stop@x.com")?.reason).toBe("not_a_fit");

    // Generic enrollment cannot silently erase a deliberate stop disposition.
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(ledger.getCadence(pid, "show-hn")).toMatchObject({
      status: "stopped",
      stop_reason: "not_a_fit",
      stop_note: "wrong role",
    });
  });

  it("does not claim a stop while a cadence send is in flight", () => {
    const pid = ledger.upsertProspect({ name: "Sending", email: "sending@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    expect(
      ledger.claimCadenceSendingMarker({
        prospectId: pid,
        playName: "show-hn",
        startedAtIso: new Date().toISOString(),
      }),
    ).toBe(true);
    expect(ledger.stopCadence({ prospectId: pid, playName: "show-hn", reason: "bad_timing" })).toBe(
      false,
    );
    expect(ledger.getCadence(pid, "show-hn")?.status).toBe("active");
  });

  it("uses a revivable stop as the cold clock and permanently excludes blocking reasons", () => {
    const timing = ledger.upsertProspect({ name: "Later", email: "later@x.com", source: "t" });
    const blocked = ledger.upsertProspect({ name: "No Fit", email: "nofit@x.com", source: "t" });
    for (const [id, reason] of [
      [timing, "bad_timing"],
      [blocked, "do_not_contact"],
    ] as const) {
      ledger.recordSequenceEvent({
        prospectId: id,
        playName: "show-hn",
        stepIndex: 0,
        channel: "email",
        status: "sent",
      });
      ledger.enrollCadence({
        prospectId: id,
        playName: "show-hn",
        nextDueAt: new Date().toISOString(),
      });
      ledger.stopCadence({ prospectId: id, playName: "show-hn", reason });
    }
    const db = new Database(dbPath);
    db.exec(`UPDATE sequence_events SET created_at = datetime('now', '-75 days');`);

    // A fresh timing stop resets the clock even though the email itself is old.
    expect(
      ledger.listColdProspects({ minDaysSinceLastEvent: 60, maxDaysSinceLastEvent: 90 }),
    ).toEqual([]);
    db.exec(
      `UPDATE cadence_state SET stopped_at = datetime('now', '-75 days') WHERE prospect_id = ${timing};`,
    );
    db.close();

    expect(
      ledger
        .listColdProspects({ minDaysSinceLastEvent: 60, maxDaysSinceLastEvent: 90 })
        .map((p) => p.id),
    ).toEqual([timing]);
  });

  it("can revive from a stop timestamp when no sequence event exists", () => {
    const pid = ledger.upsertProspect({ name: "Stop Only", email: "stop-only@x.com", source: "t" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.stopCadence({ prospectId: pid, playName: "show-hn", reason: "other", note: "later" });
    const db = new Database(dbPath);
    db.exec(
      `UPDATE cadence_state SET stopped_at = datetime('now', '-75 days') WHERE prospect_id = ${pid};`,
    );
    db.close();

    expect(
      ledger
        .listColdProspects({ minDaysSinceLastEvent: 60, maxDaysSinceLastEvent: 90 })
        .map((p) => p.id),
    ).toEqual([pid]);
  });
});

describe("LinkedIn reply events", () => {
  it("matches normalized identities, stops every live cadence, and is idempotent", () => {
    const pid = ledger.upsertProspect({
      name: "Lin Reply",
      email: "Lin@Example.com",
      linkedin_url: "https://www.linkedin.com/in/Lin-Reply/?trk=profile",
      source: "test",
    });
    for (const playName of ["show-hn", "repo-interest"]) {
      ledger.enrollCadence({ prospectId: pid, playName, nextDueAt: new Date().toISOString() });
    }
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    const queueId = ledger.enqueueTarget({
      playName: "breakup-revive",
      payload: { email: "lin@example.com" },
      dedupeKey: `prospect:${pid}`,
      source: "test",
      initialStatus: "approved",
    })!;
    ledger.setQueueProspectId(queueId, pid);

    expect(
      ledger.resolveProspectForLinkedInReply({
        email: "lin@example.com",
        linkedinUrl: "http://linkedin.com/in/lin-reply",
      }),
    ).toEqual({ status: "matched", prospectId: pid });
    const first = ledger.recordLinkedInReply({
      prospectId: pid,
      source: "expandi",
      externalEventId: "reply-1",
      occurredAt: "2026-06-18T10:00:00.000Z",
    });
    expect(first).toMatchObject({ duplicate: false, cadencesStopped: 2, inFlightSends: 0 });
    expect(ledger.listCadencesForProspect(pid).map((c) => c.status)).toEqual([
      "replied",
      "replied",
    ]);
    expect(ledger.getCadence(pid, "show-hn")).toMatchObject({
      reply_channel: "linkedin",
      replied_at: "2026-06-18T10:00:00.000Z",
    });
    expect(ledger.listSequenceEventsForProspect(pid)[0]?.status).toBe("sent");
    expect(ledger.getQueueRow(queueId)?.status).toBe("expired");
    expect(
      ledger.recordLinkedInReply({
        prospectId: pid,
        source: "expandi",
        externalEventId: "reply-1",
        occurredAt: new Date().toISOString(),
      }),
    ).toMatchObject({ duplicate: true, cadencesStopped: 0 });
  });

  it("reports an already claimed send and leaves its marker for the worker", () => {
    const pid = ledger.upsertProspect({ email: "race@example.com", source: "test" });
    ledger.enrollCadence({
      prospectId: pid,
      playName: "show-hn",
      nextDueAt: new Date().toISOString(),
    });
    ledger.claimCadenceSendingMarker({
      prospectId: pid,
      playName: "show-hn",
      startedAtIso: new Date().toISOString(),
    });
    const result = ledger.recordLinkedInReply({
      prospectId: pid,
      source: "manual",
      externalEventId: "race",
      occurredAt: new Date().toISOString(),
    });
    expect(result).toMatchObject({ cadencesStopped: 1, inFlightSends: 1 });
    expect(ledger.getCadence(pid, "show-hn")).toMatchObject({
      status: "replied",
      sending_started_at: expect.any(String),
    });
    expect(ledger.listActiveCadences()).toEqual([]);
  });

  it("rejects identifiers that resolve to different prospects", () => {
    ledger.upsertProspect({ email: "one@example.com", source: "test" });
    ledger.upsertProspect({
      email: "two@example.com",
      linkedin_url: "https://linkedin.com/in/two",
      source: "test",
    });
    expect(
      ledger.resolveProspectForLinkedInReply({
        email: "one@example.com",
        linkedinUrl: "https://www.linkedin.com/in/two/",
      }),
    ).toEqual({ status: "conflict" });
  });

  it("anchors breakup-revive to the LinkedIn reply time", () => {
    const pid = ledger.upsertProspect({ email: "cold-reply@example.com", source: "test" });
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "show-hn",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    ledger.recordLinkedInReply({
      prospectId: pid,
      source: "test",
      externalEventId: "cold-clock",
      occurredAt: new Date().toISOString(),
    });
    const db = new Database(dbPath);
    db.exec(`UPDATE sequence_events SET created_at = datetime('now', '-100 days');`);
    expect(
      ledger.listColdProspects({ minDaysSinceLastEvent: 60, maxDaysSinceLastEvent: 90 }),
    ).toEqual([]);
    db.exec(`UPDATE channel_events SET occurred_at = datetime('now', '-75 days');`);
    db.close();
    expect(
      ledger
        .listColdProspects({ minDaysSinceLastEvent: 60, maxDaysSinceLastEvent: 90 })
        .map((row) => row.id),
    ).toEqual([pid]);
  });
});

describe("recordInterview", () => {
  it("round-trips an interview record", () => {
    const id = ledger.recordInterview({
      person: "sam-acme.txt",
      transcript_path: "/tmp/sam-acme.txt",
      jtbd: "ship faster",
      pain_quotes_json: JSON.stringify(["we waste a day/week on ops"]),
    });
    expect(id).toBeGreaterThan(0);
  });
});

describe("countOutcomes filters", () => {
  it("filters by outcome + play", () => {
    const pid = ledger.upsertProspect({ name: "A", email: "a@x.com", source: "t" });
    ledger.recordOutcome({ prospectId: pid, playName: "show-hn", outcome: "meeting_booked" });
    ledger.recordOutcome({ prospectId: pid, playName: "show-hn", outcome: "deal_won" });
    ledger.recordOutcome({ prospectId: pid, playName: "job-change", outcome: "meeting_booked" });
    expect(ledger.countOutcomes()).toBe(3);
    expect(ledger.countOutcomes({ outcome: "meeting_booked" })).toBe(2);
    expect(ledger.countOutcomes({ playName: "show-hn" })).toBe(2);
    expect(ledger.countOutcomes({ playName: "show-hn", outcome: "deal_won" })).toBe(1);
  });
});

describe("spendByPlay with sinceIso", () => {
  it("excludes receipts older than the cutoff", () => {
    ledger.recordReceipt({ playName: "show-hn", callType: "email.send", costUsd: 0.1 });
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(ledger.spendByPlay({ sinceIso: future })).toEqual([]);
  });
});

describe("triggers listing", () => {
  it("listTriggers returns upserted rows sorted by name", () => {
    ledger.upsertTrigger({ name: "zeta", configJson: "{}" });
    ledger.upsertTrigger({ name: "alpha", configJson: "{}" });
    ledger.upsertTrigger({ name: "mu", configJson: "{}" });
    const names = ledger.listTriggers().map((t) => t.name);
    expect(names).toEqual(["alpha", "mu", "zeta"]);
  });

  it("upsertTrigger is idempotent: second call replaces config/enabled", () => {
    ledger.upsertTrigger({ name: "show-hn", configJson: JSON.stringify({ a: 1 }), enabled: true });
    ledger.upsertTrigger({ name: "show-hn", configJson: JSON.stringify({ a: 2 }), enabled: false });
    const t = ledger.getTrigger("show-hn");
    expect(t?.enabled).toBe(0);
    expect(JSON.parse(t!.config_json ?? "{}")).toEqual({ a: 2 });
  });
});

describe("addColumnIfMissing identifier guards", () => {
  it("rejects unsafe table names", () => {
    // The only way to reach this code path is the private method; we access it
    // via the instance to verify the guard is in place (defense-in-depth).
    const priv = ledger as unknown as {
      addColumnIfMissing(t: string, c: string, tp: string): void;
    };
    expect(() => priv.addColumnIfMissing("receipts; DROP TABLE receipts", "x", "TEXT")).toThrow(
      /unsafe identifier/,
    );
    expect(() => priv.addColumnIfMissing("receipts", "x; DROP TABLE y", "TEXT")).toThrow(
      /unsafe identifier/,
    );
    expect(() => priv.addColumnIfMissing("receipts", "x", "TEXT); DROP")).toThrow(
      /unsafe column type/,
    );
  });
});

describe("receipt annotation (memo / decisionContext / value_tag)", () => {
  it("recordReceipt persists explicit memo + decisionContext", () => {
    const id = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      memo: "show-hn step 0 → p@x.dev",
      decisionContext: { source: "play.initial", prospectEmail: "p@x.dev" },
    });
    const row = ledger.getReceipt(id);
    expect(row?.memo).toBe("show-hn step 0 → p@x.dev");
    expect(JSON.parse(row?.decision_context ?? "{}")).toEqual({
      source: "play.initial",
      prospectEmail: "p@x.dev",
    });
  });

  it("recordReceipt defaults memo + decisionContext to the call identity", () => {
    const id = ledger.recordReceipt({ playName: "job-change", callType: "enrich.profile" });
    const row = ledger.getReceipt(id);
    expect(row?.memo).toBe("job-change enrich.profile");
    expect(JSON.parse(row?.decision_context ?? "{}")).toEqual({
      playName: "job-change",
      callType: "enrich.profile",
    });
    expect(row?.value_tag).toBeNull();
  });

  it("setReceiptValueTag stamps value_tag + value_tagged_at", () => {
    const id = ledger.recordReceipt({ playName: "show-hn", callType: "email.send" });
    ledger.setReceiptValueTag(id, JSON.stringify({ type: "revenue", amount: 5000 }));
    const row = ledger.getReceipt(id);
    expect(JSON.parse(row?.value_tag ?? "{}")).toEqual({ type: "revenue", amount: 5000 });
    expect(row?.value_tagged_at).toBeTruthy();
  });

  it("recordReceipt mirrors decisionContext.goalId into the goal_id column", () => {
    const id = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      decisionContext: { goalId: "goal_abc", source: "cadence" },
    });
    expect(ledger.getReceipt(id)?.goal_id).toBe("goal_abc");
    // no goalId in context → null column
    const id2 = ledger.recordReceipt({ playName: "show-hn", callType: "email.find" });
    expect(ledger.getReceipt(id2)?.goal_id).toBeNull();
  });

  it("setReceiptValueTagByGoal stamps every receipt in the goal; currentGoalValueTag reads it", () => {
    const r1 = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      decisionContext: { goalId: "goal_x" },
    });
    const r2 = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      decisionContext: { goalId: "goal_x" },
    });
    // a receipt in a DIFFERENT goal must not be touched
    const other = ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      decisionContext: { goalId: "goal_y" },
    });

    expect(ledger.currentGoalValueTag("goal_x")).toBeNull();
    const n = ledger.setReceiptValueTagByGoal(
      "goal_x",
      JSON.stringify({ type: "revenue", amount: 5000 }),
    );
    expect(n).toBe(2);

    expect(JSON.parse(ledger.getReceipt(r1)?.value_tag ?? "{}")).toEqual({
      type: "revenue",
      amount: 5000,
    });
    expect(JSON.parse(ledger.getReceipt(r2)?.value_tag ?? "{}")).toEqual({
      type: "revenue",
      amount: 5000,
    });
    expect(ledger.getReceipt(r1)?.value_tagged_at).toBeTruthy();
    expect(ledger.getReceipt(other)?.value_tag).toBeNull();

    expect(JSON.parse(ledger.currentGoalValueTag("goal_x") ?? "{}")).toEqual({
      type: "revenue",
      amount: 5000,
    });
    expect(ledger.setReceiptValueTagByGoal("goal_absent", "{}")).toBe(0);
  });

  it("goalLabels maps goalIds to play + prospect from local receipts", () => {
    ledger.recordReceipt({
      playName: "show-hn",
      callType: "email.send",
      decisionContext: { goalId: "goal_1", prospectEmail: "a@x.dev" },
    });
    ledger.recordReceipt({
      playName: "concierge",
      callType: "voice.call",
      decisionContext: { goalId: "goal_2", customerName: "Pat" },
    });

    const labels = ledger.goalLabels(["goal_1", "goal_2", "goal_missing"]);
    expect(labels.get("goal_1")).toEqual({ playName: "show-hn", prospect: "a@x.dev" });
    expect(labels.get("goal_2")).toEqual({ playName: "concierge", prospect: "Pat" });
    expect(labels.has("goal_missing")).toBe(false);
    expect(ledger.goalLabels([]).size).toBe(0);
  });
});
