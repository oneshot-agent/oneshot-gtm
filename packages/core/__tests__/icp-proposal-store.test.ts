import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { normalizeIcpText } from "../src/icp-proposal-store.ts";

// Learning-loop v2 (issue #750): the store gates the model call behind a
// lease/cooldown, holds generated proposals, and guards the founder's
// decision path. These tests exercise the store directly (the same surface
// `icp-proposals.ts` and the API routes call through `ledger.icpProposals`).

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-icp-proposal-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

describe("IcpProposalStore.beginEvaluation lease/cooldown", () => {
  it("grants a lease when idle, then refuses a second concurrent lease", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000);
    expect(token).not.toBeNull();
    expect(ledger.icpProposals.beginEvaluation(1_500, 86_400_000, 300_000)).toBeNull();
  });

  it("refuses a new lease before the cooldown elapses, even after finishing", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    ledger.icpProposals.finish(token);
    // Cooldown is measured from attempted_ms, not from finish: a completed
    // evaluation still spends the daily window.
    expect(ledger.icpProposals.beginEvaluation(1_000 + 60_000, 86_400_000, 300_000)).toBeNull();
    expect(
      ledger.icpProposals.beginEvaluation(1_000 + 86_400_000, 86_400_000, 300_000),
    ).not.toBeNull();
  });

  it("a stale lease releases once its lease window elapses", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    expect(ledger.icpProposals.beginEvaluation(1_000 + 100_000, 86_400_000, 300_000)).toBeNull();
    // Past until_ms (1_000 + 300_000) but still inside the cooldown window
    // measured from attempted_ms: the crashed lease clears, but the cooldown
    // still applies to the next attempt.
    expect(ledger.icpProposals.beginEvaluation(1_000 + 300_001, 86_400_000, 300_000)).toBeNull();
    void token;
  });

  it("fail() clears the lease without spending the cooldown from a fresh baseline", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    ledger.icpProposals.fail(token, "boom");
    // Still governed by the cooldown measured from the original attempt.
    expect(ledger.icpProposals.beginEvaluation(1_000 + 1_000, 86_400_000, 300_000)).toBeNull();
    expect(
      ledger.icpProposals.beginEvaluation(1_000 + 86_400_000, 86_400_000, 300_000),
    ).not.toBeNull();
  });

  it("finish/fail with a stale token is a no-op against a lease someone else already won", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    expect(ledger.icpProposals.finish("not-the-token")).toBe(false);
    // The real lease is still held.
    expect(ledger.icpProposals.beginEvaluation(1_100, 86_400_000, 300_000)).toBeNull();
    expect(ledger.icpProposals.finish(token)).toBe(true);
  });
});

describe("IcpProposalStore proposal lifecycle", () => {
  const insertOne = (proposedIcp = "B2B fintech CTOs at Series A startups") =>
    ledger.icpProposals.insert({
      currentIcp: "B2B fintech founders",
      proposedIcp,
      evidenceSummary: "Recent approvals skew toward technical buyers.",
      createdAt: "2026-09-29T00:00:00.000Z",
    });

  it("insert + list round-trips a pending proposal", () => {
    const inserted = insertOne();
    expect(inserted.status).toBe("pending");
    const pending = ledger.icpProposals.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      currentIcp: "B2B fintech founders",
      proposedIcp: "B2B fintech CTOs at Series A startups",
      evidenceSummary: "Recent approvals skew toward technical buyers.",
    });
    expect(ledger.icpProposals.list("approved")).toEqual([]);
    expect(ledger.icpProposals.list()).toHaveLength(1);
  });

  it("hasPendingDuplicate matches on normalized text, not exact casing/punctuation", () => {
    insertOne("B2B fintech CTOs at Series A startups.");
    expect(ledger.icpProposals.hasPendingDuplicate("b2b fintech ctos at series a startups")).toBe(
      true,
    );
    expect(ledger.icpProposals.hasPendingDuplicate("Completely different audience")).toBe(false);
  });

  it("decide() flips pending -> approved/dismissed and rejects a second decision on the same row", () => {
    const inserted = insertOne();
    const decided = ledger.icpProposals.decide(inserted.id, "approved", "2026-09-29T01:00:00Z");
    expect("view" in decided).toBe(true);
    if ("view" in decided) {
      expect(decided.view.status).toBe("approved");
      expect(decided.view.decidedAt).toBe("2026-09-29T01:00:00Z");
    }
    const again = ledger.icpProposals.decide(inserted.id, "dismissed", "2026-09-29T02:00:00Z");
    expect("error" in again).toBe(true);
    if ("error" in again) expect(again.error).toContain("already approved");
  });

  it("decide() on an unknown id returns a named error", () => {
    const result = ledger.icpProposals.decide("nope", "approved", "2026-09-29T00:00:00Z");
    expect("error" in result).toBe(true);
  });

  it("revertToPending puts an approved row back to pending (config-write-failure compensation)", () => {
    const inserted = insertOne();
    ledger.icpProposals.decide(inserted.id, "approved", "2026-09-29T01:00:00Z");
    ledger.icpProposals.revertToPending(inserted.id);
    expect(ledger.icpProposals.get(inserted.id)).toMatchObject({
      status: "pending",
      decidedAt: null,
    });
  });

  it("wasJustDismissed is true only when the MOST RECENTLY DECIDED proposal, of any text, was a dismissal of this text", () => {
    const first = insertOne("Series A fintech CTOs");
    ledger.icpProposals.decide(first.id, "dismissed", "2026-09-29T01:00:00Z");
    expect(ledger.icpProposals.wasJustDismissed("Series A fintech CTOs")).toBe(true);
    expect(ledger.icpProposals.wasJustDismissed("Unrelated text")).toBe(false);

    // A later decision — on a DIFFERENT text — is now the most recent decided
    // row, so the ban on the original text lifts (it does not need to be
    // decided again to overtake the dismissal, and in practice can't be: the
    // generator's own duplicate-of-a-dismissal guard blocks re-proposing an
    // identical text while it's still banned).
    const second = insertOne("A completely different rewrite");
    ledger.icpProposals.decide(second.id, "approved", "2026-09-29T02:00:00Z");
    expect(ledger.icpProposals.wasJustDismissed("Series A fintech CTOs")).toBe(false);
  });

  it("dismissStalePending flips every pending row to dismissed, leaving already-decided rows untouched", () => {
    const a = insertOne("Rewrite A");
    const b = insertOne("Rewrite B");
    const c = insertOne("Rewrite C");
    ledger.icpProposals.decide(c.id, "approved", "2026-09-29T01:00:00Z");
    ledger.icpProposals.dismissStalePending("2026-09-29T02:00:00Z");
    expect(ledger.icpProposals.get(a.id)).toMatchObject({
      status: "dismissed",
      decidedAt: "2026-09-29T02:00:00Z",
    });
    expect(ledger.icpProposals.get(b.id)).toMatchObject({
      status: "dismissed",
      decidedAt: "2026-09-29T02:00:00Z",
    });
    // Already-decided row is untouched, not re-stamped.
    expect(ledger.icpProposals.get(c.id)).toMatchObject({
      status: "approved",
      decidedAt: "2026-09-29T01:00:00Z",
    });
  });
});

describe("IcpProposalStore only reaches icp rows", () => {
  it("decide / revertToPending / markApplied refuse a proposal of another kind", () => {
    const other = ledger.learning.insert({
      kind: "preference",
      scope: { channel: "email" },
      current: null,
      proposed: { instruction: "Be brief", source: "edits" },
      evidence: { refs: [] },
      evidenceSummary: "x",
      baselineKey: "",
      dedupeKey: "be brief",
    })!;
    expect(ledger.icpProposals.get(other.id)).toBeNull();
    const decided = ledger.icpProposals.decide(other.id, "dismissed", "2026-09-29T01:00:00Z");
    expect("error" in decided && decided.error).toContain("not found");
    ledger.icpProposals.markApplied(other.id, "2026-09-29T01:00:00Z");
    ledger.icpProposals.revertToPending(other.id);
    expect(ledger.learning.get(other.id)).toMatchObject({ status: "pending", appliedAt: null });
  });
});

describe("normalizeIcpText", () => {
  it("collapses case and punctuation differences to the same key", () => {
    expect(normalizeIcpText("B2B, Fintech CTOs!")).toBe(normalizeIcpText("b2b fintech ctos"));
  });
});

describe("Ledger.countHumanIcpDecisions / recentIcpDecisions", () => {
  it("counts only human-decided rows from ICP-eligible plays with valid JSON payloads", () => {
    // Human approval on an eligible play: counts.
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Ada raises Seed" },
      dedupeKey: "a",
      source: "find:show-hn",
    });
    ledger.setQueueStatus({ id: 1, status: "approved", decidedBy: "human" });

    // Machine-decided row on an eligible play: does not count.
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Bot post" },
      dedupeKey: "b",
      source: "find:show-hn",
    });
    ledger.setQueueStatus({ id: 2, status: "rejected", decidedBy: "machine" });

    // Human-decided row on a play NOT in the ICP example set: does not count.
    ledger.enqueueTarget({
      playName: "x-amplify-dm",
      payload: { title: "Some DM" },
      dedupeKey: "c",
      source: "find:x-amplify-dm",
    });
    ledger.setQueueStatus({ id: 3, status: "approved", decidedBy: "human" });

    expect(ledger.countHumanIcpDecisions()).toBe(1);
    expect(ledger.recentIcpDecisions(20)).toHaveLength(1);
  });

  it("reasoned evidence keeps only explicit fit judgments, never timing, draft or bulk decisions", () => {
    const seed = (dedupeKey: string, title: string) =>
      ledger.enqueueTarget({
        playName: "show-hn",
        payload: { title },
        dedupeKey,
        source: "find:show-hn",
      })!;
    const fit = seed("a", "Ada raises Seed");
    ledger.setQueueStatus({
      id: fit,
      status: "approved",
      decidedBy: "human",
      decisionReason: "fit",
    });
    const audience = seed("b", "Consumer app");
    ledger.setQueueStatus({
      id: audience,
      status: "rejected",
      decidedBy: "human",
      decisionReason: "wrong_audience",
    });
    const timing = seed("c", "Good fit, bad week");
    ledger.setQueueStatus({
      id: timing,
      status: "rejected",
      decidedBy: "human",
      decisionReason: "bad_timing",
    });
    const plain = seed("d", "No reason given");
    ledger.setQueueStatus({ id: plain, status: "approved", decidedBy: "human" });
    seed("e", "Bulk");
    ledger.approveAllPending();
    expect(ledger.countHumanIcpDecisions()).toBe(5);
    expect(ledger.countHumanIcpDecisions({ reasoned: true })).toBe(2);
    const reasoned = ledger.recentIcpDecisions(20, { reasoned: true });
    expect(reasoned.map((e) => [e.decision, e.decisionReason])).toEqual([
      [false, "wrong_audience"],
      [true, "fit"],
    ]);
    expect(
      ledger.recentIcpDecisions(20).find((e) => e.decisionReason === "bad_timing"),
    ).toBeTruthy();
    // A later human decision without a reason clears the stale one.
    ledger.setQueueStatus({ id: fit, status: "rejected", decidedBy: "human" });
    expect(ledger.countHumanIcpDecisions({ reasoned: true })).toBe(1);
    // Machine decisions never write a reason.
    ledger.setQueueStatus({
      id: timing,
      status: "rejected",
      decidedBy: "machine",
      decisionReason: "fit",
    });
    expect(ledger.countHumanIcpDecisions({ reasoned: true })).toBe(1);
  });

  it("qualifiedOutcomeExamples returns meeting/SQL/won outcomes with the review context, never lost or ghosted", () => {
    const pid = ledger.upsertProspect({ email: "ada@example.com", name: "Ada", company: "Ada Co" });
    const q = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Ada ships agents", email: "ada@example.com" },
      dedupeKey: "ada",
      source: "find:show-hn",
    })!;
    (ledger as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      `UPDATE target_queue SET prospect_id = ${pid} WHERE id = ${q}`,
    );
    ledger.recordOutcome({ prospectId: pid, playName: "show-hn", outcome: "meeting_booked" });
    ledger.recordOutcome({ prospectId: pid, playName: "show-hn", outcome: "deal_lost" });
    const orphan = ledger.upsertProspect({
      email: "no-row@example.com",
      name: "Nobody",
      company: null,
    });
    ledger.recordOutcome({ prospectId: orphan, outcome: "deal_won" });
    const examples = ledger.qualifiedOutcomeExamples(20);
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({
      outcome: "meeting_booked",
      candidate: { title: "Ada ships agents" },
    });
  });

  it("counts stay in sync with recentIcpDecisions as more human decisions accrue", () => {
    for (let i = 0; i < 5; i++) {
      ledger.enqueueTarget({
        playName: "post-funding",
        payload: { title: `Round ${i}` },
        dedupeKey: `k${i}`,
        source: "find:post-funding",
      });
      ledger.setQueueStatus({ id: i + 1, status: "approved", decidedBy: "human" });
    }
    expect(ledger.countHumanIcpDecisions()).toBe(5);
    expect(ledger.recentIcpDecisions(3)).toHaveLength(3);
    expect(ledger.recentIcpDecisions(20)).toHaveLength(5);
  });
});
